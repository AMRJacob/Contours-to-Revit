using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace ContoursToRevit
{
    /// <summary>
    /// Applies one "Send to Revit" package as a single undo step. The web app computes every coordinate
    /// (Revit internal feet, already placed at the Project Base Point); this side only creates and updates elements.
    /// </summary>
    internal static class Importer
    {
        public static object Run(UIApplication app, JsonElement job, Files files)
        {
            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("Open a Revit project first.");
            var doc = uidoc.Document;
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Switch to a project (not a family) first.");
            if (doc.IsReadOnly) throw new InvalidOperationException("This model is read-only.");

            var results = new List<object>();
            var warnings = new List<string>();
            var folder = job.Str("folder");
            if (string.IsNullOrWhiteSpace(folder)) folder = ModelInfo.DefaultFolder(doc);
            var prefix = ModelInfo.SafeName(job.Str("prefix") ?? "site");

            using var tg = new TransactionGroup(doc, "Contours to Revit");
            tg.Start();
            try
            {
                if (job.Has("coords")) results.Add(Step("coordinates", warnings, () => SetCoordinates(doc, job.Obj("coords"), warnings)));
                foreach (var t in job.Arr("toposolids"))
                {
                    var role = t.Str("role");
                    results.Add(Step(role, warnings, () => Toposolid_(doc, t, warnings)));
                }
                if (job.Has("image"))
                {
                    var im = job.Obj("image");
                    results.Add(Step("aerial", warnings, () => Image(doc, im, files, folder, prefix, warnings)));
                }
                if (job.Has("masses"))
                {
                    var ms = job.Obj("masses");
                    results.Add(Step("masses", warnings, () => Masses.Run(doc, ms, warnings)));
                }
                if (job.Has("shapes"))
                {
                    var sh = job.Obj("shapes");
                    results.Add(Step("shapes", warnings, () => Shapes.Run(doc, sh, warnings)));
                }
                if (job.Has("drape"))
                {
                    var dr = job.Obj("drape");
                    results.Add(Step("drape", warnings, () => Drape.Run(doc, dr, files, folder, warnings)));
                }
                foreach (var d in job.Arr("dxfs"))
                {
                    var role = d.Str("role");
                    results.Add(Step(role, warnings, () => Dxf(doc, uidoc, d, files, folder, warnings)));
                }
                if (job.Has("state"))
                {
                    var st = job.Obj("state");
                    results.Add(Step("state", warnings, () =>
                    {
                        using var t = new Transaction(doc, "Contours to Revit - save site");
                        t.Start();
                        Storage.WriteProject(doc, st.Str("placement"), st.Str("snapshot"), folder);
                        t.Commit();
                        return new Dictionary<string, object>();
                    }));
                }
                tg.Assimilate();
            }
            catch
            {
                if (tg.HasStarted()) tg.RollBack();
                throw;
            }
            return new Dictionary<string, object> { ["results"] = results, ["warnings"] = warnings.Distinct().ToList(), ["folder"] = folder };
        }

        private static object Step(string role, List<string> warnings, Func<Dictionary<string, object>> work)
        {
            try
            {
                var r = work();
                r["role"] = role;
                r["ok"] = true;
                return r;
            }
            catch (Exception ex)
            {
                return new Dictionary<string, object> { ["role"] = role, ["ok"] = false, ["error"] = ex.Message };
            }
        }

        /// <summary>Commit, or throw with Revit's own error text when Revit rolled the step back.</summary>
        internal static void Commit(Transaction t, List<string> warnings)
        {
            var st = t.Commit();
            if (st != TransactionStatus.Committed)
                throw new InvalidOperationException(QuietWarnings.LastErrors.Count > 0 ? string.Join(" ", QuietWarnings.LastErrors) : "Revit cancelled this step (" + st + ").");
        }

        internal static Transaction Begin(Document doc, string name, List<string> warnings)
        {
            QuietWarnings.LastErrors.Clear();
            var t = new Transaction(doc, name);
            var o = t.GetFailureHandlingOptions();
            o.SetFailuresPreprocessor(new QuietWarnings(warnings));
            o.SetClearAfterRollback(true);
            t.SetFailureHandlingOptions(o);
            t.Start();
            return t;
        }

        // ---------------- Shared coordinates (Specify Coordinates at Point, at the Project Base Point) ----------------

        private static Dictionary<string, object> SetCoordinates(Document doc, JsonElement c, List<string> warnings)
        {
            var p = new XYZ(c.Num("x", 0), c.Num("y", 0), c.Num("z", 0));
            double ew = c.Num("ew", 0), ns = c.Num("ns", 0), elev = c.Num("elev", 0);
            var ang = c.Num("angle", 0) * Math.PI / 180;           // + = counter-clockwise (Revit "East")
            var expect = c.Arr("expectNorth").Select(v => v.GetDouble()).ToArray(); // shared direction of project north
            var loc = doc.ActiveProjectLocation;
            double Check()
            {
                if (expect.Length < 2) return 1;
                var a = loc.GetProjectPosition(p);
                var b = loc.GetProjectPosition(p + new XYZ(0, 100, 0));
                double dx = b.EastWest - a.EastWest, dy = b.NorthSouth - a.NorthSouth;
                double l1 = Math.Sqrt(dx * dx + dy * dy), l2 = Math.Sqrt(expect[0] * expect[0] + expect[1] * expect[1]);
                if (l1 < 1e-6 || l2 < 1e-9) return 1;
                return (dx * expect[0] + dy * expect[1]) / (l1 * l2);
            }
            using var t = Begin(doc, "Contours to Revit - set coordinates", warnings);
            loc.SetProjectPosition(p, new ProjectPosition(ew, ns, elev, ang));
            var dot = Check();
            var flipped = false;
            if (dot < 0.9999 && Math.Abs(ang) > 1e-9)
            {
                // The API's angle sign is the other way round: set it again and keep whichever matches.
                loc.SetProjectPosition(p, new ProjectPosition(ew, ns, elev, -ang));
                var dot2 = Check();
                if (dot2 > dot) { dot = dot2; flipped = true; }
                else loc.SetProjectPosition(p, new ProjectPosition(ew, ns, elev, ang));
            }
            Commit(t, warnings);
            if (dot < 0.9999) warnings.Add($"Project north in the shared coordinates is off by {Math.Acos(Math.Max(-1, Math.Min(1, dot))) * 180 / Math.PI:0.00}° from what the web app expected. Check Manage › Coordinates.");
            var now = loc.GetProjectPosition(p);
            return new Dictionary<string, object> { ["check"] = dot, ["flipped"] = flipped, ["position"] = ModelInfo.Pos(now) };
        }

        // ---------------- Toposolids ----------------

        private static Dictionary<string, object> Toposolid_(Document doc, JsonElement t, List<string> warnings)
        {
            var flat = t.Arr("points").Select(v => v.GetDouble()).ToArray();
            if (flat.Length < 9) throw new InvalidOperationException("not enough points");
            var pts = new List<XYZ>(flat.Length / 3);
            for (int i = 0; i + 2 < flat.Length; i += 3) pts.Add(new XYZ(flat[i], flat[i + 1], flat[i + 2]));

            var typeId = t.Id("typeId");
            if (typeId == ElementId.InvalidElementId || doc.GetElement(typeId) is not ToposolidType)
                typeId = new FilteredElementCollector(doc).OfClass(typeof(ToposolidType)).FirstElementId();
            if (typeId == null || typeId == ElementId.InvalidElementId) throw new InvalidOperationException("this model has no Toposolid type");
            var levelId = t.Id("levelId");
            if (doc.GetElement(levelId) is not Level)
                levelId = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation).Select(l => l.Id).FirstOrDefault();
            if (levelId == null || levelId == ElementId.InvalidElementId) throw new InvalidOperationException("this model has no levels");

            var role = t.Str("role") ?? "existing";
            using var tr = Begin(doc, role == "proposed" ? "Contours to Revit - proposed Toposolid" : "Contours to Revit - existing Toposolid", warnings);

            // A Toposolid's flat bottom starts at its level minus the type's thickness, so ground below that ("too thin
            // for its given type") fails. Build it with every point above the level, then move it down into place.
            var level = (Level)doc.GetElement(levelId);
            var lift = Math.Max(0, level.ProjectElevation + 1.0 - pts.Min(q => q.Z));
            var build = lift > 0 ? pts.Select(q => new XYZ(q.X, q.Y, q.Z + lift)).ToList() : pts;

            Toposolid ts = null;
            var profile = Profile(doc, t);
            var usedProfile = false;
            if (profile != null)
            {
                try { ts = Toposolid.Create(doc, new List<CurveLoop> { profile }, build, typeId, levelId); usedProfile = true; }
                catch (Exception ex) { warnings.Add("The boundary outline couldn't be used (" + ex.Message + "); the Toposolid follows the outer points instead."); }
            }
            ts ??= Toposolid.Create(doc, build, typeId, levelId);

            SetPhase(ts, BuiltInParameter.PHASE_CREATED, t.Id("phaseCreated"));
            SetPhase(ts, BuiltInParameter.PHASE_DEMOLISHED, t.Id("phaseDemolished"));
            var comment = t.Str("comment");
            if (!string.IsNullOrEmpty(comment)) ts.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.Set(comment);
            Storage.Tag(ts, role, t.Str("meta"));

            // Move it to the real elevations: compare its top with the highest point (also covers points being
            // taken relative to the level).
            doc.Regenerate();
            double moved = 0;
            var bb = ts.get_BoundingBox(null);
            if (bb != null)
            {
                var want = pts.Max(q => q.Z);
                var diff = want - bb.Max.Z;
                if (Math.Abs(diff) > 0.01) { ElementTransformUtils.MoveElement(doc, ts.Id, new XYZ(0, 0, diff)); moved = diff; }
            }

            var replaced = Replace(doc, t.Id("replaceId"), ts.Id, warnings);
            var id = ts.Id.Value;
            Commit(tr, warnings);
            return new Dictionary<string, object> { ["id"] = id, ["points"] = pts.Count, ["profile"] = usedProfile, ["moved"] = moved, ["replaced"] = replaced, ["lift"] = lift };
        }

        private static CurveLoop Profile(Document doc, JsonElement t)
        {
            var ring = t.Arr("profile").Select(p => p.EnumerateArray().Select(v => v.GetDouble()).ToArray()).Where(p => p.Length >= 2).ToList();
            if (ring.Count < 3) return null;
            var tol = doc.Application.ShortCurveTolerance * 1.5;
            var z = 0.0;
            var pts = new List<XYZ>();
            foreach (var r in ring)
            {
                var q = new XYZ(r[0], r[1], z);
                if (pts.Count == 0 || pts[^1].DistanceTo(q) > tol) pts.Add(q);
            }
            if (pts.Count > 2 && pts[0].DistanceTo(pts[^1]) <= tol) pts.RemoveAt(pts.Count - 1);
            if (pts.Count < 3) return null;
            var loop = new CurveLoop();
            for (int i = 0; i < pts.Count; i++) loop.Append(Line.CreateBound(pts[i], pts[(i + 1) % pts.Count]));
            return loop;
        }

        private static void SetPhase(Element e, BuiltInParameter bip, ElementId phase)
        {
            if (phase == null || phase == ElementId.InvalidElementId) return;
            var p = e.get_Parameter(bip);
            if (p != null && !p.IsReadOnly) p.Set(phase);
        }

        private static bool Replace(Document doc, ElementId oldId, ElementId newId, List<string> warnings)
        {
            if (oldId == null || oldId == ElementId.InvalidElementId || oldId == newId) return false;
            var old = doc.GetElement(oldId);
            if (old == null) return false;
            try { doc.Delete(oldId); return true; }
            catch (Exception ex) { warnings.Add($"Couldn't remove the previous element {oldId.Value}: {ex.Message}"); return false; }
        }

        // ---------------- Aerial image ----------------

        private static Dictionary<string, object> Image(Document doc, JsonElement im, Files files, string folder, string prefix, List<string> warnings)
        {
            Directory.CreateDirectory(folder);
            var name = ModelInfo.SafeName(im.Str("file") ?? (prefix + "_aerial.jpg"));
            var path = Path.Combine(folder, name);
            File.Copy(files.Get(im.Str("fid")), path, true);

            var view = doc.GetElement(im.Id("viewId")) as View;
            if (view == null || !ImageInstance.IsValidView(view)) throw new InvalidOperationException("choose a plan view for the aerial");
            var center = new XYZ(im.Num("cx", 0), im.Num("cy", 0), 0);
            double w = im.Num("w", 0), h = im.Num("h", 0);

            using var t = Begin(doc, "Contours to Revit - aerial", warnings);
            var inst = doc.GetElement(im.Id("replaceId")) as ImageInstance;
            var reused = false;
            if (inst != null && inst.OwnerViewId == view.Id && doc.GetElement(inst.GetTypeId()) is ImageType it)
            {
                try { it.ReloadFrom(new ImageTypeOptions(path, false, ImageTypeSource.Link)); reused = true; }
                catch (Exception ex) { warnings.Add("Couldn't reload the aerial in place (" + ex.Message + "); placed a new one."); }
            }
            if (!reused)
            {
                if (inst != null) { try { doc.Delete(inst.Id); } catch { /* ignore */ } }
                var type = ImageType.Create(doc, new ImageTypeOptions(path, false, ImageTypeSource.Link));
                inst = ImageInstance.Create(doc, view, type.Id, new ImagePlacementOptions(center, BoxPlacement.Center));
            }
            inst.LockProportions = false;
            if (w > 0) inst.Width = w;
            if (h > 0) inst.Height = h;
            inst.LockProportions = true;
            inst.SetLocation(center, BoxPlacement.Center);
            try { inst.DrawLayer = DrawLayer.Background; } catch { /* ignore */ }
            Storage.Tag(inst, "aerial", im.Str("meta"));
            Commit(t, warnings);
            return new Dictionary<string, object> { ["id"] = inst.Id.Value, ["path"] = path, ["reloaded"] = reused, ["view"] = view.Name };
        }

        // ---------------- DXF links ----------------

        private static Dictionary<string, object> Dxf(Document doc, UIDocument uidoc, JsonElement d, Files files, string folder, List<string> warnings)
        {
            Directory.CreateDirectory(folder);
            var role = d.Str("role") ?? "dxf";
            var name = ModelInfo.SafeName(d.Str("file") ?? (role + ".dxf"));
            var path = Path.Combine(folder, name);
            File.Copy(files.Get(d.Str("fid")), path, true);
            var target = new XYZ(d.Num("ox", 0), d.Num("oy", 0), d.Num("oz", 0));

            using var t = Begin(doc, "Contours to Revit - " + name, warnings);
            var inst = doc.GetElement(d.Id("replaceId")) as ImportInstance;
            var reloaded = false;
            if (inst != null && inst.IsLinked && doc.GetElement(inst.GetTypeId()) is CADLinkType lt)
            {
                try { lt.LoadFrom(path); reloaded = true; }
                catch (Exception ex) { warnings.Add("Couldn't reload " + name + " (" + ex.Message + "); linked it again."); }
            }
            if (!reloaded)
            {
                if (inst != null) { try { doc.Delete(inst.Id); } catch { /* ignore */ } }
                var opt = new DWGImportOptions
                {
                    Placement = ImportPlacement.Origin,
                    Unit = d.Str("unit") == "m" ? ImportUnit.Meter : ImportUnit.Foot,
                    ThisViewOnly = false,
                    ColorMode = ImportColorMode.Preserved,
                    OrientToView = true,
                    VisibleLayersOnly = false,
                };
                var view = DxfView(doc, uidoc);
                if (!doc.Link(path, opt, view, out var id) || id == null || id == ElementId.InvalidElementId) throw new InvalidOperationException("Revit couldn't link " + name);
                inst = doc.GetElement(id) as ImportInstance ?? throw new InvalidOperationException("link created but not found");
            }
            // Origin of the DXF at the Project Base Point.
            var now = inst.GetTotalTransform().Origin;
            var delta = target - now;
            if (delta.GetLength() > 1e-6)
            {
                var wasPinned = inst.Pinned;
                if (wasPinned) inst.Pinned = false;
                ElementTransformUtils.MoveElement(doc, inst.Id, delta);
                inst.Pinned = true;
            }
            else inst.Pinned = true;
            Storage.Tag(inst, role, d.Str("meta"));
            Commit(t, warnings);
            return new Dictionary<string, object> { ["id"] = inst.Id.Value, ["path"] = path, ["reloaded"] = reloaded };
        }

        private static View DxfView(Document doc, UIDocument uidoc)
        {
            var v = uidoc.ActiveView;
            if (v != null && !v.IsTemplate && (v is ViewPlan || v is View3D || v is ViewSection)) return v;
            return new FilteredElementCollector(doc).OfClass(typeof(ViewPlan)).Cast<ViewPlan>().FirstOrDefault(x => !x.IsTemplate)
                ?? (View)new FilteredElementCollector(doc).OfClass(typeof(View3D)).Cast<View3D>().FirstOrDefault(x => !x.IsTemplate);
        }
    }

    /// <summary>Collects warnings instead of showing Revit's warning dialog in the middle of an import.</summary>
    internal class QuietWarnings : IFailuresPreprocessor
    {
        private readonly List<string> _sink;
        public QuietWarnings(List<string> sink) { _sink = sink; }

        /// <summary>Errors from the last transaction that was rolled back (shown in the web panel instead of a Revit dialog).</summary>
        public static readonly List<string> LastErrors = new();

        public FailureProcessingResult PreprocessFailures(FailuresAccessor a)
        {
            var error = false;
            foreach (var f in a.GetFailureMessages())
            {
                var sev = f.GetSeverity();
                if (sev == FailureSeverity.Warning)
                {
                    _sink.Add(f.GetDescriptionText());
                    a.DeleteWarning(f);
                }
                else if (sev == FailureSeverity.Error || sev == FailureSeverity.DocumentCorruption)
                {
                    error = true;
                    LastErrors.Add(f.GetDescriptionText());
                }
            }
            // An error can't be ignored: undo just this step quietly and report it, rather than stopping on a dialog.
            return error ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
        }
    }
}
