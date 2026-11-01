/* Droidwright native bridge — JavaScript side.
   Load this FIRST (before core.js). In a normal browser `NativeBridge.isNative` is false and
   nothing here is used, so the same site still works on the web.

   Usage:
     if (NativeBridge.isNative) {
       await NativeBridge.saveProject('proj_123', projectObject);
       const list = await NativeBridge.listProjects();
     }
*/
(function () {
  const webview = window.chrome && window.chrome.webview;
  const host = webview && webview.hostObjects ? webview.hostObjects.bridge : null;

  // Every bridge method returns a string; failures come back as "ERROR: message".
  async function call(method, ...args) {
    const result = await host[method](...args);
    if (typeof result === 'string' && result.startsWith('ERROR:')) {
      throw new Error(result.slice(6).trim());
    }
    return result;
  }

  // For things that take a while (downloading a font), the app must not freeze the window while it
  // waits. So these are sent as a message; the app works in the background and answers with a
  // message { kind:'reply', id, ok, result | error } that settles the promise returned here.
  const pending = new Map();
  let nextRequestId = 1;
  if (webview) {
    webview.addEventListener('message', (e) => {
      const m = e.data;
      if (!m || m.kind !== 'reply') return;
      const waiting = pending.get(m.id);
      if (!waiting) return;
      pending.delete(m.id);
      clearTimeout(waiting.timer);
      if (m.ok) waiting.resolve(m.result);
      else waiting.reject(new Error(m.error || 'The request failed'));
    });
  }
  function request(op, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!webview) { reject(new Error('Not running inside the Windows app')); return; }
      const id = 'r' + (nextRequestId++);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('timed out')); }, timeoutMs || 45000);
      pending.set(id, { resolve, reject, timer });
      webview.postMessage({ kind: 'request', id, op, args: args || {} });
    });
  }
  const base64ToBuffer = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  };

  window.NativeBridge = {
    isNative: !!host,

    getPaths: async () => JSON.parse(await call('GetPaths')),
    openFolder: (which) => call('OpenFolder', which),            // 'root' | 'projects' | 'exports' | 'fonts'
    pickFolder: () => call('PickFolder'),                        // '' if the user cancels
    setRootFolder: (path) => call('SetRootFolder', path),        // returns the saved full path
    // Switch the save folder; copyExisting=true also copies what's in the old one. -> { root, copied }
    changeRootFolder: async (path, copyExisting) => JSON.parse(await call('ChangeRootFolder', path, !!copyExisting)),
    resetRootFolder: () => call('ResetRootFolder'),              // back to Documents\Droidwright

    listProjects: async () => JSON.parse(await call('ListProjects')),
    readProject: async (id) => {
      const text = await call('ReadProject', id);
      return text ? JSON.parse(text) : null;
    },
    saveProject: (id, projectObject) => call('SaveProject', id, JSON.stringify(projectObject)),
    deleteProject: (id) => call('DeleteProject', id),
    // Used by the project store (project-store.js): every project file at once, and writing one that is already JSON text.
    // loadProjects -> { projects: [{ file, modified, text }], groups, unreadable: [...], folder }
    loadProjects: async () => JSON.parse(await call('LoadProjects')),
    saveProjectText: (file, jsonText) => call('SaveProject', file, jsonText),

    // Workspace mode (workspace.js): a folder of vector drawables that are edited in place.
    getWorkspaceFolder: () => call('GetWorkspaceFolder'),                // '' if none remembered
    pickWorkspaceFolder: () => call('PickWorkspaceFolder'),              // '' if the user cancels
    setWorkspaceFolder: (path) => call('SetWorkspaceFolder', path || ''),   // remembers it; '' forgets it
    deleteWorkspaceFile: (path) => call('DeleteWorkspaceFile', path),   // permanently deletes one .xml inside the workspace
    createWorkspaceFile: (fileName, text) => call('CreateWorkspaceFile', fileName, text),   // new .xml in the workspace folder -> full path
    // -> { folder, files: [{ path, rel, name, modified, size, text }], skipped, unreadable, truncated }
    scanWorkspace: async (folder) => JSON.parse(await request('scanWorkspace', { folder }, 60000)),

    // Tells the app the page is ready to receive files that Windows asked it to open (see open-with.js).
    notifyReady: () => { if (webview) webview.postMessage({ kind: 'ready' }); },

    // "Open with Droidwright" registration in Windows (Settings > Files & Projects)
    getFileAssociation: async () => (await call('GetFileAssociation')) === 'true',
    setFileAssociation: async (on) => (await call('SetFileAssociation', !!on)) === 'true',
    openDefaultAppsSettings: () => call('OpenDefaultAppsSettings'),

    saveExport: (fileName, text) => call('SaveExport', fileName, text),            // returns full path
    saveExportBase64: (fileName, base64) => call('SaveExportBase64', fileName, base64),
    // Saves text back into a file that was opened with Droidwright (see linked-file.js). Only replaces an existing .svg/.xml.
    writeLinkedFile: (path, text) => call('WriteLinkedFile', path, text),
    // Shows Windows' "Save as" window. Returns the saved file's path, or '' if the user cancelled.
    saveFileAs: (fileName, base64) => call('SaveFileAs', fileName, base64),

    // Everything found in the web\Fonts folder (see FontCatalog.cs / fonts.js)
    listFonts: async () => JSON.parse(await call('ListFonts')),
    refreshFonts: async () => JSON.parse(await call('RefreshFonts')),   // same, after fonts were added
    // "Add font..." : shows Windows' file picker, copies the chosen fonts into the app.
    // -> { added: ['Family Name', ...], skipped: [{ name, reason }, ...] }   (both empty if cancelled)
    pickFontFiles: async () => JSON.parse(await call('PickFontFiles')),
    readFontFile: (url) => call('ReadFontFile', url),                   // base64 of a custom font ('user:...')

    // Google Fonts, fetched by the app itself (no server needed) and remembered for offline use.
    // googleFontsList -> { items: [{ family, category, variants, axes }], offline }
    googleFontsList: async () => JSON.parse(await request('googleFontsList', {}, 30000)),
    // -> ArrayBuffer of the font at exactly that weight
    googleFontFile: async (family, weight, italic) => base64ToBuffer(await request('googleFontFile', { family, weight, italic: !!italic }, 45000)),

    // The real Windows clipboard (used by the app's own right-click text menu)
    getClipboardText: () => call('GetClipboardText'),
    setClipboardText: (text) => call('SetClipboardText', text),

    /* ---- the window itself (the site draws its own title bar, see window-chrome.js) ---- */
    windowMinimize: () => call('WindowMinimize'),
    windowToggleMaximize: () => call('WindowToggleMaximize'),
    windowClose: () => call('WindowClose'),
    windowStartDrag: () => call('WindowStartDrag'),               // call while the mouse button is held
    windowStartResize: (edge) => call('WindowStartResize', edge), // 'top' | 'topleft' | 'topright'
    windowState: () => call('GetWindowState'),                    // 'normal' | 'maximized' | 'minimized'
    setChromeColor: (hex) => call('SetChromeColor', hex),         // e.g. '#111319'

    // Messages the app pushes to the page, e.g. { type: 'window-state', state: 'maximized' }.
    onMessage: (callback) => {
      if (webview) webview.addEventListener('message', (e) => callback(e.data));
    },
  };
})();