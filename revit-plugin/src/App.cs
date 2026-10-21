using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows.Media.Imaging;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;

namespace ContoursToRevit
{
    /// <summary>Ribbon button, the site window and the Revit-thread job queue.</summary>
    public class App : IExternalApplication
    {
        public static App Instance { get; private set; }
        public static string AddinDir { get; private set; }
        public static string Version => typeof(App).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
        public static string RevitVersion { get; private set; } = "";

        internal Jobs Jobs { get; private set; }
        internal IntPtr MainWindow { get; private set; }
        private SiteWindow _window;
        private string _lastDocKey;

        public Result OnStartup(UIControlledApplication app)
        {
            Instance = this;
            AddinDir = Path.GetDirectoryName(typeof(App).Assembly.Location);
            RevitVersion = $"{app.ControlledApplication.VersionNumber} ({app.ControlledApplication.SubVersionNumber})";
            MainWindow = app.MainWindowHandle;
            WebView2Assemblies.Register(AddinDir);
            Jobs = new Jobs();

            try { app.CreateRibbonTab("AMR"); } catch { /* tab already exists (another AMR tool) */ }
            var panel = app.GetRibbonPanels("AMR").FirstOrDefault(p => p.Name == "Site") ?? app.CreateRibbonPanel("AMR", "Site");
            var data = new PushButtonData("ContoursToRevit", "Contours\nto Revit", typeof(App).Assembly.Location, typeof(ShowSiteWindow).FullName)
            {
                ToolTip = "Capture a site (USGS topography, aerial, context) and place it in this model as a Toposolid.",
                LongDescription = "Opens the Contours to Revit web app. Generate a site, design pads, walls and slopes, then use Send to Revit to create or update the existing and proposed Toposolids, the aerial and the contour DXF at the Project Base Point.",
                AvailabilityClassName = typeof(AlwaysAvailable).FullName,
                LargeImage = Icon("icon32.png"),
                Image = Icon("icon16.png"),
            };
            data.SetContextualHelp(new ContextualHelp(ContextualHelpType.Url, "https://amrjacob.github.io/Contours-to-Revit/"));
            panel.AddItem(data);

            Updater.StartBackground();
            app.ViewActivated += OnViewActivated;
            app.ControlledApplication.DocumentClosed += OnDocumentClosed;
            return Result.Succeeded;
        }

        public Result OnShutdown(UIControlledApplication app)
        {
            app.ViewActivated -= OnViewActivated;
            app.ControlledApplication.DocumentClosed -= OnDocumentClosed;
            try { _window?.Shutdown(); } catch { /* ignore */ }
            return Result.Succeeded;
        }

        internal void ShowWindow()
        {
            if (_window == null) _window = new SiteWindow(MainWindow);
            _window.ShowAndActivate();
        }

        private void OnViewActivated(object sender, ViewActivatedEventArgs e)
        {
            var key = e.Document == null ? "" : e.Document.PathName + "|" + e.Document.Title;
            if (key == _lastDocKey) return;
            _lastDocKey = key;
            _window?.NotifyDocumentChanged();
        }

        private void OnDocumentClosed(object sender, DocumentClosedEventArgs e)
        {
            _lastDocKey = null;
            _window?.NotifyDocumentChanged();
        }

        private static BitmapSource Icon(string name)
        {
            try
            {
                var s = typeof(App).Assembly.GetManifestResourceStream("ContoursToRevit.Resources." + name);
                if (s == null) return null;
                return BitmapFrame.Create(s, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
            }
            catch { return null; }
        }
    }

    [Transaction(TransactionMode.Manual)]
    public class ShowSiteWindow : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            try { App.Instance.ShowWindow(); return Result.Succeeded; }
            catch (Exception ex) { message = ex.Message; return Result.Failed; }
        }
    }

    /// <summary>The button works with no model open too (the web app can still be used).</summary>
    public class AlwaysAvailable : IExternalCommandAvailability
    {
        public bool IsCommandAvailable(UIApplication app, CategorySet selected) => true;
    }

    /// <summary>
    /// Revit 2026 ships its own WebView2 assemblies. Use whatever is already loaded, else Revit's copy, else ours
    /// (kept in a "webview2" subfolder so the default loader never picks our older copy over Revit's).
    /// </summary>
    internal static class WebView2Assemblies
    {
        private static string _ours;
        internal static bool UsingOurCopy { get; private set; }
        internal static string LoadedFrom { get; private set; } = "";

        public static void Register(string addinDir)
        {
            _ours = Path.Combine(addinDir, "webview2");
            AppDomain.CurrentDomain.AssemblyResolve += Resolve;
        }

        private static Assembly Resolve(object sender, ResolveEventArgs args)
        {
            var name = new AssemblyName(args.Name).Name;
            if (name == null || !name.StartsWith("Microsoft.Web.WebView2", StringComparison.OrdinalIgnoreCase)) return null;
            var loaded = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => string.Equals(a.GetName().Name, name, StringComparison.OrdinalIgnoreCase));
            if (loaded != null) { LoadedFrom = SafeLocation(loaded); return loaded; }
            var revitDir = Path.GetDirectoryName(System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName ?? "");
            foreach (var dir in new[] { revitDir, _ours })
            {
                if (string.IsNullOrEmpty(dir)) continue;
                var f = Path.Combine(dir, name + ".dll");
                if (!File.Exists(f)) continue;
                UsingOurCopy = dir == _ours;
                LoadedFrom = f;
                return Assembly.LoadFrom(f);
            }
            return null;
        }

        internal static string OurFolder => _ours;

        private static string SafeLocation(Assembly a) { try { return a.Location; } catch { return ""; } }
    }
}
