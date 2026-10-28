using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace ContoursToRevit
{
    /// <summary>
    /// Modeless window hosting the live web app. Closing only hides it, so the site and design stay in memory.
    /// Web ⇄ Revit messages: the page posts { id, type, ... }; the window replies { type:"reply", id, ok, result|error }.
    /// </summary>
    internal class SiteWindow : Window
    {
        public const string DefaultUrl = "https://amrjacob.github.io/Contours-to-Revit/?host=revit";
        private readonly Grid _root = new Grid();
        private WebView2 _web;
        private readonly TextBlock _message = new TextBlock { Margin = new Thickness(24), TextWrapping = TextWrapping.Wrap, FontSize = 14 };
        private bool _ready;
        private bool _shuttingDown;
        private readonly Files _files = new Files();

        public SiteWindow(IntPtr owner)
        {
            Title = "Contours to Revit";
            var s = Settings.Load();
            Width = s.Width > 400 ? s.Width : 1400;
            Height = s.Height > 300 ? s.Height : 900;
            if (s.Left.HasValue && s.Top.HasValue && OnScreen(s.Left.Value, s.Top.Value)) { WindowStartupLocation = WindowStartupLocation.Manual; Left = s.Left.Value; Top = s.Top.Value; }
            else WindowStartupLocation = WindowStartupLocation.CenterScreen;
            if (s.Maximized) WindowState = WindowState.Maximized;
            Background = new SolidColorBrush(Color.FromRgb(0x1c, 0x22, 0x26));
            _message.Foreground = Brushes.White;
            _message.Text = "Loading Contours to Revit…";
            _root.Children.Add(_message);
            Content = _root;
            new WindowInteropHelper(this).Owner = owner;
            ShowInTaskbar = true;
            Closing += (o, e) => { if (!_shuttingDown) { e.Cancel = true; SaveBounds(); Hide(); } };
            Loaded += async (o, e) => await InitWebView();
        }

        private static bool OnScreen(double left, double top) =>
            left > SystemParameters.VirtualScreenLeft - 50 && top > SystemParameters.VirtualScreenTop - 50 &&
            left < SystemParameters.VirtualScreenLeft + SystemParameters.VirtualScreenWidth - 100 &&
            top < SystemParameters.VirtualScreenTop + SystemParameters.VirtualScreenHeight - 100;

        public void ShowAndActivate()
        {
            if (!IsVisible) Show();
            if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
            Activate();
        }

        public void Shutdown()
        {
            _shuttingDown = true;
            SaveBounds();
            try { _web?.Dispose(); } catch { /* ignore */ }
            Close();
        }

        private void SaveBounds()
        {
            try
            {
                var s = Settings.Load();
                s.Maximized = WindowState == WindowState.Maximized;
                var b = s.Maximized ? RestoreBounds : new Rect(Left, Top, Width, Height);
                if (!b.IsEmpty) { s.Left = b.Left; s.Top = b.Top; s.Width = b.Width; s.Height = b.Height; }
                s.Save();
            }
            catch { /* ignore */ }
        }

        private async Task InitWebView()
        {
            try
            {
                // Our copy of WebView2.Core needs our WebView2Loader.dll (Revit's copy finds Revit's loader itself).
                if (WebView2Assemblies.UsingOurCopy)
                {
                    try { CoreWebView2Environment.SetLoaderDllFolderPath(WebView2Assemblies.OurFolder); } catch { /* already set */ }
                }
                var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ContoursToRevit", "WebView2");
                Directory.CreateDirectory(data);
                // "Compatible rendering" (Settings) turns off GPU drawing in case a graphics driver garbles the map.
                var opts = new CoreWebView2EnvironmentOptions();
                if (Settings.Load().CompatibleRendering) opts.AdditionalBrowserArguments = "--disable-gpu --disable-gpu-compositing";
                var env = await CoreWebView2Environment.CreateAsync(null, data, opts);
                _web = new WebView2();
                _root.Children.Add(_web);
                await _web.EnsureCoreWebView2Async(env);
                var core = _web.CoreWebView2;
                core.Settings.AreDevToolsEnabled = true;
                core.Settings.IsStatusBarEnabled = false;
                core.WebMessageReceived += OnMessage;
                core.NewWindowRequested += (o, e) =>
                {
                    // Links that open a new tab (GitHub, data sources) go to the default browser.
                    e.Handled = true;
                    OpenExternal(e.Uri);
                };
                core.NavigationCompleted += (o, e) =>
                {
                    _ready = true;
                    if (e.IsSuccess) _message.Visibility = Visibility.Collapsed;
                    else
                    {
                        _message.Visibility = Visibility.Visible;
                        _message.Text = "Couldn't load the Contours to Revit web app (" + e.WebErrorStatus + "). Check the internet connection, then close and reopen this window.\n\n" + Url;
                        _web.Visibility = Visibility.Collapsed;
                    }
                };
                _web.Source = new Uri(Url);
            }
            catch (Exception ex)
            {
                _message.Visibility = Visibility.Visible;
                _message.Text = "The built-in browser (Microsoft Edge WebView2) could not start:\n\n" + ex.Message +
                    "\n\nWindows 10/11 normally includes it. If it is missing, install the \"WebView2 Runtime\" from Microsoft, or open https://amrjacob.github.io/Contours-to-Revit/ in a browser and use the DXF/CSV downloads.";
            }
        }

        private static string Url
        {
            get
            {
                var u = Settings.Load().Url;
                return string.IsNullOrWhiteSpace(u) ? DefaultUrl : u;
            }
        }

        internal static void OpenExternal(string uri)
        {
            try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { /* ignore */ }
        }

        public void NotifyDocumentChanged()
        {
            if (!_ready || _web?.CoreWebView2 == null) return;
            Post(new Dictionary<string, object> { ["type"] = "event", ["event"] = "documentChanged" });
        }

        private void Post(object msg)
        {
            try { _web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(msg, Json.Options)); }
            catch (Exception ex) { Debug.WriteLine(ex); }
        }

        private async void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            JsonElement msg;
            try { using var d = JsonDocument.Parse(e.WebMessageAsJson); msg = d.RootElement.Clone(); }
            catch { return; }
            var id = msg.TryGetProperty("id", out var idEl) ? idEl.Clone() : default;
            var type = msg.Str("type");
            try
            {
                object result = await Handle(type, msg);
                Post(new Dictionary<string, object> { ["type"] = "reply", ["id"] = id.ValueKind == JsonValueKind.Undefined ? null : id, ["ok"] = true, ["result"] = result });
            }
            catch (Exception ex)
            {
                Post(new Dictionary<string, object> { ["type"] = "reply", ["id"] = id.ValueKind == JsonValueKind.Undefined ? null : id, ["ok"] = false, ["error"] = Describe(ex) });
            }
        }

        private static string Describe(Exception ex)
        {
            while (ex is AggregateException a && a.InnerException != null) ex = a.InnerException;
            while (ex is System.Reflection.TargetInvocationException t && t.InnerException != null) ex = t.InnerException;
            return ex.Message;
        }

        private async Task<object> Handle(string type, JsonElement msg)
        {
            switch (type)
            {
                case "hello":
                    return new Dictionary<string, object>
                    {
                        ["host"] = "revit",
                        ["version"] = App.Version,
                        ["revit"] = App.RevitVersion,
                        ["webview2"] = WebView2Assemblies.LoadedFrom,
                        ["browser"] = _web?.CoreWebView2?.Environment?.BrowserVersionString,
                        ["url"] = Url,
                        ["compatibleRendering"] = Settings.Load().CompatibleRendering,
                        ["update"] = Updater.Status(),
                        ["features"] = new[] { "drape", "masses", "shapes", "building" },
                    };
                case "getModel":
                    return await App.Instance.Jobs.Run(app => ModelInfo.Get(app));
                case "chunk":
                    return _files.Chunk(msg);
                case "pickFolder":
                    {
                        var dlg = new Microsoft.Win32.OpenFolderDialog { Title = "Folder for the site files (aerial, DXF)" };
                        var start = msg.Str("start");
                        if (!string.IsNullOrEmpty(start) && Directory.Exists(start)) dlg.InitialDirectory = start;
                        return dlg.ShowDialog(this) == true ? dlg.FolderName : null;
                    }
                case "openFolder":
                    {
                        var f = msg.Str("path");
                        if (!string.IsNullOrEmpty(f) && Directory.Exists(f)) OpenExternal(f);
                        return true;
                    }
                case "openUrl":
                    OpenExternal(msg.Str("url"));
                    return true;
                case "import":
                    {
                        var files = _files;
                        var result = await App.Instance.Jobs.Run(app => Importer.Run(app, msg, files));
                        _files.Clear();
                        return result;
                    }
                case "getBuilding":
                    return await App.Instance.Jobs.Run(app => BuildingExport.Get(app, msg));
                case "select":
                    return await App.Instance.Jobs.Run(app => ModelInfo.Select(app, msg));
                case "checkUpdate":
                    return await Updater.Check(force: true);
                case "installUpdate":
                    return await Updater.Install();
                case "setRendering":
                    {
                        var s = Settings.Load(); s.CompatibleRendering = msg.Bool("compatible"); s.Save();
                        return new Dictionary<string, object> { ["compatibleRendering"] = s.CompatibleRendering, ["restart"] = true };
                    }
                case "setUrl":
                    {
                        // Developer option: point the window at another copy of the web app (blank = default).
                        var s = Settings.Load(); s.Url = msg.Str("url"); s.Save();
                        _web.Source = new Uri(Url);
                        return true;
                    }
                default:
                    throw new InvalidOperationException("Unknown request: " + type);
            }
        }
    }

    /// <summary>Binary files from the page arrive base64-encoded in chunks and are kept in a temp folder until imported.</summary>
    internal class Files
    {
        private readonly Dictionary<string, string> _paths = new();
        private readonly string _dir = Path.Combine(Path.GetTempPath(), "ContoursToRevit");

        public object Chunk(JsonElement msg)
        {
            var fid = msg.Str("fid");
            if (string.IsNullOrEmpty(fid) || fid.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw new ArgumentException("bad file id");
            var index = msg.Int("i");
            Directory.CreateDirectory(_dir);
            var path = Path.Combine(_dir, fid);
            var bytes = Convert.FromBase64String(msg.Str("b64") ?? "");
            using (var fs = new FileStream(path, index == 0 ? FileMode.Create : FileMode.Append, FileAccess.Write))
                fs.Write(bytes, 0, bytes.Length);
            _paths[fid] = path;
            return new Dictionary<string, object> { ["fid"] = fid, ["bytes"] = new FileInfo(path).Length };
        }

        public string Get(string fid) => fid != null && _paths.TryGetValue(fid, out var p) && File.Exists(p) ? p : throw new FileNotFoundException("file not received: " + fid);

        public void Clear()
        {
            foreach (var p in _paths.Values) { try { File.Delete(p); } catch { /* ignore */ } }
            _paths.Clear();
        }
    }
}
