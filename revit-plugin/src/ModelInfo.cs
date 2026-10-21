using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace ContoursToRevit
{
    /// <summary>Everything the web app needs to know about the active model. Lengths are Revit internal feet.</summary>
    internal static class ModelInfo
    {
        public static object Get(UIApplication app)
        {
            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) return new Dictionary<string, object> { ["doc"] = null };
            var doc = uidoc.Document;
            if (doc.IsFamilyDocument) return new Dictionary<string, object> { ["doc"] = null, ["family"] = true, ["title"] = doc.Title };

            var pbp = BasePoint.GetProjectBasePoint(doc);
            var survey = BasePoint.GetSurveyPoint(doc);
            var p = pbp.Position;
            var loc = doc.ActiveProjectLocation;
            var pos = loc.GetProjectPosition(p);
            // Shared coordinates of a point 100 ft "up" (project north) from the base point: gives the direction of
            // project north in the shared system without relying on the sign convention of ProjectPosition.Angle.
            var posN = loc.GetProjectPosition(p + new XYZ(0, 100, 0));
            var posE = loc.GetProjectPosition(p + new XYZ(100, 0, 0));
            var stored = Storage.ReadProject(doc);
            var active = uidoc.ActiveView;

            var phases = new List<object>();
            foreach (Phase ph in doc.Phases) phases.Add(new Dictionary<string, object> { ["id"] = ph.Id.Value, ["name"] = ph.Name });

            var types = new FilteredElementCollector(doc).OfClass(typeof(ToposolidType)).Cast<ToposolidType>()
                .OrderBy(t => t.Name).Select(t => (object)new Dictionary<string, object> { ["id"] = t.Id.Value, ["name"] = t.Name }).ToList();

            var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>()
                .OrderBy(l => l.Elevation).Select(l => (object)new Dictionary<string, object> { ["id"] = l.Id.Value, ["name"] = l.Name, ["elev"] = l.Elevation, ["projElev"] = l.ProjectElevation }).ToList();

            var views = new FilteredElementCollector(doc).OfClass(typeof(ViewPlan)).Cast<ViewPlan>()
                .Where(v => !v.IsTemplate && (v.ViewType == ViewType.FloorPlan || v.ViewType == ViewType.EngineeringPlan) && ImageInstance.IsValidView(v))
                .OrderBy(v => v.Name)
                .Select(v => (object)new Dictionary<string, object> { ["id"] = v.Id.Value, ["name"] = v.Name, ["level"] = v.GenLevel?.Name }).ToList();

            var tagged = Storage.FindTagged(doc).Select(t => (object)new Dictionary<string, object>
            {
                ["id"] = t.Element.Id.Value,
                ["role"] = t.Role,
                ["meta"] = t.Meta,
                ["category"] = t.Element.Category?.Name,
                ["name"] = t.Element.Name,
                ["viewId"] = t.Element.OwnerViewId?.Value ?? -1,
            }).ToList();

            var lengthUnit = doc.GetUnits().GetFormatOptions(SpecTypeId.Length).GetUnitTypeId();

            return new Dictionary<string, object>
            {
                ["doc"] = new Dictionary<string, object>
                {
                    ["title"] = doc.Title,
                    ["path"] = doc.PathName,
                    ["cloud"] = doc.IsModelInCloud,
                    ["workshared"] = doc.IsWorkshared,
                    ["key"] = DocKey(doc),
                    ["units"] = lengthUnit?.TypeId,
                    ["metric"] = doc.DisplayUnitSystem == DisplayUnit.METRIC,
                },
                ["pbp"] = Xyz(p),
                ["pbpShared"] = Pos(pos),
                ["survey"] = Xyz(survey.Position),
                ["sharedNorthDelta"] = new[] { posN.EastWest - pos.EastWest, posN.NorthSouth - pos.NorthSouth },
                ["sharedEastDelta"] = new[] { posE.EastWest - pos.EastWest, posE.NorthSouth - pos.NorthSouth },
                ["phases"] = phases,
                ["toposolidTypes"] = types,
                ["levels"] = levels,
                ["views"] = views,
                ["activeView"] = active == null ? null : new Dictionary<string, object>
                {
                    ["id"] = active.Id.Value, ["name"] = active.Name, ["type"] = active.ViewType.ToString(),
                    ["image"] = active is ViewPlan vp && !vp.IsTemplate && ImageInstance.IsValidView(vp),
                },
                ["stored"] = new Dictionary<string, object>
                {
                    ["placement"] = stored.Placement,
                    ["snapshot"] = stored.Snapshot,
                    ["folder"] = stored.Folder,
                },
                ["defaultFolder"] = DefaultFolder(doc),
                ["elements"] = tagged,
            };
        }

        public static object Select(UIApplication app, JsonElement msg)
        {
            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) return false;
            var ids = msg.Arr("ids").Select(x => new ElementId((long)x.GetDouble())).Where(id => uidoc.Document.GetElement(id) != null).ToList();
            uidoc.Selection.SetElementIds(ids);
            if (ids.Count > 0) { try { uidoc.ShowElements(ids); } catch { /* not visible in the active view */ } }
            return ids.Count;
        }

        internal static string DocKey(Document doc) => (doc.PathName ?? "") + "|" + doc.Title;

        internal static string DefaultFolder(Document doc)
        {
            var name = SafeName(Path.GetFileNameWithoutExtension(doc.Title ?? "Model"));
            try
            {
                if (!doc.IsModelInCloud && !string.IsNullOrEmpty(doc.PathName) && Path.IsPathRooted(doc.PathName))
                {
                    var dir = Path.GetDirectoryName(doc.PathName);
                    if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir)) return Path.Combine(dir, name + " site");
                }
            }
            catch { /* fall through */ }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Contours to Revit", name);
        }

        internal static string SafeName(string s)
        {
            foreach (var c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '-');
            return string.IsNullOrWhiteSpace(s) ? "site" : s.Trim();
        }

        internal static Dictionary<string, object> Xyz(XYZ p) => new() { ["x"] = p.X, ["y"] = p.Y, ["z"] = p.Z };

        internal static Dictionary<string, object> Pos(ProjectPosition p) => new()
        {
            ["ew"] = p.EastWest, ["ns"] = p.NorthSouth, ["elev"] = p.Elevation, ["angle"] = p.Angle * 180 / Math.PI,
        };
    }
}
