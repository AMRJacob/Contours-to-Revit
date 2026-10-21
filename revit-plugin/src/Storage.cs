using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.ExtensibleStorage;

namespace ContoursToRevit
{
    /// <summary>
    /// What the plugin remembers inside the .rvt (travels with the model, so coworkers get it too):
    /// - on Project Information: the placement (origin / north / datum), the file folder and a snapshot of the web app site + design;
    /// - on each element it made (Toposolids, aerial, DXF links): its role ("existing", "proposed", "aerial", "dxf-existing", …) and details.
    /// </summary>
    internal static class Storage
    {
        private static readonly Guid ProjectGuid = new("6ab89237-ecde-4bf6-9db8-c5b217f115d7");
        private static readonly Guid TagGuid = new("eded107e-54cb-45aa-9178-253afb39ac26");
        private const string Vendor = "AMRA";

        private static Schema ProjectSchema()
        {
            var s = Schema.Lookup(ProjectGuid);
            if (s != null) return s;
            var b = new SchemaBuilder(ProjectGuid);
            b.SetSchemaName("ContoursToRevitProject");
            b.SetVendorId(Vendor);
            b.SetReadAccessLevel(AccessLevel.Public);
            b.SetWriteAccessLevel(AccessLevel.Vendor);
            b.SetDocumentation("Contours to Revit: site placement and web app snapshot.");
            b.AddSimpleField("Placement", typeof(string));
            b.AddSimpleField("Snapshot", typeof(string));
            b.AddSimpleField("Folder", typeof(string));
            return b.Finish();
        }

        private static Schema TagSchema()
        {
            var s = Schema.Lookup(TagGuid);
            if (s != null) return s;
            var b = new SchemaBuilder(TagGuid);
            b.SetSchemaName("ContoursToRevitElement");
            b.SetVendorId(Vendor);
            b.SetReadAccessLevel(AccessLevel.Public);
            b.SetWriteAccessLevel(AccessLevel.Vendor);
            b.SetDocumentation("Contours to Revit: element role and details.");
            b.AddSimpleField("Role", typeof(string));
            b.AddSimpleField("Meta", typeof(string));
            return b.Finish();
        }

        public class ProjectData { public string Placement = ""; public string Snapshot = ""; public string Folder = ""; }

        public static ProjectData ReadProject(Document doc)
        {
            var d = new ProjectData();
            var s = Schema.Lookup(ProjectGuid);
            if (s == null || doc.ProjectInformation == null) return d;
            var e = doc.ProjectInformation.GetEntity(s);
            if (e == null || !e.IsValid()) return d;
            d.Placement = e.Get<string>("Placement") ?? "";
            d.Snapshot = Pack.Unzip(e.Get<string>("Snapshot") ?? "");
            d.Folder = e.Get<string>("Folder") ?? "";
            return d;
        }

        /// <summary>Must run inside a transaction. Null arguments keep the stored value.</summary>
        public static void WriteProject(Document doc, string placement, string snapshot, string folder)
        {
            var s = ProjectSchema();
            var old = ReadProject(doc);
            var e = new Entity(s);
            e.Set("Placement", placement ?? old.Placement ?? "");
            e.Set("Snapshot", snapshot != null ? Pack.Zip(snapshot) : Pack.Zip(old.Snapshot ?? ""));
            e.Set("Folder", folder ?? old.Folder ?? "");
            doc.ProjectInformation.SetEntity(e);
        }

        /// <summary>Must run inside a transaction.</summary>
        public static void Tag(Element el, string role, string meta)
        {
            var e = new Entity(TagSchema());
            e.Set("Role", role ?? "");
            e.Set("Meta", meta ?? "");
            el.SetEntity(e);
        }

        public class Tagged { public Element Element; public string Role; public string Meta; }

        public static List<Tagged> FindTagged(Document doc)
        {
            var s = Schema.Lookup(TagGuid);
            if (s == null) return new List<Tagged>();
            return new FilteredElementCollector(doc).WherePasses(new ExtensibleStorageFilter(TagGuid)).ToElements()
                .Select(el =>
                {
                    var e = el.GetEntity(s);
                    return e != null && e.IsValid() ? new Tagged { Element = el, Role = e.Get<string>("Role"), Meta = e.Get<string>("Meta") } : null;
                })
                .Where(t => t != null)
                .ToList();
        }
    }
}
