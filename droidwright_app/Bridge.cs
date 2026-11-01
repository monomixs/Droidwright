using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;

namespace Droidwright;

/// <summary>
/// What your JavaScript can call. Every public method here becomes callable from the page as:
///     await window.chrome.webview.hostObjects.bridge.MethodName(args)
/// Everything takes and returns plain strings (JSON where there's structure). On failure a
/// method returns a string starting with "ERROR:" instead of crashing.
/// SECURITY: all file access is limited to the Projects and Exports folders below.
/// </summary>
[ClassInterface(ClassInterfaceType.AutoDual)]
[ComVisible(true)]
public class Bridge
{
    private string _rootDir = "";
    private string _projectsDir = "";
    private string _exportsDir = "";
    private readonly string _defaultRoot;
    private Task<string> _fonts;                // the font folders are scanned in the background at launch (and again after fonts are added)
    private readonly string _webRoot;

    // Remembers the folder the user picked in setup, across launches.
    private static readonly string ConfigPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Droidwright", "config.json");

    /// <summary>Fonts the user added ("Add font..."): %LocalAppData%\Droidwright\Fonts\My Fonts\...
    /// Kept apart from the save folder so changing that never loses them.</summary>
    // ---------------------------------------------------- "Open with Droidwright" (Windows)
    // Registered at startup (per user, no admin rights) unless the user switched it off in Settings.

    private FileAssociation? _association;
    /// <summary>Where the registration goes. Replaced by a fake in tests.</summary>
    internal static Func<IRegistryStore> RegistryFactory = () => new WindowsRegistry();
    private FileAssociation Association => _association ??= new FileAssociation(RegistryFactory(), Environment.ProcessPath ?? "");

    private static bool AssociationEnabled => !ReadConfig().TryGetValue("fileAssociation", out string? v) || v != "off";

    /// <summary>Makes the registration match the setting. Quietly does nothing if it fails (e.g. a locked-down PC).</summary>
    internal void ApplyFileAssociation()
    {
        try
        {
            if (string.IsNullOrEmpty(Environment.ProcessPath)) return;
            if (AssociationEnabled) { if (!Association.IsRegistered()) { Association.Register(); NotifyShell(); } }
        }
        catch (Exception ex) { Debug.WriteLine("File association failed: " + ex.Message); }
    }

    private static void NotifyShell()
    {
        try { NativeMethods.SHChangeNotify(NativeMethods.SHCNE_ASSOCCHANGED, 0, IntPtr.Zero, IntPtr.Zero); } catch { /* cosmetic */ }
    }

    /// <summary>"true" if Droidwright is listed in Windows' "Open with" for .svg and .xml.</summary>
    public string GetFileAssociation() => Try(() => (AssociationEnabled && Association.IsRegistered()) ? "true" : "false");

    /// <summary>Turns the registration on or off (and remembers the choice). Returns the new state.</summary>
    public string SetFileAssociation(bool enable) => Try(() =>
    {
        var config = ReadConfig();
        config["fileAssociation"] = enable ? "on" : "off";
        WriteConfig(config);
        if (enable) Association.Register(); else Association.Unregister();
        NotifyShell();
        return Association.IsRegistered() ? "true" : "false";
    });

    /// <summary>Windows' "Default apps" page, where the user can make Droidwright the default for .svg / .xml.</summary>
    public string OpenDefaultAppsSettings() => Try(() =>
    {
        Process.Start(new ProcessStartInfo("ms-settings:defaultapps") { UseShellExecute = true });
        return "ok";
    });

    internal static string UserFontsDir => Path.Combine(Path.GetDirectoryName(ConfigPath)!, "Fonts");

    // internal = NOT visible to JavaScript
    internal string ExportsDir => _exportsDir;

    /// <summary>The app window (set by MainForm). Used by the Window* methods below.</summary>
    internal MainForm? Host { get; set; }

    public Bridge(string defaultRootDir)
    {
        _defaultRoot = defaultRootDir;
        _webRoot = Path.Combine(AppContext.BaseDirectory, "web");
        _fonts = StartFontScan();                                     // ready long before the page asks for it
        _ = Task.Run(ApplyFileAssociation);                           // "Open with Droidwright" for .svg / .xml
        string root = defaultRootDir;
        try
        {
            if (File.Exists(ConfigPath))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(ConfigPath));
                if (doc.RootElement.TryGetProperty("rootDir", out var el) &&
                    el.GetString() is { Length: > 0 } saved && Path.IsPathRooted(saved))
                    root = saved;
            }
        }
        catch { /* corrupt config: fall back to the default folder */ }

        try { UseRoot(root); }
        catch { UseRoot(defaultRootDir); } // saved folder gone / drive unplugged
    }

    /// <summary>Points the app at a root folder and makes sure Projects\ and Exports\ exist inside it.</summary>
    private void UseRoot(string root)
    {
        string full = Path.GetFullPath(root);
        string projects = Path.Combine(full, "Projects");
        string exports = Path.Combine(full, "Exports");
        Directory.CreateDirectory(projects);
        Directory.CreateDirectory(exports);
        _rootDir = full;
        _projectsDir = projects;
        _exportsDir = exports;
    }

    // ---------------------------------------------------------------- info

    /// <summary>Returns {"root":"...","projects":"...","exports":"..."} — the folder paths.</summary>
    public string GetPaths() => Try(() =>
        JsonSerializer.Serialize(new
        {
            root = _rootDir, projects = _projectsDir, exports = _exportsDir,
            defaultRoot = _defaultRoot,
            isDefault = SamePath(_rootDir, _defaultRoot),
        }));

    /// <summary>Shows Windows' folder picker. Returns the chosen path, or "" if cancelled.</summary>
    public string PickFolder() => Try(() =>
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Choose where Droidwright saves your exports",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = true,
            InitialDirectory = _rootDir,
        };
        return dialog.ShowDialog(Form.ActiveForm) == DialogResult.OK ? dialog.SelectedPath : "";
    });

    /// <summary>Switches to a new root folder (creating Projects\ and Exports\ in it) and remembers it.
    /// Returns the folder's full path. Existing files are not moved.</summary>
    public string SetRootFolder(string path) => Try(() => ApplyRoot(path));

    /// <summary>Same as SetRootFolder, and optionally COPIES what is already in the old folder across
    /// (nothing is deleted from the old folder, and files that already exist are left alone).
    /// Returns {"root":"...","copied":3}.</summary>
    public string ChangeRootFolder(string path, bool copyExisting) => Try(() =>
    {
        string oldProjects = _projectsDir, oldExports = _exportsDir, oldRoot = _rootDir;
        string newRoot = ApplyRoot(path);

        int copied = 0;
        if (copyExisting && !SamePath(oldRoot, newRoot))
            copied = CopyMissing(oldProjects, _projectsDir) + CopyMissing(oldExports, _exportsDir);

        return JsonSerializer.Serialize(new { root = newRoot, copied });
    });

    /// <summary>Goes back to the default folder (Documents\Droidwright). Returns its path.</summary>
    public string ResetRootFolder() => Try(() =>
    {
        UseRoot(_defaultRoot);
        var config = ReadConfig();
        config.Remove("rootDir");
        WriteConfig(config);
        return _rootDir;
    });

    private string ApplyRoot(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path))
            throw new ArgumentException("Choose a full folder path.");
        string previous = _rootDir;
        try
        {
            UseRoot(path);

            // Prove we can actually write there before committing to it.
            string probe = Path.Combine(_exportsDir, ".write-test");
            File.WriteAllText(probe, "ok");
            File.Delete(probe);

            var config = ReadConfig();
            config["rootDir"] = _rootDir;
            WriteConfig(config);
        }
        catch
        {
            UseRoot(previous); // don't leave the app pointing at a folder that doesn't work
            throw;
        }
        return _rootDir;
    }

    private static int CopyMissing(string from, string to)
    {
        if (!Directory.Exists(from) || SamePath(from, to)) return 0;
        int copied = 0;
        foreach (string file in Directory.GetFiles(from))
        {
            string target = Path.Combine(to, Path.GetFileName(file));
            if (File.Exists(target)) continue;
            File.Copy(file, target);
            copied++;
        }
        return copied;
    }

    private static bool SamePath(string a, string b) =>
        string.Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(a)),
                      Path.TrimEndingDirectorySeparator(Path.GetFullPath(b)),
                      StringComparison.OrdinalIgnoreCase);

    // The little settings file (in %LocalAppData%\Droidwright) - read and written as a whole so that
    // saving one value never wipes another.
    private static Dictionary<string, string> ReadConfig()
    {
        var config = new Dictionary<string, string>();
        try
        {
            if (!File.Exists(ConfigPath)) return config;
            using var doc = JsonDocument.Parse(File.ReadAllText(ConfigPath));
            foreach (var p in doc.RootElement.EnumerateObject())
                if (p.Value.ValueKind == JsonValueKind.String) config[p.Name] = p.Value.GetString() ?? "";
        }
        catch { /* corrupt file: start fresh */ }
        return config;
    }

    private static void WriteConfig(Dictionary<string, string> config)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(ConfigPath)!);
        File.WriteAllText(ConfigPath, JsonSerializer.Serialize(config));
    }

    /// <summary>Opens "root", "projects" or "exports" in Windows Explorer.</summary>
    public string OpenFolder(string which) => Try(() =>
    {
        string dir = which switch
        {
            "root" => _rootDir,
            "fonts" => EnsureDir(UserFontsDir),
            "projects" => _projectsDir,
            "exports" => _exportsDir,
            _ => throw new ArgumentException("Unknown folder."),
        };
        Process.Start(new ProcessStartInfo { FileName = dir, UseShellExecute = true });
        return "ok";
    });

    // ------------------------------------------------------------ projects

    /// <summary>Everything in the Projects folder, in one call (the app reads it all at startup):
    /// {"projects":[{"file":"My Icon","modified":"...","text":"{...json...}"}], "groups":"{...}",
    ///  "unreadable":["bad.json: reason"], "folder":"C:\\...\\Projects"}
    /// Files whose name starts with "_" are the app's own (the home-screen groups), not projects.</summary>
    public string LoadProjects() => Try(() =>
    {
        var projects = new List<object>();
        var unreadable = new List<string>();
        foreach (FileInfo file in new DirectoryInfo(_projectsDir).GetFiles("*.json").OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase))
        {
            string stem = Path.GetFileNameWithoutExtension(file.Name);
            if (stem.StartsWith('_')) continue;
            try
            {
                if (file.Length > MaxProjectFileBytes) throw new IOException("larger than 100 MB");
                projects.Add(new { file = stem, modified = file.LastWriteTimeUtc.ToString("o"), text = File.ReadAllText(file.FullName, Encoding.UTF8) });
            }
            catch (Exception ex) { unreadable.Add(file.Name + ": " + ex.Message); }
        }

        string groups = "";
        string groupsPath = Path.Combine(_projectsDir, GroupsFileName + ".json");
        try { if (File.Exists(groupsPath)) groups = File.ReadAllText(groupsPath, Encoding.UTF8); } catch { /* optional */ }

        return JsonSerializer.Serialize(new { projects, groups, unreadable, folder = _projectsDir });
    });

    private const string GroupsFileName = "_groups";
    private const long MaxProjectFileBytes = 100 * 1024 * 1024;

    /// <summary>JSON list: [{"id":"...","modified":1700000000000,"size":1234}, ...] newest first.</summary>
    public string ListProjects() => Try(() =>
    {
        var items = new DirectoryInfo(_projectsDir).GetFiles("*.json")
            .OrderByDescending(f => f.LastWriteTimeUtc)
            .Select(f => new
            {
                id = Path.GetFileNameWithoutExtension(f.Name),
                modified = new DateTimeOffset(f.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
                size = f.Length,
            })
            .ToList();
        return JsonSerializer.Serialize(items);
    });

    /// <summary>Returns the project's JSON text, or "" if it doesn't exist.</summary>
    public string ReadProject(string id) => Try(() =>
    {
        string path = ProjectPath(id);
        return File.Exists(path) ? File.ReadAllText(path, Encoding.UTF8) : "";
    });

    /// <summary>Saves a project (id = file name, json = its content). Safe against crashes mid-save.</summary>
    public string SaveProject(string id, string json) => Try(() =>
    {
        if (json is null || json.Length > 50_000_000) throw new ArgumentException("Project is empty or too large.");
        WriteAtomic(ProjectPath(id), Utf8NoBom.GetBytes(json));
        return "ok";
    });

    public string DeleteProject(string id) => Try(() =>
    {
        string path = ProjectPath(id);
        if (File.Exists(path)) File.Delete(path);
        return "ok";
    });

    // ----------------------------------------------------------- workspace
    // "Workspace" mode: the user picks any folder, the app lists every Android vector drawable (.xml) inside it, and
    // edits are written straight back into those files (WriteLinkedFile above). Nothing here copies files anywhere.

    private static readonly HashSet<string> WorkspaceSkipDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", ".gradle", ".idea", "node_modules", "build",     // tool/build output: not the user's own files (build\ holds generated copies)
    };
    private const long MaxWorkspaceFileBytes = 1024 * 1024;       // a vector icon is a few KB; bigger XML is not one
    private const int MaxWorkspaceFiles = 5000;
    private static readonly Regex VectorRoot = new(@"<\s*vector[\s>/]", RegexOptions.Compiled);

    /// <summary>The workspace folder remembered from last time, or "" if there is none (or it no longer exists).</summary>
    public string GetWorkspaceFolder() => Try(() =>
        ReadConfig().TryGetValue("workspaceDir", out string? dir) && Directory.Exists(dir) ? dir : "");

    /// <summary>Shows Windows' folder picker for the workspace. Returns the chosen path, or "" if cancelled.</summary>
    public string PickWorkspaceFolder() => Try(() => OnUi(() =>
    {
        string start = ReadConfig().TryGetValue("workspaceDir", out string? last) && Directory.Exists(last)
            ? last : Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        using var dialog = new FolderBrowserDialog
        {
            Description = "Choose a folder to open as a workspace (subfolders are included)",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = false,
            InitialDirectory = start,
        };
        return dialog.ShowDialog(Host) == DialogResult.OK ? dialog.SelectedPath : "";
    }));

    /// <summary>Remembers the workspace folder (or forgets it when given ""). Returns the full path.</summary>
    public string SetWorkspaceFolder(string path) => Try(() =>
    {
        var config = ReadConfig();
        if (string.IsNullOrWhiteSpace(path)) { config.Remove("workspaceDir"); WriteConfig(config); return ""; }
        string full = ValidWorkspaceFolder(path);
        config["workspaceDir"] = full;
        WriteConfig(config);
        return full;
    });

    private static string ValidWorkspaceFolder(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path)) throw new ArgumentException("Choose a full folder path.");
        string full = Path.GetFullPath(path);
        if (!Directory.Exists(full)) throw new DirectoryNotFoundException("That folder doesn't exist any more.");
        return full;
    }

    /// <summary>Walks the folder (and everything under it) and returns every .xml file that is an Android vector drawable:
    /// {"folder","files":[{"path","rel","name","modified","size","text"}],"skipped","unreadable","truncated"}.
    /// "skipped" = other XML (layouts, manifests...), which can't be edited here. If the token fires (very big folder) the
    /// list so far is returned with truncated = true. Called from a background thread (see HandleRequestAsync).</summary>
    internal static string ScanWorkspace(string folder, CancellationToken ct)
    {
        string root = ValidWorkspaceFolder(folder);
        var files = new List<object>();
        int skipped = 0, unreadable = 0;
        bool truncated = false;

        var pending = new Stack<string>();
        pending.Push(root);
        while (pending.Count > 0 && !truncated)
        {
            if (ct.IsCancellationRequested) { truncated = true; break; }
            string dir = pending.Pop();

            string[] subdirs, xmls;
            try
            {
                subdirs = Directory.GetDirectories(dir);
                xmls = Directory.GetFiles(dir, "*.xml");
            }
            catch { unreadable++; continue; }                     // no permission, vanished...

            foreach (string sub in subdirs)
            {
                try
                {
                    if (WorkspaceSkipDirs.Contains(Path.GetFileName(sub))) continue;
                    if ((File.GetAttributes(sub) & FileAttributes.ReparsePoint) != 0) continue;   // symlinks / junctions: could loop
                    pending.Push(sub);
                }
                catch { unreadable++; }
            }

            foreach (string path in xmls.OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
            {
                if (!ExternalFiles.IsOpenable(path) || !path.EndsWith(".xml", StringComparison.OrdinalIgnoreCase)) continue;  // "*.xml" also matches ".xmlx"
                if (files.Count >= MaxWorkspaceFiles || ct.IsCancellationRequested) { truncated = true; break; }
                try
                {
                    var info = new FileInfo(path);
                    if (info.Length > MaxWorkspaceFileBytes) { skipped++; continue; }
                    string text = File.ReadAllText(path);
                    if (!VectorRoot.IsMatch(text)) { skipped++; continue; }
                    files.Add(new
                    {
                        path,
                        rel = Path.GetRelativePath(root, path),
                        name = Path.GetFileName(path),
                        modified = new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
                        size = info.Length,
                        text,
                    });
                }
                catch { unreadable++; }
            }
        }
        return JsonSerializer.Serialize(new { folder = root, files, skipped, unreadable, truncated });
    }

    /// <summary>Workspace mode: permanently deletes one .xml file. Deliberately narrow: only an existing .xml file that sits
    /// inside the current workspace folder. It does NOT go to the Recycle Bin.</summary>
    public string DeleteWorkspaceFile(string path) => Try(() =>
    {
        if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("No file was given.");
        if (!ReadConfig().TryGetValue("workspaceDir", out string? dir) || string.IsNullOrEmpty(dir)) throw new InvalidOperationException("No workspace folder is open.");
        string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(dir)) + Path.DirectorySeparatorChar;
        string full = Path.GetFullPath(path);
        if (!full.EndsWith(".xml", StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("Only .xml files can be deleted this way.");
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("That file isn't inside the workspace folder.");
        if (!File.Exists(full)) return "ok";                    // already gone: nothing to do
        File.Delete(full);
        return "ok";
    });

    /// <summary>Workspace mode, "New file": creates a new .xml in the root of the workspace folder (never overwrites: a taken
    /// name becomes name_2.xml). Returns the full path of the file that was written.</summary>
    public string CreateWorkspaceFile(string fileName, string content) => Try(() =>
    {
        if (!ReadConfig().TryGetValue("workspaceDir", out string? dir) || !Directory.Exists(dir)) throw new InvalidOperationException("No workspace folder is open.");
        string stem = Path.GetFileNameWithoutExtension(SafeFileName(fileName ?? ""));
        stem = SafeFileName(stem);                                // re-check after dropping ".xml" (e.g. a name that was only ".xml")
        byte[] bytes = Utf8NoBom.GetBytes(content ?? "");
        if (bytes.Length > 20 * 1024 * 1024) throw new InvalidDataException("The result is larger than 20 MB.");
        string path = Path.Combine(Path.GetFullPath(dir), stem + ".xml");
        for (int i = 2; File.Exists(path); i++) path = Path.Combine(Path.GetFullPath(dir), $"{stem}_{i}.xml");
        WriteAtomic(path, bytes);
        return path;
    });

    // ------------------------------------------------------------- exports

    /// <summary>Saves text (SVG, XML...) into the Exports folder. Returns the saved file's full path.</summary>
    public string SaveExport(string fileName, string content) => Try(() =>
    {
        string path = UniquePath(_exportsDir, fileName);
        WriteAtomic(path, Utf8NoBom.GetBytes(content ?? ""));
        return path;
    });

    /// <summary>Saves the page's edits back into a file Droidwright was asked to open (Open with / double-click), so the
    /// original .svg / .xml is updated and not only the project. Deliberately narrow: it only ever REPLACES an existing
    /// .svg or .xml file (never creates a file, never any other type). Returns the full path.</summary>
    public string WriteLinkedFile(string path, string content) => Try(() =>
    {
        if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("No file was given.");
        string full = Path.GetFullPath(path);
        if (!ExternalFiles.IsOpenable(full)) throw new UnauthorizedAccessException("Only .svg and .xml files can be saved this way.");
        if (!File.Exists(full)) throw new FileNotFoundException("The file no longer exists (it was moved, renamed or deleted).");
        byte[] bytes = Utf8NoBom.GetBytes(content ?? "");
        if (bytes.Length > 20 * 1024 * 1024) throw new InvalidDataException("The result is larger than 20 MB.");
        try { WriteAtomic(full, bytes); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // The folder may not allow a temporary file next to it even though the file itself can be written.
            File.WriteAllBytes(full, bytes);
        }
        return full;
    });

    /// <summary>Saves binary data (PNG...) sent as base64 into the Exports folder. Returns the full path.</summary>
    public string SaveExportBase64(string fileName, string base64) => Try(() =>
    {
        string path = UniquePath(_exportsDir, fileName);
        WriteAtomic(path, Convert.FromBase64String(base64));
        return path;
    });

    /// <summary>Shows Windows' "Save as" window, then writes the data (sent as base64) where the user
    /// chose. Returns the saved file's full path, or "" if the user cancelled.</summary>
    public string SaveFileAs(string fileName, string base64) => Try(() =>
    {
        byte[] bytes = Convert.FromBase64String(base64 ?? "");
        string suggested;
        try { suggested = SafeFileName(fileName); } catch { suggested = "export"; }

        string? target = OnUi(() => AskWhereToSave(suggested));
        if (target is null) return "";                       // cancelled

        WriteAtomic(target, bytes);
        var config = ReadConfig();
        config["lastSaveDir"] = Path.GetDirectoryName(target) ?? "";
        try { WriteConfig(config); } catch { /* remembering the folder is a nicety */ }
        return target;
    });

    private string? AskWhereToSave(string suggestedName)
    {
        string ext = Path.GetExtension(suggestedName).TrimStart('.').ToLowerInvariant();
        string startDir = _exportsDir;
        if (ReadConfig().TryGetValue("lastSaveDir", out var last) && Directory.Exists(last)) startDir = last;

        string kind = ext switch
        {
            "svg" => "SVG image",
            "xml" => "Android Vector Drawable",
            "png" => "PNG image",
            "json" => "Droidwright backup",
            _ => ext.ToUpperInvariant() + " file",
        };
        using var dialog = new SaveFileDialog
        {
            Title = "Save export",
            FileName = suggestedName,
            InitialDirectory = startDir,
            Filter = ext.Length > 0 ? $"{kind} (*.{ext})|*.{ext}|All files (*.*)|*.*" : "All files (*.*)|*.*",
            DefaultExt = ext,
            AddExtension = ext.Length > 0,
            OverwritePrompt = true,
            CheckPathExists = true,
            RestoreDirectory = true,
        };
        return dialog.ShowDialog(Host) == DialogResult.OK ? dialog.FileName : null;
    }

    // --------------------------------------------------------------- fonts

    private Task<string> StartFontScan()
    {
        string webRoot = _webRoot, userDir = UserFontsDir;
        return Task.Run(() => FontCatalog.ScanToJson(webRoot, userDir));
    }

    private static string EnsureDir(string dir)
    {
        Directory.CreateDirectory(dir);
        return dir;
    }

    /// <summary>Every font the app can use offline, as JSON (see FontCatalog.cs): the built-in web\Fonts
    /// folder plus the fonts the user added.</summary>
    public string ListFonts() => Try(() => _fonts.GetAwaiter().GetResult());

    /// <summary>Same, but looks at the folders again (after fonts were added).</summary>
    public string RefreshFonts() => Try(() =>
    {
        _fonts = StartFontScan();
        return _fonts.GetAwaiter().GetResult();
    });

    /// <summary>"Add font...": shows Windows' file picker and copies the chosen fonts into the app.
    /// Returns {"added":["Family", ...],"skipped":[{"name":"...","reason":"..."}]}  (both empty if cancelled).</summary>
    public string PickFontFiles() => Try(() =>
    {
        string[]? picked = OnUi(() =>
        {
            using var dialog = new OpenFileDialog
            {
                Title = "Add fonts",
                Filter = "Font files (*.ttf;*.otf;*.woff)|*.ttf;*.otf;*.woff|All files (*.*)|*.*",
                Multiselect = true,
                CheckFileExists = true,
                RestoreDirectory = true,
            };
            return dialog.ShowDialog(Host) == DialogResult.OK ? dialog.FileNames : null;
        });
        return picked is null
            ? JsonSerializer.Serialize(new { added = Array.Empty<string>(), skipped = Array.Empty<object>() })
            : AddFontFiles(picked);
    });

    private const long MaxCustomFontBytes = 50 * 1024 * 1024;

    /// <summary>Copies font files into the "My Fonts" category. Anything that can't be used is reported, not hidden.</summary>
    internal string AddFontFiles(IEnumerable<string> paths)
    {
        string dir = EnsureDir(Path.Combine(UserFontsDir, FontCatalog.CustomCategory));
        var added = new List<string>();
        var skipped = new List<object>();

        foreach (string path in paths)
        {
            string name = Path.GetFileName(path);
            try
            {
                string ext = Path.GetExtension(path).ToLowerInvariant();
                if (ext == ".woff2") { skipped.Add(new { name, reason = "WOFF2 fonts can't be turned into text outlines. Choose the .ttf or .otf version." }); continue; }
                if (ext is not (".ttf" or ".otf" or ".woff")) { skipped.Add(new { name, reason = "Only .ttf, .otf and .woff fonts can be added." }); continue; }

                var info = new FileInfo(path);
                if (!info.Exists) { skipped.Add(new { name, reason = "The file couldn't be found." }); continue; }
                if (info.Length > MaxCustomFontBytes) { skipped.Add(new { name, reason = "That file is larger than 50 MB." }); continue; }
                if (!FontCatalog.LooksLikeFont(path)) { skipped.Add(new { name, reason = "This doesn't look like a valid font file." }); continue; }

                string target = Path.Combine(dir, SafeFileName(name));
                if (File.Exists(target))
                {
                    if (new FileInfo(target).Length == info.Length) { skipped.Add(new { name, reason = "Already added." }); continue; }
                    target = UniquePath(dir, Path.GetFileName(target));    // same name, different font: keep both
                }
                File.Copy(path, target);
                added.Add(FontCatalog.FamilyOf(target));
            }
            catch (Exception ex)
            {
                skipped.Add(new { name, reason = ex.Message });
            }
        }

        if (added.Count > 0) _fonts = StartFontScan();
        return JsonSerializer.Serialize(new { added = added.Distinct().ToList(), skipped });
    }

    /// <summary>Reads a custom font ("user:My Fonts/x.ttf") and returns it as base64.</summary>
    public string ReadFontFile(string url) => Try(() =>
    {
        const string prefix = "user:";
        if (url is null || !url.StartsWith(prefix)) throw new ArgumentException("That isn't a custom font.");

        string root = Path.GetFullPath(UserFontsDir) + Path.DirectorySeparatorChar;
        string full = Path.GetFullPath(Path.Combine(root, url[prefix.Length..].Replace('/', Path.DirectorySeparatorChar)));
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("That path isn't allowed.");   // no ..\ tricks
        string ext = Path.GetExtension(full).ToLowerInvariant();
        if (ext is not (".ttf" or ".otf" or ".woff")) throw new ArgumentException("That isn't a font file.");
        if (new FileInfo(full).Length > MaxCustomFontBytes) throw new IOException("That font file is too large.");
        return Convert.ToBase64String(File.ReadAllBytes(full));
    });

    /// <summary>Answers requests that take time (downloads). MainForm calls this off the window's message
    /// loop, so the window never freezes while Google is being contacted.</summary>
    internal async Task<string> HandleRequestAsync(string op, JsonElement args)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(40));
        switch (op)
        {
            case "googleFontsList":
                return await GoogleFonts.ListJsonAsync(timeout.Token);

            case "googleFontFile":
            {
                string family = args.GetProperty("family").GetString() ?? "";
                int weight = (int)Math.Round(args.GetProperty("weight").GetDouble());
                bool italic = args.TryGetProperty("italic", out JsonElement it) && it.ValueKind == JsonValueKind.True;
                byte[] bytes = await GoogleFonts.FontFileAsync(family, weight, italic, timeout.Token);
                return Convert.ToBase64String(bytes);
            }

            case "scanWorkspace":
            {
                string folder = args.GetProperty("folder").GetString() ?? "";
                return await Task.Run(() => ScanWorkspace(folder, timeout.Token));   // off the window's thread: a big folder must not freeze the app
            }

            default:
                throw new ArgumentException("Unknown request: " + op);
        }
    }

    // ----------------------------------------------------------- clipboard
    // Used by the app's own right-click text menu (copy / cut / paste), so pasting never triggers
    // a browser permission prompt.

    public string GetClipboardText() => Try(() =>
        OnUi(() => Clipboard.ContainsText() ? Clipboard.GetText() : ""));

    public string SetClipboardText(string text) => Try(() =>
        OnUi(() => { if (!string.IsNullOrEmpty(text)) Clipboard.SetText(text); return "ok"; }));

    /// <summary>Runs on the window's own thread (dialogs and the clipboard must).</summary>
    private T OnUi<T>(Func<T> action) => Host is null ? action() : Host.OnUi(action);

    // -------------------------------------------------------------- window
    // The website draws its own title bar (minimize / maximize / close buttons, drag area),
    // and asks the real window to do the work through these.

    public string WindowMinimize() => Try(() => { Host?.Minimize(); return "ok"; });

    public string WindowToggleMaximize() => Try(() => { Host?.ToggleMaximize(); return "ok"; });

    public string WindowClose() => Try(() => { Host?.CloseWindow(); return "ok"; });

    /// <summary>Starts moving the window with the mouse (call while the button is held down).</summary>
    public string WindowStartDrag() => Try(() => { Host?.BeginDrag(); return "ok"; });

    /// <summary>Starts resizing from "top" or "topleft" (the other edges are handled by Windows itself).</summary>
    public string WindowStartResize(string edge) => Try(() => { Host?.BeginResize(edge); return "ok"; });

    /// <summary>"normal", "maximized" or "minimized".</summary>
    public string GetWindowState() => Try(() => Host?.WindowStateName ?? "normal");

    /// <summary>Tells the window which colour the page's background is, e.g. "#111319".</summary>
    public string SetChromeColor(string hex) => Try(() => { Host?.SetChromeColor(hex); return "ok"; });

    // ------------------------------------------------------------- helpers

    private static readonly UTF8Encoding Utf8NoBom = new(false);

    private static string Try(Func<string> action)
    {
        try { return action(); }
        catch (Exception ex) { return "ERROR: " + ex.Message; }
    }

    private string ProjectPath(string id)
    {
        string path = Path.GetFullPath(Path.Combine(_projectsDir, SafeFileName(id) + ".json"));
        // Belt and braces: even after cleaning the name, refuse anything outside the folder.
        if (!path.StartsWith(_projectsDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("Path is outside the projects folder.");
        return path;
    }

    private static readonly HashSet<string> ReservedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    /// <summary>Strips slashes, "..", illegal characters and Windows reserved names.</summary>
    private static string SafeFileName(string name)
    {
        char[] invalid = Path.GetInvalidFileNameChars();
        string cleaned = new string((name ?? "").Where(c => !invalid.Contains(c)).ToArray())
            .Trim().TrimEnd('.', ' ');
        if (cleaned.Length > 150) cleaned = cleaned[..150];
        if (cleaned.Length == 0 || ReservedNames.Contains(Path.GetFileNameWithoutExtension(cleaned)))
            throw new ArgumentException("Invalid file name.");
        return cleaned;
    }

    /// <summary>"icon.svg" -> "icon.svg", or "icon (2).svg" if that already exists.</summary>
    internal static string UniquePath(string dir, string fileName)
    {
        string safe;
        try { safe = SafeFileName(fileName); } catch { safe = "export"; }
        string stem = Path.GetFileNameWithoutExtension(safe);
        string ext = Path.GetExtension(safe);
        string path = Path.Combine(dir, safe);
        for (int i = 2; File.Exists(path); i++)
            path = Path.Combine(dir, $"{stem} ({i}){ext}");
        return path;
    }

    /// <summary>Write to a temp file first, then swap — so a crash can't leave a half-written file.</summary>
    private static void WriteAtomic(string path, byte[] bytes)
    {
        string tmp = path + ".tmp";
        File.WriteAllBytes(tmp, bytes);
        File.Move(tmp, path, overwrite: true);
    }
}