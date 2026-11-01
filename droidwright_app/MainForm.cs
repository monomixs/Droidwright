using System.Diagnostics;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using static Droidwright.NativeMethods;

namespace Droidwright;

/// <summary>
/// The app window. It hosts a WebView2 (Microsoft Edge's engine), serves your "web" folder
/// to it, and gives your JavaScript access to the Bridge (file saving etc).
///
/// CUSTOM TITLE BAR: this is still a normal Windows window (so snapping, the drop shadow,
/// Win+Arrow keys and edge-resizing all keep working) - but Windows is told not to reserve
/// any space for its own title bar. The website's top bar fills that space and draws the
/// minimize / maximize / close buttons itself (web/JS/window-chrome.js). The page asks this
/// class to minimize, maximize, close, drag or resize through the Bridge.
/// </summary>
public class MainForm : Form
{
    // Your site is served at https://droidwright.example/ — a fake address that only exists
    // inside this app (".example" is reserved, so it can never collide with a real website).
    private const string SiteHost = "droidwright.example";

    private static readonly Color LoadingColor = Color.FromArgb(0x11, 0x13, 0x19); // matches your dark UI while loading
    private static readonly Regex HexColor = new("^#[0-9a-fA-F]{6}$", RegexOptions.Compiled);

    private readonly WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = LoadingColor };
    private readonly Bridge _bridge;
    private string _windowState = "";

    // Files Windows asked us to open, waiting until the page says it is ready for them.
    private readonly List<string> _pendingFiles = new();
    private bool _pageReady;

    public MainForm(IEnumerable<string>? filesToOpen = null)
    {
        if (filesToOpen != null) _pendingFiles.AddRange(filesToOpen);
        Text = "Droidwright";
        UseAppIcon();
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = LoadingColor;

        // Smallest the window can be made: 1100 wide x 700 tall. (Only on a screen too small to hold
        // that is it trimmed to the screen, so the window can never be bigger than the display.)
        Rectangle work = Screen.FromPoint(Cursor.Position).WorkingArea;
        MinimumSize = new Size(Math.Min(1100, work.Width), Math.Min(700, work.Height));

        // Don't open bigger than the screen (small laptops).
        ClientSize = new Size(Math.Min(1680, work.Width - 60), Math.Min(960, work.Height - 60));

        // Projects and exports live in: Documents\Droidwright\
        string rootDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Droidwright");
        _bridge = new Bridge(rootDir) { Host = this };

        Controls.Add(_web);
        Load += async (_, _) => await InitWebAsync();
    }

    /// <summary>
    /// The icon shown in the taskbar and Alt+Tab. Loads app.ico (the same file the .exe uses, see
    /// Droidwright.csproj) from next to the exe. Loading the file itself, rather than the exe's
    /// icon, keeps every size inside it, so Windows can pick a sharp one at any display scaling.
    /// No app.ico = the default Windows icon, nothing breaks.
    /// </summary>
    private void UseAppIcon()
    {
        try
        {
            string path = Path.Combine(AppContext.BaseDirectory, "app.ico");
            if (File.Exists(path)) Icon = new Icon(path);
        }
        catch { /* a bad icon file must never stop the app from starting */ }
    }

    // ============================================================================
    //  Files Windows asks us to open
    // ============================================================================

    /// <summary>Called by the pipe listener (a background thread) when another Droidwright was started with a file.</summary>
    internal void OpenFilesFromOtherProcess(string[] paths) =>
        Post(() => OpenFiles(ExternalFiles.FromArguments(paths)));

    internal void OpenFiles(IEnumerable<string> paths)
    {
        _pendingFiles.AddRange(paths);
        BringToFrontNow();
        if (_pageReady) DeliverPendingFiles();
    }

    private void DeliverPendingFiles()
    {
        if (_web.CoreWebView2 is null) return;
        var files = _pendingFiles.ToArray();
        _pendingFiles.Clear();
        foreach (string path in files)
            _web.CoreWebView2.PostWebMessageAsJson(ExternalFiles.ToMessage(path));
    }

    private void BringToFrontNow()
    {
        if (!IsHandleCreated || IsDisposed) return;
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        try { SetForegroundWindow(Handle); } catch { /* the taskbar button will flash instead */ }
        Activate();
    }

    // ============================================================================
    //  Requests from the page that take time (e.g. downloading a Google font)
    // ============================================================================
    //  A normal Bridge call blocks the window until it returns. For anything that waits on the
    //  internet that would freeze the app, so the page sends a message instead:
    //      { kind: "request", id, op, args }   ->  we do the work in the background  ->
    //      { kind: "reply",   id, ok, result | error }   which settles the page's promise.

    private async void OnWebMessage(object? sender, Microsoft.Web.WebView2.Core.CoreWebView2WebMessageReceivedEventArgs e)
    {
        string id = "";
        try
        {
            using JsonDocument doc = JsonDocument.Parse(e.WebMessageAsJson);
            JsonElement root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("kind", out JsonElement kind)) return;

            if (kind.GetString() == "ready")                    // the page has started: it can now be given files to open
            {
                _pageReady = true;
                DeliverPendingFiles();
                return;
            }
            if (kind.GetString() != "request") return;

            id = root.GetProperty("id").GetString() ?? "";
            string op = root.GetProperty("op").GetString() ?? "";
            JsonElement args = root.TryGetProperty("args", out JsonElement a) ? a.Clone() : default;

            string result = await _bridge.HandleRequestAsync(op, args);   // continues here, on the window's thread
            Reply(id, true, result, null);
        }
        catch (Exception ex)
        {
            if (id.Length > 0) Reply(id, false, null, FriendlyError(ex));
        }
    }

    private void Reply(string id, bool ok, string? result, string? error)
    {
        if (IsDisposed || _web.CoreWebView2 is null) return;
        _web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { kind = "reply", id, ok, result, error }));
    }

    private static string FriendlyError(Exception ex) => ex switch
    {
        OperationCanceledException => "the connection timed out",
        HttpRequestException h when h.StatusCode is null => "no internet connection, or Google can't be reached",
        HttpRequestException h => "the font service answered with an error (" + (int)h.StatusCode! + ")",
        _ => ex.Message,
    };

    // ============================================================================
    //  Custom title bar support
    // ============================================================================

    /// <summary>
    /// Windows normally reserves a strip at the top of the window for its title bar. Here we let
    /// it calculate the usual frame (which keeps the invisible resize borders on the left, right
    /// and bottom), then hand the title-bar strip back to the page. Result: the website's top
    /// bar sits at the very top of the window and there is no white Windows title bar.
    /// </summary>
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
        {
            // First RECT in NCCALCSIZE_PARAMS: left(+0) top(+4) right(+8) bottom(+12).
            int windowTop = Marshal.ReadInt32(m.LParam, 4);
            base.WndProc(ref m);                       // Windows' normal client area...
            int top = windowTop;                       // ...but starting at the very top
            if (IsZoomed(m.HWnd))
                top += ResizeFrameThickness(m.HWnd);   // a maximized window overhangs the screen by the frame width
            Marshal.WriteInt32(m.LParam, 4, top);
            return;
        }
        base.WndProc(ref m);
    }

    private static int ResizeFrameThickness(IntPtr hwnd)
    {
        uint dpi = GetDpiForWindow(hwnd);
        if (dpi == 0) dpi = 96;
        return GetSystemMetricsForDpi(SM_CYSIZEFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
    }

    /// <summary>Runs on the UI thread, and never lets a window-chrome hiccup crash the app.</summary>
    private void Post(Action action)
    {
        if (!IsHandleCreated || IsDisposed) return;
        BeginInvoke(() =>
        {
            try { action(); }
            catch (Exception ex) { Debug.WriteLine("Window action failed: " + ex.Message); }
        });
    }

    /// <summary>Runs something on the window's own thread and returns its result (dialogs and the
    /// clipboard must be used from there). If we're already on it, just runs it.</summary>
    internal T OnUi<T>(Func<T> action) => InvokeRequired ? (T)Invoke(action)! : action();

    internal void Minimize() => Post(() => WindowState = FormWindowState.Minimized);

    internal void ToggleMaximize() => Post(() =>
        WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized);

    internal void CloseWindow() => Post(Close);

    /// <summary>Called when the user presses the mouse on the page's top bar and starts dragging.</summary>
    internal void BeginDrag() => Post(() =>
    {
        if (!MouseIsDown()) return;                    // already let go - don't start a drag that sticks to the cursor
        if (WindowState == FormWindowState.Maximized) RestoreUnderCursor();
        ReleaseCapture();                              // the web page currently "owns" the mouse
        SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, CursorLParam());
    });

    /// <summary>Resize from the very top edge / top-left corner (the page can't be covered by a native border there).</summary>
    internal void BeginResize(string edge) => Post(() =>
    {
        if (WindowState != FormWindowState.Normal || !MouseIsDown()) return;
        int hit = edge switch
        {
            "top" => HTTOP,
            "topleft" => HTTOPLEFT,
            "topright" => HTTOPRIGHT,
            _ => 0,
        };
        if (hit == 0) return;
        ReleaseCapture();
        SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)hit, CursorLParam());
    });

    /// <summary>The page tells us its background colour so resizing never flashes a mismatched colour.</summary>
    internal void SetChromeColor(string hex) => Post(() =>
    {
        if (hex is not null && HexColor.IsMatch(hex)) BackColor = ColorTranslator.FromHtml(hex);
    });

    internal string WindowStateName => string.IsNullOrEmpty(_windowState) ? "normal" : _windowState;

    private static bool MouseIsDown() =>
        (Control.MouseButtons & (MouseButtons.Left | MouseButtons.Right)) != MouseButtons.None;

    private static IntPtr CursorLParam()
    {
        Point p = Cursor.Position; // screen coordinates, packed as Windows expects
        return (IntPtr)(((p.Y & 0xFFFF) << 16) | (p.X & 0xFFFF));
    }

    /// <summary>Dragging a maximized window pulls it back to its normal size, under the cursor.</summary>
    private void RestoreUnderCursor()
    {
        Point cursor = Cursor.Position;
        Rectangle work = Screen.FromPoint(cursor).WorkingArea;
        double along = Math.Clamp((cursor.X - work.Left) / (double)Math.Max(1, work.Width), 0, 1);
        int down = Math.Clamp(cursor.Y - work.Top, 0, LogicalToDeviceUnits(28));

        WindowState = FormWindowState.Normal;
        Location = new Point(cursor.X - (int)(Width * along), cursor.Y - down);
    }

    /// <summary>Keeps the page's maximize/restore icon in sync with the real window.</summary>
    protected override void OnSizeChanged(EventArgs e)
    {
        base.OnSizeChanged(e);

        string state = WindowState switch
        {
            FormWindowState.Maximized => "maximized",
            FormWindowState.Minimized => "minimized",
            _ => "normal",
        };
        if (state == _windowState) return;
        _windowState = state;

        try { _web.CoreWebView2?.PostWebMessageAsJson($"{{\"type\":\"window-state\",\"state\":\"{state}\"}}"); }
        catch { /* page not ready yet - it asks for the state itself once it loads */ }
    }

    private async Task InitWebAsync()
    {
        try
        {
            // The browser's own data (localStorage, cache) lives here, NOT next to the exe,
            // so it still works when the app is installed somewhere read-only.
            string userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Droidwright", "WebView2");

            var env = await CoreWebView2Environment.CreateAsync(null, userData);
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Droidwright needs the Microsoft Edge WebView2 Runtime.\n\n" +
                "Install it from:\nhttps://developer.microsoft.com/microsoft-edge/webview2/\n\n" +
                "Details: " + ex.Message,
                "Droidwright", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }

        CoreWebView2 core = _web.CoreWebView2;

        // Serve the "web" folder (copied next to the exe) as the website.
        string webRoot = Path.Combine(AppContext.BaseDirectory, "web");
        core.SetVirtualHostNameToFolderMapping(
            SiteHost, webRoot, CoreWebView2HostResourceAccessKind.Allow);

        // Makes `window.chrome.webview.hostObjects.bridge` available to your JavaScript.
        core.AddHostObjectToScript("bridge", _bridge);
        core.WebMessageReceived += OnWebMessage;      // slow requests (downloads) arrive as messages

        core.Settings.IsStatusBarEnabled = false;

        // The browser's own right-click menu (Back / Refresh / Inspect...) never shows. The page draws
        // its own menus where they make sense (see web/JS/context-menus.js).
        core.Settings.AreDefaultContextMenusEnabled = false;
#if DEBUG
        core.Settings.AreDevToolsEnabled = true;               // F12 works while developing
        core.Settings.AreBrowserAcceleratorKeysEnabled = true;
#else
        core.Settings.AreDevToolsEnabled = false;              // feels like a real app in release
        core.Settings.AreBrowserAcceleratorKeysEnabled = false; // no F5 / Ctrl+P / Ctrl+F browser stuff
#endif

        // Security: the window may only ever show YOUR site. Anything else opens in the
        // user's normal browser instead, so a stray link can never get the file bridge.
        core.NavigationStarting += (_, e) =>
        {
            if (!IsAllowedNavigation(e.Uri))
            {
                e.Cancel = true;
                OpenInBrowser(e.Uri);
            }
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true; // never open a second app window
            OpenInBrowser(e.Uri);
        };

        // Any file your site downloads (SVG, XML, PNG...) goes straight into
        // Documents\Droidwright\Exports with no "Save as" dialog.
        core.DownloadStarting += (_, e) =>
        {
            string suggested = Path.GetFileName(e.ResultFilePath);
            e.ResultFilePath = Bridge.UniquePath(_bridge.ExportsDir, suggested);
            // Want NO download popup at all? Uncomment the next line:
            // e.Handled = true;
        };

        core.Navigate($"https://{SiteHost}/index.html");
    }

    private static bool IsAllowedNavigation(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out Uri? u)) return false;
        if (u.Scheme is "about" or "blob" or "data") return true;
        return u.Scheme == Uri.UriSchemeHttps &&
               u.Host.Equals(SiteHost, StringComparison.OrdinalIgnoreCase);
    }

    private static void OpenInBrowser(string uri)
    {
        if (Uri.TryCreate(uri, UriKind.Absolute, out Uri? u) &&
            (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps))
        {
            Process.Start(new ProcessStartInfo { FileName = u.AbsoluteUri, UseShellExecute = true });
        }
    }
}
