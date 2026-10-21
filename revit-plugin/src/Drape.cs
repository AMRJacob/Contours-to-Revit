using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Visual;

namespace ContoursToRevit
{
    /// <summary>
    /// "Aerial on the Toposolids": a material whose render appearance is the site aerial at real-world size, painted on
    /// the top faces of the tagged Toposolids so Realistic views and renderings show the photo on the ground.
    /// The web app sends where the image goes (internal feet) and the texture offset to use, so the alignment can be
    /// tuned from the web side without a new plugin.
    /// </summary>
    internal static class Drape
    {
        public static Dictionary<string, object> Run(Document doc, JsonElement d, Files files, string folder, List<string> warnings)
        {
            Directory.CreateDirectory(folder);
            var path = Path.Combine(folder, ModelInfo.SafeName(d.Str("file") ?? "site_aerial.jpg"));
            File.Copy(files.Get(d.Str("fid")), path, true);
            var name = d.Str("name") ?? "Site aerial";
            double w = d.Num("w", 0), h = d.Num("h", 0);
            if (!(w > 0 && h > 0)) throw new InvalidOperationException("no image size");
            // Texture offset: by default the image's lower-left corner (web app may override).
            double ox = d.Num("ox", d.Num("x0", 0)), oy = d.Num("oy", d.Num("y0", 0)), ang = d.Num("angle", 0);
            var roles = d.Arr("roles").Select(x => x.GetString()).ToHashSet();

            using var t = Importer.Begin(doc, "Contours to Revit - aerial material", warnings);
            var mat = new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(m => m.Name == name)
                ?? (Material)doc.GetElement(Material.Create(doc, name));
            var assetId = EnsureAsset(doc, mat, name);
            using (var scope = new AppearanceAssetEditScope(doc))
            {
                var asset = scope.Start(assetId);
                var diffuse = asset.FindByName("generic_diffuse") ?? throw new InvalidOperationException("the appearance asset has no diffuse image slot");
                Asset bmp = diffuse.NumberOfConnectedProperties > 0 ? diffuse.GetConnectedProperty(0) as Asset : null;
                if (bmp == null || bmp.Name != "UnifiedBitmapSchema")
                {
                    if (diffuse.NumberOfConnectedProperties > 0) diffuse.RemoveConnectedAsset();
                    diffuse.AddConnectedAsset("UnifiedBitmapSchema");
                    bmp = (Asset)diffuse.GetConnectedProperty(0);
                }
                if (bmp.FindByName(UnifiedBitmap.UnifiedbitmapBitmap) is AssetPropertyString src)
                {
                    if (!src.IsValidValue(path)) throw new InvalidOperationException("Revit refused the image path " + path);
                    src.Value = path;
                }
                Distance(bmp, UnifiedBitmap.TextureRealWorldScaleX, w, warnings);
                Distance(bmp, UnifiedBitmap.TextureRealWorldScaleY, h, warnings);
                Distance(bmp, UnifiedBitmap.TextureRealWorldOffsetX, ox, warnings);
                Distance(bmp, UnifiedBitmap.TextureRealWorldOffsetY, oy, warnings);
                Set<AssetPropertyBoolean>(bmp, UnifiedBitmap.TextureScaleLock, p => p.Value = false);
                Set<AssetPropertyBoolean>(bmp, UnifiedBitmap.TextureOffsetLock, p => p.Value = false);
                Set<AssetPropertyBoolean>(bmp, UnifiedBitmap.TextureURepeat, p => p.Value = false);
                Set<AssetPropertyBoolean>(bmp, UnifiedBitmap.TextureVRepeat, p => p.Value = false);
                Set<AssetPropertyDouble>(bmp, UnifiedBitmap.TextureWAngle, p => p.Value = ang);
                // Matte ground, no shine.
                Set<AssetPropertyDouble>(asset, "generic_glossiness", p => p.Value = 0.0);
                Set<AssetPropertyDouble>(asset, "generic_reflectivity_at_0deg", p => p.Value = 0.0);
                Set<AssetPropertyDouble>(asset, "generic_reflectivity_at_90deg", p => p.Value = 0.0);
                scope.Commit(true);
            }
            try { mat.UseRenderAppearanceForShading = true; } catch { /* not available */ }
            mat.Color = new Color(118, 120, 96);

            // Paint the upward faces of each tagged Toposolid.
            int painted = 0, faces = 0;
            var opt = new Options { ComputeReferences = true, DetailLevel = ViewDetailLevel.Fine };
            foreach (var tg in Storage.FindTagged(doc).Where(x => roles.Contains(x.Role) && x.Element is Toposolid))
            {
                var n = 0;
                foreach (var face in TopFaces(tg.Element.get_Geometry(opt)))
                {
                    try { doc.Paint(tg.Element.Id, face, mat.Id); n++; }
                    catch (Exception ex) { warnings.Add("A Toposolid face couldn't be painted: " + ex.Message); }
                }
                if (n > 0) { painted++; faces += n; }
            }
            Importer.Commit(t, warnings);
            return new Dictionary<string, object> { ["material"] = name, ["materialId"] = mat.Id.Value, ["painted"] = painted, ["faces"] = faces, ["path"] = path };
        }

        /// <summary>The material's own appearance asset, made from a Generic one when it has none (or shares one).</summary>
        private static ElementId EnsureAsset(Document doc, Material mat, string name)
        {
            var assetName = name + " (appearance)";
            if (doc.GetElement(mat.AppearanceAssetId) is AppearanceAssetElement own && own.Name == assetName && HasDiffuse(own.GetRenderingAsset())) return own.Id;
            var existing = new FilteredElementCollector(doc).OfClass(typeof(AppearanceAssetElement)).Cast<AppearanceAssetElement>().FirstOrDefault(a => a.Name == assetName);
            if (existing == null)
            {
                // A generic appearance from this model, else from Revit's appearance library.
                var generic = new FilteredElementCollector(doc).OfClass(typeof(AppearanceAssetElement)).Cast<AppearanceAssetElement>()
                    .Where(a => { try { return HasDiffuse(a.GetRenderingAsset()); } catch { return false; } })
                    .OrderByDescending(a => a.Name.IndexOf("Generic", StringComparison.OrdinalIgnoreCase) >= 0)
                    .FirstOrDefault();
                if (generic != null) existing = generic.Duplicate(assetName);
                else
                {
                    var lib = doc.Application.GetAssets(AssetType.Appearance).FirstOrDefault(a => HasDiffuse(a) && a.Name.IndexOf("Generic", StringComparison.OrdinalIgnoreCase) >= 0)
                        ?? doc.Application.GetAssets(AssetType.Appearance).FirstOrDefault(HasDiffuse)
                        ?? throw new InvalidOperationException("no Generic appearance asset found to base the aerial material on");
                    existing = AppearanceAssetElement.Create(doc, assetName, lib);
                }
            }
            mat.AppearanceAssetId = existing.Id;
            return existing.Id;
        }

        private static bool HasDiffuse(Asset a) { try { return a?.FindByName("generic_diffuse") != null; } catch { return false; } }

        private static void Distance(Asset a, string prop, double feet, List<string> warnings)
        {
            try
            {
                if (a.FindByName(prop) is AssetPropertyDistance p)
                {
                    var u = p.GetUnitTypeId();
                    p.Value = u == null || u.Empty() ? feet : UnitUtils.Convert(feet, UnitTypeId.Feet, u);
                }
            }
            catch (Exception ex) { warnings.Add($"Texture {prop}: {ex.Message}"); }
        }

        private static void Set<T>(Asset a, string prop, Action<T> set) where T : AssetProperty
        {
            try { if (a.FindByName(prop) is T p) set(p); } catch { /* optional property */ }
        }

        private static IEnumerable<Face> TopFaces(GeometryElement ge)
        {
            if (ge == null) yield break;
            foreach (var o in ge)
            {
                if (o is Solid s && s.Faces.Size > 0)
                {
                    foreach (Face f in s.Faces)
                    {
                        XYZ nrm;
                        try
                        {
                            if (f is PlanarFace pf) nrm = pf.FaceNormal;
                            else { var bb = f.GetBoundingBox(); nrm = f.ComputeNormal((bb.Min + bb.Max) / 2); }
                        }
                        catch { continue; }
                        if (nrm.Z > 0.2) yield return f;
                    }
                }
                else if (o is GeometryInstance gi)
                    foreach (var f in TopFaces(gi.GetInstanceGeometry())) yield return f;
            }
        }
    }
}
