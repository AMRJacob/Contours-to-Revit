using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace ContoursToRevit
{
    /// <summary>
    /// Plugin updates. Each version installs into its own folder (…\Addins\2026\ContoursToRevit\&lt;version&gt;) and the
    /// .addin is pointed at it, so the installer can run while Revit has the current version loaded. The running
    /// Revit keeps the old version; the new one loads the next time Revit starts. (A loaded add-in DLL can't be
    /// swapped inside a running Revit, but the web app part updates live anyway.)
    /// </summary>
    internal static class Updater
    {
        private const string Releases = "https://api.github.com/repos/AMRJacob/Contours-to-Revit/releases?per_page=30";
        private const string AllowedPrefix = "https://github.com/AMRJacob/Contours-to-Revit/releases/download/";
        private static readonly SemaphoreSlim Gate = new(1, 1);

        private static string _latest;       // newest release version seen
        private static string _url;          // its installer
        private static string _state = "idle"; // idle | checking | downloading | installing | installed | error
        private static string _error;

        private static string UpdatesDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ContoursToRevit", "updates");
        private static string AddinFile => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Autodesk", "Revit", "Addins", "2026", "ContoursToRevit.addin");

        /// <summary>Version the .addin points at (what Revit loads next start), or null.</summary>
        public static string InstalledVersion()
        {
            try
            {
                if (!File.Exists(AddinFile)) return null;
                var m = Regex.Match(File.ReadAllText(AddinFile), @"ContoursToRevit[\\/](\d+\.\d+\.\d+)[\\/]ContoursToRevit\.dll", RegexOptions.IgnoreCase);
                return m.Success ? m.Groups[1].Value : null;
            }
            catch { return null; }
        }

        public static Dictionary<string, object> Status()
        {
            var installed = InstalledVersion();
            var pending = installed != null && Newer(installed, App.Version) ? installed : null;
            return new Dictionary<string, object>
            {
                ["current"] = App.Version,
                ["latest"] = _latest,
                ["pending"] = pending,                       // installed, loads when Revit restarts
                ["available"] = _latest != null && Newer(_latest, pending ?? App.Version),
                ["state"] = _state,
                ["error"] = _error,
                ["auto"] = Settings.Load().AutoUpdate,
            };
        }

        /// <summary>At Revit start: look for a new version at most every few hours and install it quietly.</summary>
        public static void StartBackground()
        {
            Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(20)); // let Revit finish starting
                    var s = Settings.Load();
                    if (!s.AutoUpdate) return;
                    if (DateTime.TryParse(s.LastUpdateCheck, null, System.Globalization.DateTimeStyles.RoundtripKind, out var last) && DateTime.UtcNow - last < TimeSpan.FromHours(4)) return;
                    await Check(force: false);
                    if (_latest != null && Newer(_latest, InstalledVersion() ?? App.Version)) await Install();
                }
                catch (Exception ex) { Debug.WriteLine(ex); }
            });
        }

        public static async Task<object> Check(bool force)
        {
            await Gate.WaitAsync();
            try
            {
                _state = "checking"; _error = null;
                using var http = Client();
                var json = await http.GetStringAsync(Releases);
                using var doc = JsonDocument.Parse(json);
                foreach (var rel in doc.RootElement.EnumerateArray())
                {
                    if (rel.Bool("draft") || rel.Bool("prerelease")) continue;
                    var tag = rel.Str("tag_name") ?? "";
                    var m = Regex.Match(tag, @"^revit-v(\d+\.\d+\.\d+)$");
                    if (!m.Success) continue;
                    var url = rel.Arr("assets").Select(a => a.Str("browser_download_url")).FirstOrDefault(u => u != null && u.EndsWith("/ContoursToRevit-Setup.exe"));
                    if (url == null) continue;
                    if (_latest == null || Newer(m.Groups[1].Value, _latest)) { _latest = m.Groups[1].Value; _url = url; }
                }
                var s = Settings.Load(); s.LastUpdateCheck = DateTime.UtcNow.ToString("o"); s.Save();
                _state = "idle";
            }
            catch (Exception ex) { _state = "error"; _error = "Couldn't check for updates: " + ex.Message; }
            finally { Gate.Release(); }
            return Status();
        }

        /// <summary>Download the newest installer and run it silently for this user. Revit keeps running.</summary>
        public static async Task<object> Install()
        {
            if (_url == null) await Check(force: true);
            await Gate.WaitAsync();
            try
            {
                if (_url == null || _latest == null) throw new InvalidOperationException("No plugin release found.");
                if (!_url.StartsWith(AllowedPrefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Unexpected download address.");
                var installed = InstalledVersion();
                if (installed != null && !Newer(_latest, installed)) { _state = "installed"; return Status(); }

                _state = "downloading"; _error = null;
                Directory.CreateDirectory(UpdatesDir);
                foreach (var old in Directory.GetFiles(UpdatesDir, "ContoursToRevit-Setup-*.exe")) { try { File.Delete(old); } catch { /* in use */ } }
                var exe = Path.Combine(UpdatesDir, $"ContoursToRevit-Setup-{_latest}.exe");
                using (var http = Client())
                using (var resp = await http.GetAsync(_url, HttpCompletionOption.ResponseHeadersRead))
                {
                    resp.EnsureSuccessStatusCode();
                    using var fs = new FileStream(exe, FileMode.Create, FileAccess.Write, FileShare.None);
                    await resp.Content.CopyToAsync(fs);
                }

                _state = "installing";
                var log = Path.Combine(UpdatesDir, "install.log");
                var p = Process.Start(new ProcessStartInfo(exe, $"/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER /LOG=\"{log}\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = UpdatesDir,
                });
                if (p == null) throw new InvalidOperationException("The installer didn't start.");
                await p.WaitForExitAsync();
                if (p.ExitCode != 0) throw new InvalidOperationException($"The installer stopped (code {p.ExitCode}). Details: {log}");
                _state = InstalledVersion() == _latest ? "installed" : "error";
                if (_state == "error") _error = "The installer finished but Revit's add-in file wasn't updated.";
            }
            catch (Exception ex) { _state = "error"; _error = ex.Message; }
            finally { Gate.Release(); }
            return Status();
        }

        private static HttpClient Client()
        {
            var http = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
            http.DefaultRequestHeaders.UserAgent.ParseAdd("ContoursToRevit/" + App.Version);
            http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json, application/octet-stream, */*");
            return http;
        }

        /// <summary>a is newer than b (x.y.z).</summary>
        public static bool Newer(string a, string b)
        {
            if (a == null) return false;
            if (b == null) return true;
            return Version.TryParse(a, out var va) && Version.TryParse(b, out var vb) && va > vb;
        }
    }
}
