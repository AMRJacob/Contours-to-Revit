using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Autodesk.Revit.DB;

namespace ContoursToRevit
{
    internal static class Json
    {
        public static readonly JsonSerializerOptions Options = new()
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
            NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
        };

        public static string Str(this JsonElement e, string name)
        {
            if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return null;
            return v.ValueKind switch
            {
                JsonValueKind.String => v.GetString(),
                JsonValueKind.Number => v.GetRawText(),
                JsonValueKind.True => "true",
                JsonValueKind.False => "false",
                JsonValueKind.Null or JsonValueKind.Undefined => null,
                _ => v.GetRawText(),
            };
        }

        public static double Num(this JsonElement e, string name, double fallback = double.NaN)
        {
            if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return fallback;
            if (v.ValueKind == JsonValueKind.Number) return v.GetDouble();
            if (v.ValueKind == JsonValueKind.String && double.TryParse(v.GetString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d)) return d;
            return fallback;
        }

        public static int Int(this JsonElement e, string name, int fallback = 0)
        {
            var d = e.Num(name, double.NaN);
            return double.IsNaN(d) ? fallback : (int)Math.Round(d);
        }

        public static bool Bool(this JsonElement e, string name, bool fallback = false)
        {
            if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return fallback;
            return v.ValueKind == JsonValueKind.True || (v.ValueKind != JsonValueKind.False && fallback);
        }

        public static bool Has(this JsonElement e, string name) =>
            e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind != JsonValueKind.Null && v.ValueKind != JsonValueKind.Undefined;

        public static JsonElement Obj(this JsonElement e, string name) =>
            e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) ? v : default;

        public static IEnumerable<JsonElement> Arr(this JsonElement e, string name)
        {
            if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.Array) yield break;
            foreach (var x in v.EnumerateArray()) yield return x;
        }

        public static ElementId Id(this JsonElement e, string name)
        {
            var d = e.Num(name, double.NaN);
            return double.IsNaN(d) ? ElementId.InvalidElementId : new ElementId((long)d);
        }
    }

    /// <summary>gzip + base64 for the site snapshot kept in the model.</summary>
    internal static class Pack
    {
        public static string Zip(string text)
        {
            if (string.IsNullOrEmpty(text)) return "";
            using var ms = new MemoryStream();
            using (var gz = new GZipStream(ms, CompressionLevel.Optimal, true))
            {
                var b = Encoding.UTF8.GetBytes(text);
                gz.Write(b, 0, b.Length);
            }
            return "gz:" + Convert.ToBase64String(ms.ToArray());
        }

        public static string Unzip(string packed)
        {
            if (string.IsNullOrEmpty(packed)) return "";
            if (!packed.StartsWith("gz:")) return packed;
            using var ms = new MemoryStream(Convert.FromBase64String(packed.Substring(3)));
            using var gz = new GZipStream(ms, CompressionMode.Decompress);
            using var r = new StreamReader(gz, Encoding.UTF8);
            return r.ReadToEnd();
        }
    }

    /// <summary>Per-user settings: window placement and an optional alternate web app address.</summary>
    internal class Settings
    {
        public double Width { get; set; }
        public double Height { get; set; }
        public double? Left { get; set; }
        public double? Top { get; set; }
        public bool Maximized { get; set; }
        public string Url { get; set; }
        public bool CompatibleRendering { get; set; }
        /// <summary>Install new plugin versions in the background (they load the next time Revit starts).</summary>
        public bool AutoUpdate { get; set; } = true;
        public string LastUpdateCheck { get; set; }

        private static string FilePath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ContoursToRevit", "settings.json");

        public static Settings Load()
        {
            try { return File.Exists(FilePath) ? JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath)) ?? new Settings() : new Settings(); }
            catch { return new Settings(); }
        }

        public void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
                File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
            }
            catch { /* ignore */ }
        }
    }
}
