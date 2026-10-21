using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace ContoursToRevit
{
    /// <summary>
    /// Existing buildings as context massing: one DirectShape per building in the Mass category, built from the
    /// triangles/quads the web app sends (walls from the ground up to the roof, lidar roof surface where measured).
    /// Every send replaces the masses sent before.
    /// </summary>
    internal static class Masses
    {
        public static Dictionary<string, object> Run(Document doc, JsonElement m, List<string> warnings)
        {
            using var t = Importer.Begin(doc, "Contours to Revit - building masses", warnings);
            var old = Storage.FindTagged(doc).Where(x => x.Role == "mass").Select(x => x.Element.Id).ToList();
            if (old.Count > 0) { try { doc.Delete(old); } catch (Exception ex) { warnings.Add("Couldn't remove the previous building masses: " + ex.Message); } }

            var cat = new ElementId(BuiltInCategory.OST_Mass);
            var phase = m.Id("phaseCreated");
            int made = 0, failed = 0, faces = 0;
            foreach (var b in m.Arr("buildings"))
            {
                try
                {
                    var v = b.Arr("v").Select(x => x.GetDouble()).ToArray();
                    var pts = new List<XYZ>(v.Length / 3);
                    for (int i = 0; i + 2 < v.Length; i += 3) pts.Add(new XYZ(v[i], v[i + 1], v[i + 2]));
                    var builder = new TessellatedShapeBuilder();
                    builder.OpenConnectedFaceSet(false);
                    var n = 0;
                    // "f": faces as index lists, each 3 (triangle) or 4 (planar quad) corners.
                    foreach (var f in b.Arr("f"))
                    {
                        var loop = f.EnumerateArray().Select(x => pts[x.GetInt32()]).ToList();
                        if (loop.Count < 3 || Degenerate(loop)) continue;
                        builder.AddFace(new TessellatedFace(loop, ElementId.InvalidElementId));
                        n++;
                    }
                    builder.CloseConnectedFaceSet();
                    if (n == 0) { failed++; continue; }
                    builder.Target = TessellatedShapeBuilderTarget.AnyGeometry;
                    builder.Fallback = TessellatedShapeBuilderFallback.Mesh;
                    builder.Build();
                    var geo = builder.GetBuildResult().GetGeometricalObjects();
                    if (geo == null || geo.Count == 0) { failed++; continue; }
                    var ds = DirectShape.CreateElement(doc, cat);
                    ds.ApplicationId = "ContoursToRevit";
                    ds.ApplicationDataId = b.Str("id") ?? "";
                    ds.SetShape(geo);
                    ds.Name = b.Str("name") ?? "Existing building";
                    var c = b.Str("comment");
                    if (!string.IsNullOrEmpty(c)) ds.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.Set(c);
                    if (phase != ElementId.InvalidElementId)
                    {
                        var p = ds.get_Parameter(BuiltInParameter.PHASE_CREATED);
                        if (p != null && !p.IsReadOnly) p.Set(phase);
                    }
                    Storage.Tag(ds, "mass", b.Str("meta"));
                    made++; faces += n;
                }
                catch (Exception ex) { failed++; if (failed <= 3) warnings.Add("A building mass couldn't be made: " + ex.Message); }
            }
            Importer.Commit(t, warnings);
            return new Dictionary<string, object> { ["made"] = made, ["failed"] = failed, ["faces"] = faces, ["removed"] = old.Count };
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
