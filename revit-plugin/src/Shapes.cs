using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace ContoursToRevit
{
    /// <summary>
    /// Things drawn in the web app (Sketch blocks, parking paving, islands, sidewalks, planting beds, trees) as
    /// DirectShapes. The page sends groups: { role, category (BuiltInCategory name), phase, items: [{ id, name, v (flat
    /// x,y,z internal feet), f (index triangles/quads), mat (index into materials), comment, meta }] } plus
    /// materials: [{ name, rgb: [r,g,b], transparency (0-100) }]. Each role replaces what was sent before.
    /// </summary>
    internal static class Shapes
    {
        public static Dictionary<string, object> Run(Document doc, JsonElement job, List<string> warnings)
        {
            using var t = Importer.Begin(doc, "Contours to Revit - site design shapes", warnings);
            var mats = job.Arr("materials").Select(m => MaterialFor(doc, m, warnings)).ToList();
            var tagged = Storage.FindTagged(doc);
            var made = new Dictionary<string, int>();
            int failed = 0, removed = 0;
            foreach (var g in job.Arr("groups"))
            {
                var role = g.Str("role") ?? "shape";
                // Replace what this role sent before.
                var old = tagged.Where(x => x.Role == role).Select(x => x.Element.Id).ToList();
                if (old.Count > 0) { try { doc.Delete(old); removed += old.Count; } catch (Exception ex) { warnings.Add($"Couldn't remove the previous {role}: {ex.Message}"); } }
                var cat = Category(doc, g.Str("category"));
                var phase = g.Id("phase");
                var n = 0;
                foreach (var it in g.Arr("items"))
                {
                    try
                    {
                        var geo = Build(it, mats);
                        if (geo == null) { failed++; continue; }
                        var ds = DirectShape.CreateElement(doc, cat);
                        ds.ApplicationId = "ContoursToRevit";
                        ds.ApplicationDataId = it.Str("id") ?? "";
                        ds.SetShape(geo);
                        ds.Name = it.Str("name") ?? role;
                        var c = it.Str("comment");
                        if (!string.IsNullOrEmpty(c)) ds.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.Set(c);
                        if (phase != ElementId.InvalidElementId)
                        {
                            var p = ds.get_Parameter(BuiltInParameter.PHASE_CREATED);
                            if (p != null && !p.IsReadOnly) p.Set(phase);
                        }
                        Storage.Tag(ds, role, it.Str("meta"));
                        n++;
                    }
                    catch (Exception ex) { failed++; if (failed <= 3) warnings.Add($"A {role} shape couldn't be made: {ex.Message}"); }
                }
                made[role] = n;
            }
            Importer.Commit(t, warnings);
            return new Dictionary<string, object> { ["made"] = made, ["failed"] = failed, ["removed"] = removed };
        }

        private static IList<GeometryObject> Build(JsonElement it, List<ElementId> mats)
        {
            var v = it.Arr("v").Select(x => x.GetDouble()).ToArray();
            var pts = new List<XYZ>(v.Length / 3);
            for (int i = 0; i + 2 < v.Length; i += 3) pts.Add(new XYZ(v[i], v[i + 1], v[i + 2]));
            var mi = it.Int("mat", -1);
            var mat = mi >= 0 && mi < mats.Count ? mats[mi] : ElementId.InvalidElementId;
            var builder = new TessellatedShapeBuilder();
            builder.OpenConnectedFaceSet(false);
            var n = 0;
            foreach (var f in it.Arr("f"))
            {
                var loop = f.EnumerateArray().Select(x => pts[x.GetInt32()]).ToList();
                if (loop.Count < 3 || Degenerate(loop)) continue;
                builder.AddFace(new TessellatedFace(loop, mat));
                n++;
            }
            builder.CloseConnectedFaceSet();
            if (n == 0) return null;
            builder.Target = TessellatedShapeBuilderTarget.AnyGeometry;
            builder.Fallback = TessellatedShapeBuilderFallback.Mesh;
            builder.Build();
            var geo = builder.GetBuildResult().GetGeometricalObjects();
            return geo != null && geo.Count > 0 ? geo : null;
        }

        /// <summary>A BuiltInCategory by name (e.g. "OST_Parking"); Generic Models when the name is unknown here or a DirectShape can't use it.</summary>
        private static ElementId Category(Document doc, string name)
        {
            foreach (var nm in (name ?? "").Split('|'))
            {
                if (Enum.TryParse<BuiltInCategory>(nm.Trim(), out var bic))
                {
                    var id = new ElementId(bic);
                    try { if (DirectShape.IsValidCategoryId(id, doc)) return id; } catch { /* try the next */ }
                }
            }
            return new ElementId(BuiltInCategory.OST_GenericModel);
        }

        /// <summary>A material "C2R - name" with the colour and transparency asked for (made once, colour kept in step).</summary>
        private static ElementId MaterialFor(Document doc, JsonElement m, List<string> warnings)
        {
            try
            {
                var name = "C2R - " + (m.Str("name") ?? "Material");
                var existing = new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(x => x.Name == name);
                var mat = existing ?? doc.GetElement(Material.Create(doc, name)) as Material;
                var rgb = m.Arr("rgb").Select(x => (byte)Math.Max(0, Math.Min(255, x.GetInt32()))).ToArray();
                if (rgb.Length == 3) mat.Color = new Color(rgb[0], rgb[1], rgb[2]);
                mat.Transparency = Math.Max(0, Math.Min(100, m.Int("transparency", 0)));
                mat.UseRenderAppearanceForShading = false;
                return mat.Id;
            }
            catch (Exception ex) { warnings.Add("A material couldn't be made: " + ex.Message); return ElementId.InvalidElementId; }
        }

        private static bool Degenerate(List<XYZ> loop)
        {
            for (int i = 0; i < loop.Count; i++)
                if (loop[i].DistanceTo(loop[(i + 1) % loop.Count]) < 0.003) return true;
            if (loop.Count == 3) return (loop[1] - loop[0]).CrossProduct(loop[2] - loop[0]).GetLength() < 1e-6;
            return false;
        }
    }
}
