using System.Net.Http;
using System.Threading;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Droidwright;

/// <summary>
/// Google Fonts for the Windows app, with no server in between:
///
///   - the LIST of families (name, category, weights)    -> fonts.google.com
///   - one font FILE at one exact weight                  -> fonts.googleapis.com (the CSS that names
///                                                           the file) and fonts.gstatic.com (the file)
///
/// Everything that is downloaded is kept in %LocalAppData%\Droidwright\FontCache, so a font you used
/// once keeps working with no internet, and the list falls back to "the fonts you already downloaded"
/// when you are offline. Only the three hosts above are ever contacted.
///
/// Google serves a separate, ready-made file for every weight (even for variable families) when asked
/// for one weight at a time, so these never need the variable-font converter.
/// </summary>
internal static class GoogleFonts
{
    private static readonly HashSet<string> AllowedHosts =
        new(StringComparer.OrdinalIgnoreCase) { "fonts.google.com", "fonts.googleapis.com", "fonts.gstatic.com" };

    // Google decides the file format from who is asking. These old browsers only understand TrueType /
    // OpenType, so Google answers with .ttf files - the format the text tool can read. Tried in order.
    private static readonly string[] TrueTypeUserAgents =
    {
        "Mozilla/5.0 (Linux; U; Android 2.2; en-us; Nexus One Build/FRF91) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1",
        "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; en-us) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1",
        "curl/8.4.0",
    };

    private const long MaxFontBytes = 25 * 1024 * 1024;

    private static HttpClient _http = CreateClient(null);
    /// <summary>For tests: where files are cached, and a stand-in for the internet.</summary>
    internal static string? CacheDirOverride;
    internal static void UseHandler(HttpMessageHandler handler) => _http = CreateClient(handler);

    private static HttpClient CreateClient(HttpMessageHandler? handler) =>
        new(handler ?? new HttpClientHandler()) { Timeout = TimeSpan.FromSeconds(20) };

    private static string CacheDir => CacheDirOverride ?? Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Droidwright", "FontCache");
    private static string ListPath => Path.Combine(CacheDir, "google-list.json");
    private static string FilesDir => Path.Combine(CacheDir, "files");

    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    // ------------------------------------------------------------------------------------
    //  The list of families
    // ------------------------------------------------------------------------------------

    internal sealed record Axis(string Tag, double Min, double Max);
    internal sealed record Item(string Family, string Category, List<string> Variants, List<Axis> Axes);

    /// <summary>{ "items": [{family, category, variants, axes}], "offline": false }</summary>
    public static async Task<string> ListJsonAsync(CancellationToken ct = default)
    {
        try
        {
            string raw = await GetStringAsync("https://fonts.google.com/metadata/fonts", null, ct);
            List<Item> items = ConvertMetadata(raw);
            Directory.CreateDirectory(CacheDir);
            File.WriteAllText(ListPath, JsonSerializer.Serialize(new { items }, Json));
            return JsonSerializer.Serialize(new { items, offline = false }, Json);
        }
        catch when (!ct.IsCancellationRequested)
        {
            // No connection, too slow, blocked, or Google changed its answer: offer what was downloaded before.
            HashSet<string> downloaded = DownloadedFamilies();
            List<Item> cached = ReadCachedList().Where(i => downloaded.Contains(i.Family.ToLowerInvariant())).ToList();
            if (cached.Count == 0) throw;
            return JsonSerializer.Serialize(new { items = cached, offline = true }, Json);
        }
    }

    /// <summary>Turns Google's own metadata into the shape the page expects (like Google's Developer API).</summary>
    internal static List<Item> ConvertMetadata(string raw)
    {
        raw = raw.TrimStart();
        if (raw.StartsWith(")]}'")) raw = raw[(raw.IndexOf('\n') + 1)..];      // Google prefixes this JSON with a guard line

        using JsonDocument doc = JsonDocument.Parse(raw);
        if (!doc.RootElement.TryGetProperty("familyMetadataList", out JsonElement list) || list.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("The font service sent an answer Droidwright doesn't understand.");

        var items = new List<Item>();
        foreach (JsonElement f in list.EnumerateArray())
        {
            if (!f.TryGetProperty("family", out JsonElement fam) || fam.GetString() is not { Length: > 0 } family) continue;
            string category = MapCategory(f.TryGetProperty("category", out JsonElement c) ? c.GetString() : null);

            var axes = new List<Axis>();
            if (f.TryGetProperty("axes", out JsonElement ax) && ax.ValueKind == JsonValueKind.Array)
                foreach (JsonElement a in ax.EnumerateArray())
                    if (a.TryGetProperty("tag", out JsonElement t) && a.TryGetProperty("min", out JsonElement mn) && a.TryGetProperty("max", out JsonElement mx))
                        axes.Add(new Axis(t.GetString() ?? "", mn.GetDouble(), mx.GetDouble()));

            // "400" = regular, "400i" = italic, "700" = bold ... (the keys of "fonts")
            var weights = new SortedSet<int>();
            bool italics = false;
            if (f.TryGetProperty("fonts", out JsonElement fonts) && fonts.ValueKind == JsonValueKind.Object)
                foreach (JsonProperty p in fonts.EnumerateObject())
                {
                    bool italic = p.Name.EndsWith('i');
                    if (int.TryParse(p.Name.TrimEnd('i'), out int w)) { weights.Add(w); italics |= italic; }
                }
            // A variable font offers every step along its weight axis, even ones not listed above.
            Axis? wght = axes.FirstOrDefault(a => a.Tag == "wght");
            if (wght != null)
                for (int w = (int)Math.Ceiling(wght.Min / 100) * 100; w <= wght.Max; w += 100) weights.Add(w);
            if (weights.Count == 0) weights.Add(400);

            var variants = new List<string>();
            foreach (int w in weights)
            {
                variants.Add(w == 400 ? "regular" : w.ToString());
                if (italics) variants.Add(w == 400 ? "italic" : w + "italic");
            }
            items.Add(new Item(family, category, variants, axes));
        }
        if (items.Count == 0) throw new InvalidDataException("The font service sent an empty list.");
        return items;
    }

    private static string MapCategory(string? category) =>
        string.IsNullOrWhiteSpace(category) ? "other" : category.Trim().ToLowerInvariant().Replace(' ', '-');

    private static List<Item> ReadCachedList()
    {
        try
        {
            if (!File.Exists(ListPath)) return new List<Item>();
            using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(ListPath));
            return doc.RootElement.GetProperty("items").Deserialize<List<Item>>(Json) ?? new List<Item>();
        }
        catch { return new List<Item>(); }
    }

    // ------------------------------------------------------------------------------------
    //  One font file at one exact weight
    // ------------------------------------------------------------------------------------

    /// <summary>The bytes of a ready-made .ttf at exactly this weight. Cached forever after the first download.</summary>
    public static async Task<byte[]> FontFileAsync(string family, int weight, bool italic, CancellationToken ct = default)
    {
        family = CleanFamily(family);
        weight = Math.Clamp(weight, 1, 1000);

        string cached = CachePath(family, weight, italic);
        if (File.Exists(cached))
        {
            try { return await File.ReadAllBytesAsync(cached, ct); } catch (IOException) { /* fall through and download again */ }
        }

        string familyParam = Uri.EscapeDataString(family).Replace("%20", "+");
        string axis = italic ? $"ital,wght@1,{weight}" : $"wght@{weight}";
        string cssUrl = $"https://fonts.googleapis.com/css2?family={familyParam}:{axis}";

        string? fileUrl = null;
        Exception? lastError = null;
        foreach (string userAgent in TrueTypeUserAgents)
        {
            try
            {
                string css = await GetStringAsync(cssUrl, userAgent, ct);
                fileUrl = PickFontUrl(css);
                if (fileUrl != null) break;
            }
            catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.BadRequest || ex.StatusCode == System.Net.HttpStatusCode.NotFound)
            {
                // Google doesn't have that family / weight / italic: no other browser identity will change that.
                throw new InvalidDataException($"Google Fonts doesn't offer \"{family}\" in weight {weight}{(italic ? " italic" : "")}.");
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { lastError = ex; }
        }
        if (fileUrl == null)
            throw lastError ?? new InvalidDataException($"Google Fonts didn't return a font file Droidwright can use for \"{family}\".");

        byte[] bytes = await GetBytesAsync(fileUrl, ct);
        if (!IsUsableFont(bytes)) throw new InvalidDataException("Google sent a font in a format Droidwright can't use.");

        Directory.CreateDirectory(FilesDir);
        string temp = cached + ".part";
        await File.WriteAllBytesAsync(temp, bytes, ct);
        File.Move(temp, cached, overwrite: true);
        return bytes;
    }

    /// <summary>Picks the file address out of Google's CSS: a .ttf/.otf if there is one, else a .woff.</summary>
    internal static string? PickFontUrl(string css)
    {
        var urls = Regex.Matches(css, @"url\(\s*['""]?(https://fonts\.gstatic\.com/[^'"")\s]+)['""]?\s*\)")
            .Select(m => m.Groups[1].Value).ToList();
        return urls.FirstOrDefault(u => Regex.IsMatch(u, @"\.(ttf|otf)(\?|$)", RegexOptions.IgnoreCase))
            ?? urls.FirstOrDefault(u => Regex.IsMatch(u, @"\.woff(\?|$)", RegexOptions.IgnoreCase));
    }

    internal static bool IsUsableFont(byte[] b) =>
        b.Length > 12 &&
        ((b[0] == 0 && b[1] == 1 && b[2] == 0 && b[3] == 0) ||
         (b[0] == 'O' && b[1] == 'T' && b[2] == 'T' && b[3] == 'O') ||
         (b[0] == 't' && b[1] == 'r' && b[2] == 'u' && b[3] == 'e') ||
         (b[0] == 'w' && b[1] == 'O' && b[2] == 'F' && b[3] == 'F'));       // (not 'wOF2')

    /// <summary>Only letters, digits, spaces and a few symbols: keeps odd text out of web addresses and file names.</summary>
    internal static string CleanFamily(string family)
    {
        family = (family ?? "").Trim();
        if (family.Length is 0 or > 80 || !Regex.IsMatch(family, @"^[\p{L}\p{N} '&.+\-]+$"))
            throw new ArgumentException("That isn't a valid font name.");
        return family;
    }

    private static string CachePath(string family, int weight, bool italic) =>
        Path.Combine(FilesDir, Uri.EscapeDataString(family) + $"__{weight}{(italic ? "i" : "n")}.ttf");

    /// <summary>Lower-case names of the families that have at least one downloaded file.</summary>
    private static HashSet<string> DownloadedFamilies()
    {
        var set = new HashSet<string>();
        if (!Directory.Exists(FilesDir)) return set;
        foreach (string file in Directory.GetFiles(FilesDir, "*.ttf"))
        {
            string name = Path.GetFileNameWithoutExtension(file);
            int cut = name.LastIndexOf("__", StringComparison.Ordinal);
            if (cut > 0) set.Add(Uri.UnescapeDataString(name[..cut]).ToLowerInvariant());
        }
        return set;
    }

    // ------------------------------------------------------------------------------------
    //  The only code that touches the network
    // ------------------------------------------------------------------------------------

    private static void RequireAllowed(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri) || uri.Scheme != Uri.UriSchemeHttps || !AllowedHosts.Contains(uri.Host))
            throw new InvalidOperationException("That address isn't allowed.");
    }

    private static async Task<string> GetStringAsync(string url, string? userAgent, CancellationToken ct)
    {
        RequireAllowed(url);
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        if (userAgent != null) request.Headers.TryAddWithoutValidation("User-Agent", userAgent);
        using HttpResponseMessage response = await _http.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync(ct);
    }

    private static async Task<byte[]> GetBytesAsync(string url, CancellationToken ct)
    {
        RequireAllowed(url);
        using HttpResponseMessage response = await _http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength is > MaxFontBytes) throw new InvalidDataException("That font file is too large.");
        byte[] bytes = await response.Content.ReadAsByteArrayAsync(ct);
        if (bytes.LongLength > MaxFontBytes) throw new InvalidDataException("That font file is too large.");
        return bytes;
    }
}
