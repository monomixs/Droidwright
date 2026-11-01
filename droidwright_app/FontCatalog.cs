using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Droidwright;

/// <summary>
/// Looks inside  web\Fonts\  and describes every font it finds, so the app can offer them
/// offline. You never have to list the fonts anywhere - just drop files in:
///
///     web\Fonts\Sans-Serif\Inter-Regular.ttf        the folder name is the CATEGORY
///     web\Fonts\Sans-Serif\Inter-Bold.ttf           (it becomes a filter in the font browser)
///     web\Fonts\Serif\PlayfairDisplay-Regular.ttf
///
/// For each file it reads the font's own name table (family, weight, italic), so it does not
/// depend on how the file happens to be named. Sub-folders inside a category (e.g. "static")
/// are fine. Supported: .ttf  .otf  .woff   (.woff2 can't be turned into text outlines, so it is
/// skipped and reported back as "ignored").
/// </summary>
internal static class FontCatalog
{
    /// <summary>The category shown first and selected by default in the font browser.</summary>
    public const string PrimaryCategory = "Sans-Serif";

    /// <summary>The category that fonts added by the user go into (matches web/JS/fonts.js).</summary>
    public const string CustomCategory = "My Fonts";

    private static readonly HashSet<string> UsableExtensions =
        new(StringComparer.OrdinalIgnoreCase) { ".ttf", ".otf", ".woff" };

    private static readonly HashSet<string> UnusableExtensions =
        new(StringComparer.OrdinalIgnoreCase) { ".woff2", ".ttc", ".eot" };

    private sealed class Face
    {
        public string Url = "";          // relative to the site root, e.g. Fonts/Sans-Serif/Inter-Bold.ttf
        public string Family = "";
        public string Category = "";
        public int Weight = 400;
        public bool Italic;
        public bool Variable;
        public int WMin = 400, WMax = 400;
        public int? OpticalSize;         // "Inter 18pt" style names -> 18
    }

    /// <summary>
    /// Returns the whole catalog as JSON (see web/JS/fonts.js for how it is used).
    /// Two places are read: the built-in  web\Fonts  folder, and (if given) the folder holding fonts
    /// the user added. Custom fonts get the url "user:&lt;path inside that folder&gt;" - they live outside the
    /// app's own folder, so the page reads them through the Bridge instead of a web address.
    /// </summary>
    public static string ScanToJson(string webRoot, string? userFontsDir = null)
    {
        var faces = new List<Face>();
        var ignored = new List<string>();

        ScanFolder(Path.Combine(webRoot, "Fonts"), "Fonts/", faces, ignored);
        if (!string.IsNullOrEmpty(userFontsDir)) ScanFolder(userFontsDir, "user:", faces, ignored);

        // One entry per (category, family). Same family in two categories = two entries.
        var families = faces
            .GroupBy(f => (f.Category.ToLowerInvariant(), f.Family.ToLowerInvariant()))
            .Select(g =>
            {
                Face first = g.First();
                var unique = g
                    .OrderBy(f => f.OpticalSize ?? 0)                  // prefer the plain / smallest optical size
                    .GroupBy(f => (f.Weight, f.Italic, f.Variable))
                    .Select(x => x.First())
                    .OrderBy(f => f.Variable)                          // static faces first
                    .ThenBy(f => f.Weight)
                    .ThenBy(f => f.Italic)
                    .ToList();
                return new { family = first.Family, category = first.Category, faces = unique };
            })
            .OrderBy(f => f.family, StringComparer.OrdinalIgnoreCase)
            .ToList();

        string primary = families.Select(f => f.category)
            .FirstOrDefault(c => Normalize(c) == Normalize(PrimaryCategory)) ?? PrimaryCategory;

        var categories = families.Select(f => f.category).Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(c => Normalize(c) == Normalize(primary) ? 0 : 1)   // primary first...
            .ThenBy(c => c, StringComparer.OrdinalIgnoreCase)           // ...then A-Z
            .ToList();

        return JsonSerializer.Serialize(new
        {
            primary,
            categories,
            fonts = families.Select(f => new
            {
                f.family,
                f.category,
                faces = f.faces.Select(x => new
                {
                    url = x.Url, weight = x.Weight, italic = x.Italic,
                    variable = x.Variable, wmin = x.WMin, wmax = x.WMax,
                }),
            }),
            ignored,
        });
    }

    private static string Normalize(string s) =>
        Regex.Replace(s.ToLowerInvariant(), "[^a-z0-9]", "");

    private static void ScanFolder(string fontsDir, string urlPrefix, List<Face> faces, List<string> ignored)
    {
        if (!Directory.Exists(fontsDir)) return;
        foreach (string file in Directory.EnumerateFiles(fontsDir, "*", SearchOption.AllDirectories))
        {
            string ext = Path.GetExtension(file);
            string relToFonts = Path.GetRelativePath(fontsDir, file).Replace('\\', '/');
            if (relToFonts.Split('/').Any(p => p.StartsWith('.'))) continue;     // hidden files/folders

            if (UnusableExtensions.Contains(ext)) { ignored.Add(urlPrefix + relToFonts); continue; }
            if (!UsableExtensions.Contains(ext)) continue;

            int slash = relToFonts.IndexOf('/');
            string category = slash > 0 ? relToFonts[..slash] : "Other";   // files not in a category folder

            Face face;
            try { face = ReadFace(file) ?? FromFileName(file); }
            catch { face = FromFileName(file); }                            // damaged file: still list it

            face.Url = urlPrefix + relToFonts;
            face.Category = category;
            faces.Add(face);
        }
    }

    /// <summary>Does this file start like a real font (TrueType, OpenType/CFF or WOFF)?</summary>
    public static bool LooksLikeFont(string path)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            var head = new byte[4];
            if (fs.Read(head, 0, 4) < 4) return false;
            string sig = Encoding.ASCII.GetString(head);
            return sig is "OTTO" or "true" or "wOFF" || (head[0] == 0 && head[1] == 1 && head[2] == 0 && head[3] == 0);
        }
        catch { return false; }
    }

    /// <summary>The family name to show for a font file (from inside the file, else from its name).</summary>
    public static string FamilyOf(string path)
    {
        try { return (ReadFace(path) ?? FromFileName(path)).Family; }
        catch { return FromFileName(path).Family; }
    }

    // ------------------------------------------------------------------------------------
    //  Reading a font file's own metadata (the sfnt "name", "OS/2", "head" and "fvar" tables)
    // ------------------------------------------------------------------------------------

    private static Face? ReadFace(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var tables = ReadDirectory(fs, out bool isWoff);
        if (tables is null) return null;

        byte[]? Table(string tag) => tables.TryGetValue(tag, out var t) ? LoadTable(fs, t, isWoff) : null;

        string? family = null, subfamily = null;
        byte[]? name = Table("name");
        if (name is { Length: > 6 })
        {
            var names = ReadNames(name);
            family = names.GetValueOrDefault(16) ?? names.GetValueOrDefault(1);
            subfamily = names.GetValueOrDefault(17) ?? names.GetValueOrDefault(2);
        }
        if (string.IsNullOrWhiteSpace(family)) return null;                    // no usable name: use the file name

        string fileStyleHint = (subfamily ?? "") + " " + Path.GetFileNameWithoutExtension(path);

        int weight = 0;
        bool italic = false;
        byte[]? os2 = Table("OS/2");
        if (os2 is { Length: >= 6 }) weight = U16(os2, 4);
        if (os2 is { Length: >= 64 }) italic |= (U16(os2, 62) & 1) != 0;       // fsSelection: italic bit
        byte[]? head = Table("head");
        if (head is { Length: >= 46 }) italic |= (U16(head, 44) & 2) != 0;     // macStyle: italic bit
        italic |= Regex.IsMatch(fileStyleHint, "italic|oblique", RegexOptions.IgnoreCase);

        weight = weight > 0 ? SnapWeight(weight) : WeightFromText(fileStyleHint);

        var face = new Face { Italic = italic, Weight = weight, WMin = weight, WMax = weight };

        // Variable font? Read the weight axis range.
        byte[]? fvar = Table("fvar");
        if (fvar is { Length: >= 16 })
        {
            face.Variable = true;
            int axesOffset = U16(fvar, 4), axisCount = U16(fvar, 8), axisSize = U16(fvar, 10);
            for (int i = 0; i < axisCount; i++)
            {
                int a = axesOffset + i * axisSize;
                if (a + 16 > fvar.Length) break;
                if (Encoding.ASCII.GetString(fvar, a, 4) != "wght") continue;
                face.WMin = SnapWeight((int)Math.Round(Fixed(fvar, a + 4)));
                face.Weight = SnapWeight((int)Math.Round(Fixed(fvar, a + 8)));   // the default instance
                face.WMax = SnapWeight((int)Math.Round(Fixed(fvar, a + 12)));
            }
        }

        (face.Family, face.OpticalSize) = SplitOpticalSize(family.Trim());
        return face;
    }

    private sealed record TableEntry(long Offset, uint CompressedLength, uint Length);

    private static Dictionary<string, TableEntry>? ReadDirectory(Stream fs, out bool isWoff)
    {
        isWoff = false;
        var head = new byte[12];
        if (fs.Read(head, 0, 12) < 12) return null;
        string sig = Encoding.ASCII.GetString(head, 0, 4);
        var result = new Dictionary<string, TableEntry>();

        if (sig == "wOFF")                                   // WOFF 1: 44-byte header, 20-byte entries
        {
            isWoff = true;
            var h = new byte[44];
            fs.Position = 0;
            if (fs.Read(h, 0, 44) < 44) return null;
            int count = U16(h, 12);
            var dir = new byte[count * 20];
            if (fs.Read(dir, 0, dir.Length) < dir.Length) return null;
            for (int i = 0; i < count; i++)
            {
                int o = i * 20;
                result[Encoding.ASCII.GetString(dir, o, 4)] = new TableEntry(U32(dir, o + 4), U32(dir, o + 8), U32(dir, o + 12));
            }
            return result;
        }

        bool sfnt = sig == "OTTO" || sig == "true" || (head[0] == 0 && head[1] == 1 && head[2] == 0 && head[3] == 0);
        if (!sfnt) return null;                              // not a single font file (e.g. a .ttc collection)

        int n = U16(head, 4);
        var entries = new byte[n * 16];
        if (fs.Read(entries, 0, entries.Length) < entries.Length) return null;
        for (int i = 0; i < n; i++)
        {
            int o = i * 16;
            result[Encoding.ASCII.GetString(entries, o, 4)] = new TableEntry(U32(entries, o + 8), U32(entries, o + 12), U32(entries, o + 12));
        }
        return result;
    }

    private static byte[]? LoadTable(Stream fs, TableEntry t, bool isWoff)
    {
        const long MaxTable = 4 * 1024 * 1024;
        if (t.CompressedLength > MaxTable || t.Length > MaxTable) return null;
        fs.Position = t.Offset;
        var raw = new byte[t.CompressedLength];
        if (fs.Read(raw, 0, raw.Length) < raw.Length) return null;
        if (!isWoff || t.CompressedLength >= t.Length) return raw;     // stored uncompressed

        using var z = new ZLibStream(new MemoryStream(raw), CompressionMode.Decompress);
        var output = new byte[t.Length];
        int read = 0;
        while (read < output.Length)
        {
            int got = z.Read(output, read, output.Length - read);
            if (got <= 0) break;
            read += got;
        }
        return read == output.Length ? output : null;
    }

    /// <summary>Reads the "name" table: id 16/17 = family/style, falling back to 1/2.</summary>
    private static Dictionary<int, string> ReadNames(byte[] t)
    {
        int count = U16(t, 2), stringOffset = U16(t, 4);
        var best = new Dictionary<int, (int Score, string Text)>();
        for (int i = 0; i < count; i++)
        {
            int r = 6 + i * 12;
            if (r + 12 > t.Length) break;
            int platform = U16(t, r), language = U16(t, r + 4), id = U16(t, r + 6);
            int length = U16(t, r + 8), offset = U16(t, r + 10);
            if (id is not (1 or 2 or 16 or 17)) continue;
            int start = stringOffset + offset;
            if (start + length > t.Length) continue;

            string text = platform is 0 or 3
                ? Encoding.BigEndianUnicode.GetString(t, start, length)
                : Encoding.Latin1.GetString(t, start, length);
            int score = platform == 3 && language == 0x409 ? 3 : platform is 3 or 0 ? 2 : 1;   // prefer English
            if (!best.TryGetValue(id, out var current) || score > current.Score) best[id] = (score, text);
        }
        return best.ToDictionary(kv => kv.Key, kv => kv.Value.Text);
    }

    // ------------------------------------------------------------------------------------
    //  Fallback: work it out from the file name ("Inter-BoldItalic.ttf", "OpenSans-Light.ttf")
    // ------------------------------------------------------------------------------------

    private static Face FromFileName(string path)
    {
        string stem = Path.GetFileNameWithoutExtension(path);
        string familyPart = Regex.Split(stem, "[-_]")[0];
        familyPart = Regex.Replace(familyPart, "(?<=[a-z])(?=[A-Z])", " ").Trim();   // OpenSans -> Open Sans
        if (familyPart.Length == 0) familyPart = stem;

        int weight = WeightFromText(stem);
        bool italic = Regex.IsMatch(stem, "italic|oblique", RegexOptions.IgnoreCase);
        bool variable = Regex.IsMatch(stem, @"variable|\[.*wght.*\]", RegexOptions.IgnoreCase);

        var (family, opsz) = SplitOpticalSize(familyPart);
        return new Face
        {
            Family = family, OpticalSize = opsz, Italic = italic, Weight = weight, Variable = variable,
            WMin = variable ? 100 : weight, WMax = variable ? 900 : weight,
        };
    }

    /// <summary>"Inter 18pt" -> ("Inter", 18): optical-size cuts are treated as one family.</summary>
    private static (string Family, int? Size) SplitOpticalSize(string family)
    {
        var m = Regex.Match(family, @"^(.*?)[\s_]+(\d+)\s*pt$", RegexOptions.IgnoreCase);
        return m.Success ? (m.Groups[1].Value.Trim(), int.Parse(m.Groups[2].Value)) : (family, null);
    }

    private static int WeightFromText(string text)
    {
        string s = Regex.Replace(text.ToLowerInvariant(), "[^a-z0-9]", "");
        if (Regex.IsMatch(s, "extralight|ultralight")) return 200;
        if (Regex.IsMatch(s, "extrabold|ultrabold")) return 800;
        if (Regex.IsMatch(s, "semibold|demibold")) return 600;
        if (Regex.IsMatch(s, "thin|hairline")) return 100;
        if (Regex.IsMatch(s, "black|heavy")) return 900;
        if (s.Contains("bold")) return 700;
        if (s.Contains("medium")) return 500;
        if (s.Contains("light")) return 300;
        return 400;
    }

    /// <summary>OS/2 weight classes are 1..1000; the app uses 100..900 in steps of 100.</summary>
    private static int SnapWeight(int w) => Math.Clamp((int)Math.Round(w / 100.0) * 100, 100, 900);

    private static int U16(byte[] b, int o) => (b[o] << 8) | b[o + 1];
    private static uint U32(byte[] b, int o) => (uint)((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
    private static double Fixed(byte[] b, int o) => (int)U32(b, o) / 65536.0;
}
