using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Visual;
using Autodesk.Revit.UI;

namespace ContoursToRevit
{
    /// <summary>
    /// The building as triangles for the web app: walls, floors, roofs, curtain walls, windows, doors, columns,
    /// stairs, railings, generic models… (no site elements). From the selection, else everything visible in the
    /// active 3D view, else the whole model. Triangles are grouped by material and sent as base64 Float32 offsets from
    /// an origin (Revit internal feet); each material carries its shading colour, render-appearance colour,
    /// transparency, shininess and, when the file can be read, its texture image and real-world size.
    /// </summary>
    internal static class BuildingExport
    {
        private static readonly string[] CategoryNames =
        {
            "OST_Walls", "OST_Floors", "OST_Roofs", "OST_CurtainWallPanels", "OST_CurtainWallMullions", "OST_Windows", "OST_Doors",
            "OST_Columns", "OST_StructuralColumns", "OST_StructuralFraming", "OST_Stairs", "OST_StairsRailing", "OST_Railings",
            "OST_GenericModel", "OST_Fascia", "OST_Gutter", "OST_RoofSoffit", "OST_EdgeSlab", "OST_Ramps", "OST_Mass",
            "OST_CurtaSystem", "OST_SpecialityEquipment", "OST_Entourage",
        };
        private const int MaxTriangles = 250_000;
        private const long MaxTextureBytes = 3_000_000;

        private class Bucket { public ElementId Mat; public List<float> Pos = new(); }

        public static object Get(UIApplication app, JsonElement msg)
        {
            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("Open a Revit project first.");
            var doc = uidoc.Document;
            var scope = msg.Str("scope") ?? "auto";
            var cats = new HashSet<long>();
            foreach (var n in CategoryNames) if (Enum.TryParse<BuiltInCategory>(n, out var b)) cats.Add((long)b);
            var ours = new HashSet<ElementId>(Storage.FindTagged(doc).Select(x => x.Element.Id));

            // Which elements.
            var ids = new HashSet<ElementId>();
            string how;
            var sel = uidoc.Selection.GetElementIds();
            if (scope != "view" && sel.Count > 0)
            {
                how = "selection";
                foreach (var id in sel)
                {
                    ids.Add(id);
                    // Curtain panels, mullions and hosted windows / doors come with their wall.
                    try { var el = doc.GetElement(id); if (el != null) foreach (var d in el.GetDependentElements(null)) ids.Add(d); } catch { /* not available for every element */ }
                }
            }
            else
            {
                var v3 = doc.ActiveView as View3D;
                var fc = v3 != null && !v3.IsTemplate ? new FilteredElementCollector(doc, v3.Id) : new FilteredElementCollector(doc);
                how = v3 != null && !v3.IsTemplate ? "view" : "model";
                foreach (var id in fc.WhereElementIsNotElementType().ToElementIds()) ids.Add(id);
            }

            var opt = new Options { DetailLevel = ViewDetailLevel.Medium, IncludeNonVisibleObjects = false, ComputeReferences = false };
            var buckets = new Dictionary<long, Bucket>();
            int tris = 0, elements = 0;
            bool truncated = false;
            double gfa = 0;
            var floorLevels = new HashSet<ElementId>();
            double ox = double.NaN, oy = 0, oz = 0;

            void AddMesh(Mesh m, ElementId mat)
            {
                if (m == null) return;
                var key = mat?.Value ?? -1;
                if (!buckets.TryGetValue(key, out var b)) buckets[key] = b = new Bucket { Mat = mat ?? ElementId.InvalidElementId };
                for (int i = 0; i < m.NumTriangles; i++)
                {
                    if (tris >= MaxTriangles) { truncated = true; return; }
                    var t = m.get_Triangle(i);
                    for (int k = 0; k < 3; k++)
                    {
                        var p = t.get_Vertex(k);
                        if (double.IsNaN(ox)) { ox = p.X; oy = p.Y; oz = p.Z; }
                        b.Pos.Add((float)(p.X - ox)); b.Pos.Add((float)(p.Y - oy)); b.Pos.Add((float)(p.Z - oz));
                    }
                    tris++;
                }
            }
            void Walk(GeometryElement ge, ElementId fallbackMat)
            {
                if (ge == null) return;
                foreach (var o in ge)
                {
                    if (truncated) return;
                    switch (o)
                    {
                        case Solid s when s.Faces.Size > 0:
                            foreach (Face f in s.Faces)
                            {
                                Mesh m = null;
                                try { m = f.Triangulate(0.5); } catch { /* skip faces Revit can't mesh */ }
                                var mat = f.MaterialElementId;
                                AddMesh(m, mat == ElementId.InvalidElementId ? fallbackMat : mat);
                            }
                            break;
                        case Mesh mm:
                            AddMesh(mm, mm.MaterialElementId == ElementId.InvalidElementId ? fallbackMat : mm.MaterialElementId);
                            break;
                        case GeometryInstance gi:
                            Walk(gi.GetInstanceGeometry(), fallbackMat);
                            break;
                    }
                }
            }

            foreach (var id in ids)
            {
                if (truncated) break;
                if (ours.Contains(id)) continue;
                var e = doc.GetElement(id);
                var c = e?.Category;
                if (c == null || !cats.Contains(c.Id.Value)) continue;
                GeometryElement ge;
                try { ge = e.get_Geometry(opt); } catch { continue; }
                if (ge == null) continue;
                elements++;
                Walk(ge, c.Material?.Id ?? ElementId.InvalidElementId);
                if (e is Floor)
                {
                    gfa += e.get_Parameter(BuiltInParameter.HOST_AREA_COMPUTED)?.AsDouble() ?? 0;
                    if (e.LevelId != ElementId.InvalidElementId) floorLevels.Add(e.LevelId);
                }
            }
            if (tris == 0) throw new InvalidOperationException(how == "selection"
                ? "Nothing to send in the selection — select walls, floors, roofs, windows… (site elements are left out)."
                : "Nothing to send — open a 3D view showing the building, or select its elements.");

            // Materials.
            var matList = new List<Dictionary<string, object>>();
            var outBuckets = new List<Dictionary<string, object>>();
            foreach (var b in buckets.Values)
            {
                var info = MaterialInfo(app, doc, b.Mat);
                matList.Add(info);
                var bytes = new byte[b.Pos.Count * 4];
                Buffer.BlockCopy(b.Pos.ToArray(), 0, bytes, 0, bytes.Length);
                outBuckets.Add(new Dictionary<string, object> { ["mat"] = matList.Count - 1, ["n"] = b.Pos.Count / 9, ["pos"] = Convert.ToBase64String(bytes) });
            }
            return new Dictionary<string, object>
            {
                ["name"] = doc.Title, ["how"] = how, ["elements"] = elements, ["triangles"] = tris, ["truncated"] = truncated,
                ["origin"] = new[] { ox, oy, oz }, ["buckets"] = outBuckets, ["materials"] = matList,
                ["gfa"] = Math.Round(gfa), ["floors"] = floorLevels.Count,
            };
        }

        private static Dictionary<string, object> MaterialInfo(UIApplication app, Document doc, ElementId id)
        {
            var d = new Dictionary<string, object> { ["name"] = "Default", ["rgb"] = new[] { 200, 200, 200 }, ["transparency"] = 0, ["shininess"] = 0 };
            if (doc.GetElement(id) is not Material mat) return d;
            d["name"] = mat.Name;
            try { d["rgb"] = new[] { (int)mat.Color.Red, (int)mat.Color.Green, (int)mat.Color.Blue }; } catch { /* keep the default */ }
            d["transparency"] = mat.Transparency;
            d["shininess"] = mat.Shininess;
            try
            {
                if (mat.AppearanceAssetId == ElementId.InvalidElementId || doc.GetElement(mat.AppearanceAssetId) is not AppearanceAssetElement ae) return d;
                var asset = ae.GetRenderingAsset();
                if (asset == null) return d;
                if (asset.FindByName("generic_diffuse") is AssetPropertyDoubleArray4d diffuse)
                {
                    var c = diffuse.GetValueAsColor();
                    d["render"] = new[] { (int)c.Red, (int)c.Green, (int)c.Blue };
                    var bmp = diffuse.GetSingleConnectedAsset();
                    if (bmp != null) Texture(app, bmp, d);
                }
                if (asset.FindByName("generic_transparency") is AssetPropertyDouble tr) d["renderTransparency"] = tr.Value;
            }
            catch (Exception ex) { d["appearanceError"] = ex.Message; }
            return d;
        }

        /// <summary>The texture image behind a diffuse colour, when it's a file we can find and it isn't huge.</summary>
        private static void Texture(UIApplication app, Asset bmp, Dictionary<string, object> d)
        {
            if (bmp.FindByName("unifiedbitmap_Bitmap") is not AssetPropertyString ps || string.IsNullOrWhiteSpace(ps.Value)) return;
            var raw = ps.Value.Split('|')[0].Trim();
            d["texPath"] = raw;
            foreach (var path in Candidates(raw))
            {
                try
                {
                    if (!File.Exists(path)) continue;
                    var fi = new FileInfo(path);
                    if (fi.Length > MaxTextureBytes) { d["texSkipped"] = "too large"; return; }
                    var ext = fi.Extension.ToLowerInvariant();
                    var mime = ext is ".jpg" or ".jpeg" ? "image/jpeg" : ext == ".png" ? "image/png" : ext == ".bmp" ? "image/bmp" : null;
                    if (mime == null) { d["texSkipped"] = "format " + ext; return; }
                    d["tex"] = Convert.ToBase64String(File.ReadAllBytes(path));
                    d["mime"] = mime;
                    break;
                }
                catch { /* try the next place */ }
            }
            // Real-world size of one tile (internal feet).
            foreach (var (prop, key) in new[] { ("texture_RealWorldScaleX", "sx"), ("texture_RealWorldScaleY", "sy") })
            {
                try { if (bmp.FindByName(prop) is AssetPropertyDistance pd) d[key] = UnitUtils.ConvertToInternalUnits(pd.Value, pd.GetUnitTypeId()); } catch { /* unitless */ }
            }
        }

        private static IEnumerable<string> Candidates(string raw)
        {
            if (Path.IsPathRooted(raw)) yield return raw;
            var rel = raw.TrimStart('\\', '/');
            var common = Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFilesX86);
            if (!string.IsNullOrEmpty(common))
            {
                yield return Path.Combine(common, "Autodesk Shared", "Materials", "Textures", rel);
                yield return Path.Combine(common, "Autodesk Shared", "Materials", "Textures", Path.GetFileName(rel));
            }
            var common64 = Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFiles);
            if (!string.IsNullOrEmpty(common64)) yield return Path.Combine(common64, "Autodesk Shared", "Materials", "Textures", rel);
        }
    }
}
