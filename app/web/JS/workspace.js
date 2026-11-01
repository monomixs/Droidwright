/* =====================================================================================
   Workspace mode

   The home screen has two tabs next to the search bar:

     PROJECT    (default) exactly how the app always worked: icons live in Droidwright's own Projects folder.
     WORKSPACE  you pick a folder on your PC. Droidwright scans it (subfolders included), lists every Android
                vector drawable (.xml) it finds as a card, and edits go straight back into THOSE FILES - the same
                way a text editor saves into the file you opened. Nothing is copied, and nothing is added to
                the Projects folder.

   How saving works: opening a card sets state.sourceFile = { name, path, format:'xml', workspace:true }. The
   existing linked-file machinery (linked-file.js) already knows how to write the drawing back into a file, so
   persistActiveProject() (ui.js) hands over to persistWorkspaceFile() below, which only writes the file.

   Which files are listed: .xml files whose root element is <vector>. Layouts, manifests, strings etc. are counted
   ("N other XML files skipped") but not shown - they can't be opened in an icon editor. Folders named .git,
   .gradle, .idea, node_modules and build are not scanned (see Bridge.ScanWorkspace).

   Only the Windows app can do this (a web page can't write into a folder on your PC).
   ===================================================================================== */
const Workspace = (function () {
  'use strict';

  const nb = () => window.NativeBridge;
  const native = () => !!(nb() && nb().isNative && nb().scanWorkspace);
  const baseDoc = () => ({ tint: '', alpha: 1, autoMirrored: false, backgroundColor: '#1E222B', backgroundEnabled: false, backgroundOpacity: 1, includeBackgroundInExport: true });
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  let folder = '';
  let restored = false;                 // the remembered folder has been asked for
  let entries = [];                      // card-ready "projects": { id, workspace:true, path, rel, dir, fileName, name, doc, shapes, warnings, updatedAt, bytes }
  let cache = new Map();                 // path -> { key, entry }: a file that hasn't changed isn't parsed again
  let scan = { running: false, done: false, error: '', other: 0, unreadable: 0, truncated: false, at: 0 };
  let token = 0;

  const toast = (m) => { try { showToast(m); } catch (e) { console.warn(m); } };
  const inWorkspace = () => homeState.mode === 'workspace';
  const homeShowing = () => document.body.classList.contains('home-visible');
  const redraw = () => { if (inWorkspace() && homeShowing()) renderHome(); };

  const stemOf = (fileName) => String(fileName).replace(/\.xml$/i, '');
  const dirOf = (rel) => { const i = String(rel).replace(/\\/g, '/').lastIndexOf('/'); return i < 0 ? '' : String(rel).replace(/\\/g, '/').slice(0, i); };

  /* ------------------------------------------------------------------ scanning ---- */
  function toEntry(f) {
    let parsed;
    try { parsed = parseEditedAndroidXml(f.text, { lenient: true }); }
    catch (err) { return { error: /root element must be <vector>/i.test(err.message || '') ? 'other' : 'unreadable' }; }
    const stem = stemOf(f.name);
    const doc = Object.assign(baseDoc(), parsed.doc, {
      name: sanitizeResourceName(stem),
      linkSize: parsed.doc.width === parsed.doc.viewportWidth && parsed.doc.height === parsed.doc.viewportHeight,
    });
    return {
      entry: {
        id: 'ws:' + f.path, workspace: true, path: f.path, rel: f.rel, dir: dirOf(f.rel), fileName: f.name, name: stem,
        doc, shapes: parsed.shapes, groups: {}, warnings: parsed.warnings || [], updatedAt: f.modified, bytes: f.size,
      },
    };
  }

  async function refresh() {
    if (!folder || !native()) return;
    const mine = ++token;
    scan.running = true; scan.error = '';
    redraw();
    let result;
    try { result = await nb().scanWorkspace(folder); }
    catch (err) {
      if (mine !== token) return;
      scan.running = false; scan.done = true; scan.error = (err && err.message) || 'unknown error';
      redraw();
      return;
    }
    if (mine !== token) return;                                    // a newer scan (or a folder change) took over

    const nextCache = new Map();
    const next = [];
    let other = result.skipped || 0, unreadable = result.unreadable || 0;
    let sinceYield = 0;
    for (const f of result.files || []) {
      const key = f.modified + ':' + f.size;
      const hit = cache.get(f.path);
      if (hit && hit.key === key) { next.push(hit.entry); nextCache.set(f.path, hit); continue; }
      const made = toEntry(f);
      if (made.error) { if (made.error === 'other') other++; else unreadable++; continue; }
      made.entry.rel = f.rel; made.entry.dir = dirOf(f.rel);
      next.push(made.entry);
      nextCache.set(f.path, { key, entry: made.entry });
      if (++sinceYield >= 25) { sinceYield = 0; await tick(); if (mine !== token) return; }   // keep the window responsive on big folders
    }
    cache = nextCache;
    entries = next;
    scan = { running: false, done: true, error: '', other, unreadable, truncated: !!result.truncated, at: Date.now() };
    redraw();
  }

  /* ----------------------------------------------------------------- the folder ---- */
  async function restoreFolder() {
    if (restored) return;
    restored = true;
    try { folder = (await nb().getWorkspaceFolder()) || ''; } catch (err) { folder = ''; }
  }

  async function chooseFolder() {
    let picked = '';
    try { picked = await nb().pickWorkspaceFolder(); }
    catch (err) { toast('Couldn’t open the folder picker: ' + ((err && err.message) || 'unknown error')); return; }
    if (!picked) return;                                           // cancelled
    try { folder = await nb().setWorkspaceFolder(picked); }
    catch (err) { toast('Couldn’t use that folder: ' + ((err && err.message) || 'unknown error')); return; }
    entries = []; cache = new Map(); scan = { running: false, done: false, error: '', other: 0, unreadable: 0, truncated: false, at: 0 };
    homeState.query = ''; DOM.homeSearchInput.value = '';
    refresh();
    redraw();
  }

  /* ------------------------------------------------------------------- the tabs ---- */
  async function setMode(mode) {
    if (mode === homeState.mode) return;
    if (mode === 'workspace' && !native()) { toast('Workspace mode needs the Windows app — a web page can’t edit files on your PC.'); return; }
    homeState.mode = mode;
    homeState.query = ''; DOM.homeSearchInput.value = '';
    homeState.selectedIds = [];
    if (mode === 'workspace') {
      await restoreFolder();
      renderHome();
      refresh();
    } else {
      token++;                                                     // drop a scan that is still running
      scan.running = false;
      renderHome();
    }
  }

  /** Sets everything on the home screen that depends on the mode, except the cards themselves. */
  function syncChrome() {
    const ws = inWorkspace();
    DOM.homeMode.querySelectorAll('.mode-btn').forEach((b) => {
      const on = b.dataset.mode === (ws ? 'workspace' : 'project');
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    DOM.homeSearchInput.placeholder = ws ? 'Find a file…' : 'Find an icon…';
    DOM.homeGroupActions.hidden = ws;
    DOM.homeNewProject.textContent = ws ? 'New file' : 'New project';
    DOM.homeNewProject.title = ws ? 'Draw a new icon and save it as an .xml file in your workspace folder' : '';
    DOM.homeSort.setAttribute('aria-label', ws ? 'Sort files' : 'Sort projects');
    const label = DOM.statStorage.nextElementSibling;
    if (label) label.textContent = ws ? 'Folder size' : 'Local storage';
    if (!ws) { DOM.workspaceBar.hidden = true; DOM.workspaceEmpty.hidden = true; }
  }

  /* ------------------------------------------------------------------ rendering ---- */
  function filtered() {
    const q = homeState.query.trim().toLowerCase();
    const list = q ? entries.filter((e) => e.name.toLowerCase().includes(q) || e.rel.toLowerCase().includes(q)) : entries.slice();
    if (homeState.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.rel.localeCompare(b.rel));
    else list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list;
  }

  function noteText() {
    const bits = [];
    if (scan.running) bits.push('Scanning…');
    bits.push(plural(entries.length, 'vector drawable'));
    if (scan.other) bits.push(plural(scan.other, 'other XML file') + ' skipped');
    if (scan.unreadable) bits.push(plural(scan.unreadable, 'file') + ' couldn’t be read');
    if (scan.truncated) bits.push('stopped early — folder is very large');
    return bits.join(' · ');
  }

  function showEmpty(title, text, pickLabel) {
    DOM.workspaceEmpty.hidden = false;
    DOM.workspaceEmptyTitle.textContent = title;
    DOM.workspaceEmptyText.textContent = text;
    DOM.workspaceEmptyPick.hidden = !pickLabel;
    if (pickLabel) DOM.workspaceEmptyPick.textContent = pickLabel;
  }

  function render() {
    syncChrome();
    const total = entries.length;
    let layers = 0, newest = 0, bytes = 0;
    for (const e of entries) { layers += e.shapes.length; bytes += e.bytes || 0; if (e.updatedAt > newest) newest = e.updatedAt; }
    DOM.statIcons.textContent = String(total);
    DOM.statLayers.textContent = String(layers);
    DOM.statStorage.textContent = formatBytes(bytes);
    DOM.statSaved.textContent = formatRelativeTime(newest) || '—';
    DOM.homeProjectCount.textContent = plural(total, 'icon');

    DOM.homeEmpty.hidden = true;
    DOM.homeNoResults.hidden = true;
    DOM.workspaceEmpty.hidden = true;
    DOM.workspaceBar.hidden = !folder;
    DOM.projectGrid.innerHTML = '';
    DOM.projectGrid.hidden = true;
    // Nothing to search or sort until there are files.
    DOM.homeSearchBox.hidden = total === 0;
    DOM.homeToolbarRight.hidden = total === 0;

    if (folder) {
      DOM.workspacePath.textContent = folder;
      DOM.workspacePath.title = folder;
      DOM.workspaceNote.textContent = noteText();
      DOM.workspaceRefresh.disabled = scan.running;
    }

    if (!folder) {
      showEmpty('Open a folder',
        'Pick a folder and Droidwright finds every vector drawable (.xml) inside it, subfolders included. Edits are saved straight back into those files — nothing is copied. You can also delete a file from its card (after a warning).',
        'Choose folder');
      return;
    }
    if (total === 0) {
      if (scan.running || !scan.done) showEmpty('Scanning folder…', 'Looking for vector drawables. Big folders can take a moment.', '');
      else if (scan.error) showEmpty('Couldn’t scan that folder', scan.error, 'Choose another folder');
      else showEmpty('No vector drawables found',
        'This folder has no Android vector XML files' + (scan.other ? ' (' + plural(scan.other, 'other XML file') + ' skipped).' : '.'),
        'Choose another folder');
      return;
    }

    const list = filtered();
    if (!list.length) {
      DOM.homeNoResults.hidden = false;
      DOM.homeNoResultsQuery.textContent = homeState.query.trim();
      return;
    }
    DOM.projectGrid.hidden = false;
    list.forEach((entry, i) => DOM.projectGrid.appendChild(buildProjectCard(entry, i, null, false)));
  }

  /* -------------------------------------------------------------------- opening ---- */
  function open(entry) {
    if (!entry) return;
    try { closeModal(); } catch (err) { /* no popup open */ }
    const go = () => {
      state.projectId = newProjectId();                           // only used in memory (and if the file vanishes, see persistWorkspaceFile)
      state.projectName = entry.name;
      state.sourceFile = { name: entry.fileName, path: entry.path, format: 'xml', workspace: true };
      state.dirty = false;
      state.doc = Object.assign({}, state.doc, baseDoc(), deepClone(entry.doc));
      state.shapes = normalizeLoadedShapes(deepClone(entry.shapes));
      state.groups = normalizeLoadedGroups({}, state.shapes);
      state.selectedIds = [];
      state.history.past = [];
      state.history.future = [];
      state.lastSavedAt = entry.updatedAt || null;
      document.body.classList.remove('home-visible');
      syncDocSettingsUI();
      applyDefaultZoom();
      renderAll();
      updateSaveStatus();
      toast('Editing ' + entry.rel + ' — saves go straight into the file');
    };
    // Saving rewrites the file from what Droidwright understands, so anything it can't model would be lost: say so first.
    if (entry.warnings.length && typeof showConfirmModal === 'function') {
      showConfirmModal({
        title: 'This file has parts Droidwright can’t keep',
        message: entry.warnings.join(' ') + ' If you save, the file is rewritten without them. Open “' + entry.fileName + '” anyway?',
        confirmLabel: 'Open anyway',
        danger: true,
        onConfirm: go,
      });
    } else go();
  }

  /** Deletes the REAL file, after a warning. */
  function remove(entry) {
    if (!entry) return;
    showConfirmModal({
      title: 'Delete file from your PC?',
      message: 'This permanently deletes the real file “' + entry.rel + '” from your folder. It does not go to the Recycle Bin and can’t be undone.',
      confirmLabel: 'Delete file',
      danger: true,
      onConfirm: async () => {
        try { await nb().deleteWorkspaceFile(entry.path); }
        catch (err) { toast('Couldn’t delete “' + entry.fileName + '”: ' + ((err && err.message) || 'unknown error')); return; }
        entries = entries.filter((e) => e.path !== entry.path);
        cache.delete(entry.path);
        toast('Deleted ' + entry.fileName);
        redraw();
      },
    });
  }

  /** The editor just saved this file: keep its card in step until the next scan. */
  function noteSaved(path, doc, shapes) {
    const entry = entries.find((e) => e.path === path);
    if (!entry) return;
    entry.doc = deepClone(doc);
    entry.shapes = deepClone(shapes);
    entry.updatedAt = Date.now();
    entry.warnings = [];                                           // what remains is exactly what was written
  }

  /* --------------------------------------------------------------------- wiring ---- */
  function wire() {
    DOM.homeMode.addEventListener('click', (e) => {
      const btn = e.target.closest('.mode-btn');
      if (btn) setMode(btn.dataset.mode);
    });
    DOM.workspaceChange.addEventListener('click', chooseFolder);
    DOM.workspaceEmptyPick.addEventListener('click', chooseFolder);
    DOM.workspaceRefresh.addEventListener('click', refresh);
    // Files may have been changed by other programs while Droidwright was in the background.
    window.addEventListener('focus', () => {
      if (inWorkspace() && homeShowing() && folder && !scan.running && Date.now() - scan.at > 1500) refresh();
    });
  }

  return {
    get folder() { return folder; },
    newFileLink: () => ({ name: 'new file', path: '', format: 'xml', workspace: true, pending: true }),
    wire, refresh, open, remove, noteSaved, render, syncChrome,
  };
})();

/* Called by renderHome() (files.js). */
function syncHomeMode() { Workspace.syncChrome(); }
function renderWorkspaceHome() { Workspace.render(); }
function openWorkspaceFile(entry) { Workspace.open(entry); }
function deleteWorkspaceFile(entry) { Workspace.remove(entry); }
function openProjectCard(project) { if (project.workspace) openWorkspaceFile(project); else openLocalProject(project.id); }

/* Ctrl+S / autosave while a workspace file is open: write the file, and ONLY the file (no project is created). */
/* A brand-new workspace icon has no file yet (link.pending). The first save creates it in the workspace folder. */
function createWorkspaceFileNow(link) {
  if (link.creating) return;                                   // already on its way; edits made meanwhile are saved right after
  let content;
  try { content = generateXmlString(); } catch (err) { console.warn(err); return; }
  const id = state.projectId;
  const stem = sanitizeResourceName(state.doc.name || state.projectName || 'icon');
  link.creating = true;
  state.dirty = false;
  state.lastSavedAt = Date.now();
  updateSaveStatus();
  window.NativeBridge.createWorkspaceFile(stem + '.xml', content).then((path) => {
    link.path = path;
    link.name = String(path).split(/[\\/]/).pop();
    link.pending = false;
    link.creating = false;
    showToast('Created ' + link.name + ' in your workspace folder');
    if (homeState.mode === 'workspace') Workspace.refresh();
    if (state.projectId === id && state.dirty) persistActiveProject();      // edited while it was being created
  }).catch((err) => {
    link.creating = false;
    if (state.projectId === id) { state.dirty = true; updateSaveStatus(); }
    showToast('Couldn’t create the file: ' + ((err && err.message) || 'unknown error'));
  });
}

function persistWorkspaceFile() {
  const link = state.sourceFile;
  if (link.pending) { createWorkspaceFileNow(link); return; }
  const id = state.projectId;
  LinkedFile.stamp();
  state.dirty = false;
  state.lastSavedAt = Date.now();
  updateSaveStatus();
  Workspace.noteSaved(link.path, state.doc, state.shapes);
  LinkedFile.save().then((ok) => {
    if (ok || state.projectId !== id) return;
    if (state.sourceFile === link) { state.dirty = true; updateSaveStatus(); }          // the write failed: still unsaved, will retry
    else if (!state.sourceFile) persistActiveProject();                                  // the file is gone: keep the work as a normal project
  });
}
