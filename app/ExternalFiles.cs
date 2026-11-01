using System.Text.Json;

namespace Droidwright;

/// <summary>
/// Files Windows asks Droidwright to open (command line / "Open with"). Only .svg and .xml are accepted, and the
/// file is read here and handed to the page as text - the page never gets a path to read from.
/// </summary>
internal static class ExternalFiles
{
    private const long MaxBytes = 20 * 1024 * 1024;

    public static bool IsOpenable(string path) =>
        path.EndsWith(".svg", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".xml", StringComparison.OrdinalIgnoreCase);

    /// <summary>The paths from a command line that can really be opened (full paths, files that exist).</summary>
    public static string[] FromArguments(IEnumerable<string> args)
    {
        var result = new List<string>();
        foreach (string arg in args)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(arg) || arg.StartsWith('-') || !IsOpenable(arg)) continue;
                string full = Path.GetFullPath(arg);
                if (File.Exists(full)) result.Add(full);
            }
            catch { /* a malformed argument is simply not a file */ }
        }
        return result.ToArray();
    }

    /// <summary>The JSON message for the page: {"kind":"open-file","name","path","text"} or {"kind":"open-file-error","name","message"}.
    /// The path lets the page save its edits back into the same file (Bridge.WriteLinkedFile).</summary>
    public static string ToMessage(string path)
    {
        string name = Path.GetFileName(path);
        try
        {
            if (!IsOpenable(path)) throw new InvalidDataException("Droidwright opens .svg and .xml files.");
            var info = new FileInfo(path);
            if (!info.Exists) throw new FileNotFoundException("The file couldn't be found.");
            if (info.Length > MaxBytes) throw new InvalidDataException("That file is larger than 20 MB.");
            return JsonSerializer.Serialize(new { kind = "open-file", name, path, text = File.ReadAllText(path) });   // detects UTF-8 / UTF-16 by its BOM
        }
        catch (Exception ex)
        {
            return JsonSerializer.Serialize(new { kind = "open-file-error", name, message = $"Couldn’t open {name}: {ex.Message}" });
        }
    }
}
