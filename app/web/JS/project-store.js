/* =====================================================================================
   Project store  -  where your projects (and the home-screen groups) are kept

   IN THE WINDOWS APP   every project is a file in the Projects folder inside your save folder
                        (Settings > Files & Projects > Save folder), named after the project:

                            Documents\Droidwright\Projects\My Icon.json

                        The files are normal Droidwright project JSON, so the "Open" button in the
                        editor can load them too, and they can be copied, backed up or sent to someone.

   IN A BROWSER         projects stay in the browser's local storage, exactly as before.

   The rest of the app never touches either: it calls readProjects() / writeProjects() /
   readHomeGroups() / writeHomeGroups() (export-xml.js), which hand over to this file in the Windows app.

   HOW IT WORKS
     - At startup every project file is read into memory (bootstrap.js waits for `ready`).
     - read() is instant (the app asks constantly); write() saves only the projects that actually changed,
       immediately, so closing the window right after an edit cannot lose it.
     - A project whose name changes gets its file renamed. Two projects with the same name become
       "My Icon.json" and "My Icon (2).json".
     - If a write fails (folder missing, disk full...) you are told, nothing is thrown away, and it keeps retrying.
     - FIRST RUN: projects already stored in the browser are copied to disk once. The browser copies are left
       alone as a backup (nothing is deleted).
   ===================================================================================== */
const ProjectStore = (function () {
  'use strict';

  const LS_PROJECTS = 'droidwright.projects.v1';
  const LS_GROUPS = 'droidwright.home-groups.v1';
  const LS_MIGRATED = 'droidwright.projects.on-disk.v1';
  const GROUPS_FILE = '_groups';         // the C# side skips files starting with "_" when listing projects
  const RETRY_MS = 5000;

  let active = false;                    // true once the Projects folder has been read
  let entries = [];                      // [{ id, name, file, json, written, bytes, queue }]  in display order
  let byId = new Map();
  let taken = new Set();                 // lower-case file names in use (including ones we could not read)
  let groups = { json: '{}', written: '{}', queue: Promise.resolve() };
  let folder = '';
  let retryTimer = 0;
  let lastError = '';
  let loading = null;

  const nb = () => window.NativeBridge;
  const isNative = () => !!(nb() && nb().isNative && nb().loadProjects);
  const toast = (m) => { try { if (typeof showToast === 'function') showToast(m); else console.warn(m); } catch (e) { /* too early for a toast */ } };

  /* ------------------------------------------------------------------ names ---- */
  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  /** A project name -> a safe file name (without ".json"). */
  function fileStem(name) {
    let s = String(name == null ? '' : name)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .replace(/[. ]+$/, '');
    if (s.length > 80) s = s.slice(0, 80).trim().replace(/[. ]+$/, '');
    if (!s || WINDOWS_RESERVED.test(s)) s = 'Project ' + (s || 'Untitled');
    if (s.startsWith('_')) s = 'Project ' + s;
    return s;
  }
  /** "My Icon (2)" -> "My Icon" */
  const stemOf = (file) => String(file).replace(/ \(\d+\)$/, '');

  /** A file name for `stem` that no other project uses. */
  function allocate(stem, forEntry) {
    let candidate = stem;
    for (let n = 2; ; n++) {
      const taken_ = taken.has(candidate.toLowerCase()) && !(forEntry && forEntry.file && forEntry.file.toLowerCase() === candidate.toLowerCase());
      if (!taken_) return candidate;
      candidate = stem + ' (' + n + ')';
    }
  }

  /* ----------------------------------------------------------------- loading ---- */
  function readBrowserProjects() {
    try { const d = JSON.parse(localStorage.getItem(LS_PROJECTS) || '[]'); return Array.isArray(d) ? d : []; } catch (e) { return []; }
  }
  function readBrowserGroups() {
    try {
      const d = JSON.parse(localStorage.getItem(LS_GROUPS) || '{}');
      return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch (e) { return {}; }
  }
  const looksLikeProject = (p) => p && typeof p === 'object' && typeof p.id === 'string' && p.id && p.doc && Array.isArray(p.shapes);
  const sizeOf = (text) => { try { return new Blob([text]).size; } catch (e) { return text.length; } };

  function reset() {
    entries = []; byId = new Map(); taken = new Set(); lastError = '';
    groups = { json: '{}', written: '{}', queue: Promise.resolve() };
    clearTimeout(retryTimer);
  }

  async function init() {
    reset();
    if (!isNative()) { active = false; return; }

    let loaded;
    try { loaded = await nb().loadProjects(); }
    catch (err) {
      active = false;
      console.warn('Projects folder unavailable, using browser storage:', err);
      toast('Couldn’t open the Projects folder (' + ((err && err.message) || 'unknown error') + '). Using browser storage for now.');
      return;
    }
    active = true;
    folder = loaded.folder || '';

    const unreadable = (loaded.unreadable || []).slice();
    for (const u of unreadable) { const m = /^(.*)\.json: /i.exec(u); if (m) taken.add(m[1].toLowerCase()); }
    for (const f of loaded.projects || []) {
      taken.add(String(f.file).toLowerCase());
      let project;
      try { project = JSON.parse(f.text); } catch (e) { project = null; }
      if (!looksLikeProject(project)) { unreadable.push(f.file + '.json: not a Droidwright project'); continue; }

      if (byId.has(project.id)) {
        // The same project file was copied (e.g. "Copy of My Icon.json"): give the copy a new identity of its own.
        project.id = typeof newProjectId === 'function' ? newProjectId() : project.id + '-copy';
        addEntry(project, f.file, null);                       // written = null: it gets saved with its new id
      } else {
        addEntry(project, f.file, f.text);
      }
    }
    groups.written = groups.json = loaded.groups && loaded.groups.trim() ? loaded.groups : '{}';

    if (unreadable.length) {
      console.warn('Project files that could not be read (they were left alone):', unreadable);
      toast(unreadable.length === 1 ? 'One file in the Projects folder couldn’t be read and was left alone.'
                                    : unreadable.length + ' files in the Projects folder couldn’t be read and were left alone.');
    }

    migrateFromBrowser();
    entries.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    await flushAll();
    if (!lastError && !localStorage.getItem(LS_MIGRATED)) {
      try { localStorage.setItem(LS_MIGRATED, new Date().toISOString()); } catch (e) { /* not critical: the copy is idempotent */ }
    }
  }

  function addEntry(project, file, writtenText) {
    const json = JSON.stringify(project);
    // `written` = what is on disk, compared by CONTENT (the file's formatting may differ, e.g. a hand-edited file).
    // `nameAtFile` = the project name the file name was chosen for: the file is renamed only if THAT changes, so a
    // file you named yourself ("Final.json" holding a project called "My Icon") keeps its name.
    const entry = { id: project.id, name: project.name || '', nameAtFile: file ? (project.name || '') : null, file,
                    json, written: writtenText == null ? null : json,
                    bytes: sizeOf(json), updatedAt: project.updatedAt, queue: Promise.resolve() };
    entries.push(entry);
    byId.set(entry.id, entry);
    return entry;
  }

  /** First run only: bring across the projects (and groups) that were kept in the browser's storage. */
  function migrateFromBrowser() {
    if (localStorage.getItem(LS_MIGRATED)) return;
    for (const p of readBrowserProjects()) {
      if (!looksLikeProject(p) || byId.has(p.id)) continue;
      addEntry(p, null, null);
    }
    if (groups.json === '{}') {
      const g = readBrowserGroups();
      if (Object.keys(g).length) groups.json = JSON.stringify(g);
    }
  }

  /* ----------------------------------------------------------------- writing ---- */
  function persist(entry) {
    entry.queue = entry.queue.then(async () => {
      if (entry.removed || entry.written === entry.json) return;
      const json = entry.json;
      const stem = fileStem(entry.name);
      const old = entry.file;
      const renamed = entry.nameAtFile != null && fileStem(entry.name).toLowerCase() !== fileStem(entry.nameAtFile).toLowerCase();
      const file = old && !renamed ? old : allocate(stem, entry);
      // Reserve the name NOW, before the (slow) write: two projects with the same name are saved at the same moment,
      // and without this both would pick "My Icon" and the second would overwrite the first.
      const reserved = file !== old;
      if (reserved) taken.add(file.toLowerCase());
      try {
        await nb().saveProjectText(file, json);
      } catch (err) {
        if (reserved) taken.delete(file.toLowerCase());
        lastError = (err && err.message) || 'unknown error';
        toast('Couldn’t save “' + (entry.name || 'Untitled') + '” to the Projects folder: ' + lastError);
        scheduleRetry();
        return;
      }
      taken.add(file.toLowerCase());
      entry.file = file;
      entry.nameAtFile = entry.name;
      entry.written = json;
      lastError = '';
      if (old && old !== file) {                                // the project was renamed: remove the old file
        taken.delete(old.toLowerCase());
        try { await nb().deleteProject(old); } catch (e) { /* an old file left behind is harmless */ }
      }
    });
    return entry.queue;
  }

  function persistGroups() {
    groups.queue = groups.queue.then(async () => {
      if (groups.written === groups.json) return;
      const json = groups.json;
      try { await nb().saveProjectText(GROUPS_FILE, json); groups.written = json; }
      catch (err) { scheduleRetry(); }
    });
    return groups.queue;
  }

  function flushAll() {
    return Promise.all([...entries.map(persist), persistGroups()]);
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = 0; flushAll(); }, RETRY_MS);
  }

  /* ----------------------------------------------------------- the app's view ---- */
  /** All projects (fresh copies, like parsing local storage always gave). */
  function read() {
    const out = [];
    for (const e of entries) { try { out.push(JSON.parse(e.json)); } catch (err) { /* cannot happen: we wrote it */ } }
    return out;
  }

  /** Replace the whole list. Only projects that changed are written; removed ones have their file deleted. */
  function write(projects) {
    const next = [];
    const seen = new Set();
    for (const p of projects) {
      if (!looksLikeProject(p) || seen.has(p.id)) continue;
      seen.add(p.id);
      const json = JSON.stringify(p);
      let entry = byId.get(p.id);
      if (!entry) {
        entry = { id: p.id, name: p.name || '', nameAtFile: null, file: null, json, written: null, bytes: sizeOf(json), updatedAt: p.updatedAt, queue: Promise.resolve() };
        byId.set(p.id, entry);
      }
      if (entry.json !== json) { entry.json = json; entry.bytes = sizeOf(json); }
      entry.name = p.name || '';
      entry.updatedAt = p.updatedAt;
      next.push(entry);
    }
    for (const gone of entries) {
      if (seen.has(gone.id)) continue;
      byId.delete(gone.id);
      gone.removed = true;
      gone.queue = gone.queue.then(async () => {
        if (!gone.file) return;
        try { await nb().deleteProject(gone.file); taken.delete(gone.file.toLowerCase()); }
        catch (err) { toast('Couldn’t delete “' + (gone.name || 'Untitled') + '” from the Projects folder: ' + ((err && err.message) || 'unknown error')); }
      });
    }
    entries = next;
    for (const e of entries) if (e.written !== e.json) persist(e);
  }

  function readGroups() {
    try {
      const d = JSON.parse(groups.json || '{}');
      return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch (e) { return {}; }
  }
  function writeGroups(g) {
    groups.json = JSON.stringify(g);
    if (groups.json !== groups.written) persistGroups();
  }

  /* ------------------------------------------------------------------ public ---- */
  loading = isNative() ? init() : Promise.resolve();
  loading = loading.catch((err) => { active = false; console.error('Project store failed to start:', err); });

  return {
    get active() { return active; },
    /** Resolves when the Projects folder has been read. bootstrap.js waits for this before showing anything. */
    get ready() { return loading; },
    get folder() { return folder; },
    read, write, readGroups, writeGroups,
    /** Total size of all projects, for the "storage used" figure on the home screen. */
    bytes: () => entries.reduce((sum, e) => sum + (e.bytes || 0), 0),
    /** Start over from the (possibly different) folder - after the save folder was changed. */
    reload() { loading = init().catch((err) => { active = false; console.error(err); }); return loading; },
    /** Wait until everything pending has been written (used by tests, and handy before closing). */
    flush: flushAll,
    // exposed for tests
    _fileStem: fileStem,
  };
})();
