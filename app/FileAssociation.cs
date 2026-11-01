using System.Runtime.Versioning;
using Microsoft.Win32;

namespace Droidwright;

/// <summary>Where the registration is written. Real Windows registry in the app; a fake one in the tests.</summary>
internal interface IRegistryStore
{
    /// <summary>Sets a value under HKEY_CURRENT_USER\key. name == null is the key's "(Default)" value.</summary>
    void SetValue(string key, string? name, string value);
    /// <summary>A value with no data at all (what Windows uses for the "Open with" list entries).</summary>
    void SetEmptyValue(string key, string name);
    string? GetValue(string key, string? name);
    void DeleteTree(string key);
    void DeleteValue(string key, string name);
}

[SupportedOSPlatform("windows")]
internal sealed class WindowsRegistry : IRegistryStore
{
    public void SetValue(string key, string? name, string value)
    {
        using RegistryKey k = Registry.CurrentUser.CreateSubKey(key, writable: true);
        k.SetValue(name, value, RegistryValueKind.String);
    }

    public void SetEmptyValue(string key, string name)
    {
        using RegistryKey k = Registry.CurrentUser.CreateSubKey(key, writable: true);
        k.SetValue(name, Array.Empty<byte>(), RegistryValueKind.None);
    }

    public string? GetValue(string key, string? name)
    {
        using RegistryKey? k = Registry.CurrentUser.OpenSubKey(key);
        return k?.GetValue(name) as string;
    }

    public void DeleteTree(string key) => Registry.CurrentUser.DeleteSubKeyTree(key, throwOnMissingSubKey: false);

    public void DeleteValue(string key, string name)
    {
        using RegistryKey? k = Registry.CurrentUser.OpenSubKey(key, writable: true);
        k?.DeleteValue(name, throwOnMissingValue: false);
    }
}

/// <summary>
/// Makes Droidwright show up in Windows' "Open with" menu for .svg and .xml files, and in
/// Settings > Apps > Default apps so it can be chosen as the default for them.
///
/// Everything is written under the CURRENT USER's registry (HKCU), so no administrator rights are needed
/// and other users on the PC are not affected. It can be switched off in Settings (that removes it all again).
///
/// Windows 10/11 deliberately do not let an app make itself the default: that choice belongs to the user
/// (right-click a file > Open with > Choose another app > Always, or Settings > Default apps).
/// </summary>
internal sealed class FileAssociation
{
    public const string AppName = "Droidwright";
    public const string SvgProgId = "Droidwright.SvgFile";
    public const string XmlProgId = "Droidwright.XmlFile";
    private const string Classes = @"Software\Classes\";
    private const string CapabilitiesKey = @"Software\Droidwright\Capabilities";

    private readonly IRegistryStore _registry;
    private readonly string _exePath;

    public FileAssociation(IRegistryStore registry, string exePath)
    {
        _registry = registry;
        _exePath = exePath;
    }

    private string ExeName => _exePath[(_exePath.LastIndexOfAny(new[] { '\\', '/' }) + 1)..];
    private string AppKey => Classes + "Applications\\" + ExeName;

    /// <summary>"C:\...\Droidwright.exe" "%1"   (Windows replaces %1 with the file that was opened)</summary>
    internal string OpenCommand => $"\"{_exePath}\" \"%1\"";

    /// <summary>True when the registration exists AND points at this copy of the exe (it moves when you rebuild elsewhere).</summary>
    public bool IsRegistered() =>
        string.Equals(_registry.GetValue(AppKey + @"\shell\open\command", null), OpenCommand, StringComparison.OrdinalIgnoreCase)
        && _registry.GetValue(Classes + SvgProgId + @"\shell\open\command", null) == OpenCommand;

    public void EnsureRegistered()
    {
        if (!IsRegistered()) Register();
    }

    public void Register()
    {
        string icon = $"\"{_exePath}\",0";            // the icon embedded in the exe (see app.ico)

        // 1) The app itself: what makes "Droidwright" appear in Open with.
        _registry.SetValue(AppKey, "FriendlyAppName", AppName);
        _registry.SetValue(AppKey + @"\DefaultIcon", null, icon);
        _registry.SetValue(AppKey + @"\shell\open\command", null, OpenCommand);
        _registry.SetValue(AppKey + @"\SupportedTypes", ".svg", "");
        _registry.SetValue(AppKey + @"\SupportedTypes", ".xml", "");

        // 2) One "file type" per extension, so they get their own descriptions in Explorer's menus.
        foreach ((string progId, string description) in new[] { (SvgProgId, "SVG image (Droidwright)"), (XmlProgId, "Android vector XML (Droidwright)") })
        {
            _registry.SetValue(Classes + progId, null, description);
            _registry.SetValue(Classes + progId + @"\DefaultIcon", null, icon);
            _registry.SetValue(Classes + progId + @"\shell\open", null, "Open with Droidwright");
            _registry.SetValue(Classes + progId + @"\shell\open\command", null, OpenCommand);
        }
        _registry.SetEmptyValue(Classes + @".svg\OpenWithProgids", SvgProgId);
        _registry.SetEmptyValue(Classes + @".xml\OpenWithProgids", XmlProgId);

        // 3) Lets Droidwright be picked in Settings > Default apps (choose defaults by file type).
        _registry.SetValue(CapabilitiesKey, "ApplicationName", AppName);
        _registry.SetValue(CapabilitiesKey, "ApplicationDescription", "Design Android vector icons");
        _registry.SetValue(CapabilitiesKey + @"\FileAssociations", ".svg", SvgProgId);
        _registry.SetValue(CapabilitiesKey + @"\FileAssociations", ".xml", XmlProgId);
        _registry.SetValue(@"Software\RegisteredApplications", AppName, CapabilitiesKey);
    }

    /// <summary>Removes everything Register() wrote (and nothing else).</summary>
    public void Unregister()
    {
        _registry.DeleteTree(AppKey);
        _registry.DeleteTree(Classes + SvgProgId);
        _registry.DeleteTree(Classes + XmlProgId);
        _registry.DeleteValue(Classes + @".svg\OpenWithProgids", SvgProgId);
        _registry.DeleteValue(Classes + @".xml\OpenWithProgids", XmlProgId);
        _registry.DeleteTree(@"Software\Droidwright");
        _registry.DeleteValue(@"Software\RegisteredApplications", AppName);
    }
}
