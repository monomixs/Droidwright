/* =====================================================================================
   Saving back into the file you opened

   When a file arrives from Windows ("Open with Droidwright", a double-click, or another app launching it), the
   project is LINKED to that file: state.sourceFile = { name, path, format }.   format is 'svg' or 'xml'
   (Android vector), whatever the file really contained.

   From then on every save - Ctrl+S, the Save button, and autosave - writes the drawing into the project AND into
   that file, as SVG or Android XML to match. (persistActiveProject in ui.js calls LinkedFile.save().)

   The link is kept inside the project, so it survives closing the app and reopening the project from the home
   screen. Opening a different project, starting a new one, or deleting the project removes the link.

   Opening the same file again (Explorer, double-click, Open with) reopens its project instead of making a new one. To
   know the project is still the right one, each link keeps a fingerprint of the file as Droidwright last wrote it; if
   the file was changed by something else since, it is imported as a fresh project (which then takes over the link).

   If the file has been moved, renamed or deleted the link is dropped and you are told; the project is unaffected.
   Only the native app can do this (a web page can't write to a path), so in a browser nothing here does anything.

   Note: the file is REPLACED by what Droidwright generates, so anything in the original that Droidwright doesn't
   model (editor metadata, unusual SVG features) is not carried over.
   ===================================================================================== */
const LinkedFile = (function () {
  'use strict';

  const PENDING_MS = 30000;
  let pending = null;
  let chain = Promise.resolve();
  let lastFailure = '';            // so a failing autosave doesn't toast every few seconds
  let staged = null;               // the text stamp() prepared, written by the save() that follows
  const api = { last: null };

  /** Short fingerprint of a file's text. Line endings and a BOM are ignored, so a re-save elsewhere doesn't change it. */
  function fingerprint(text) {
    const s = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    let a = 0x811c9dc5, b = 5381;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = (Math.imul(b, 33) + c) >>> 0;
    }
    return s.length + ':' + a.toString(36) + ':' + b.toString(36);
  }
  const samePath = (x, y) => String(x || '').replace(/\//g, '\\').toLowerCase() === String(y || '').replace(/\//g, '\\').toLowerCase();
  api.fingerprint = fingerprint;

  /** The project (id) that is linked to this file AND whose file is still exactly what we last wrote, or ''. */
  api.find = (path, text) => {
    if (!path) return '';
    const print = fingerprint(text);
    const match = readProjects().find((p) => p.sourceFile && samePath(p.sourceFile.path, path) && p.sourceFile.hash === print);
    return match ? match.id : '';
  };

  /** A file now belongs to the project that was just created for it, so older projects stop writing to it. */
  function releaseFromOthers(path, keepId) {
    const projects = readProjects();
    let changed = false;
    for (const p of projects) {
      if (p.id !== keepId && p.sourceFile && samePath(p.sourceFile.path, path)) { p.sourceFile = null; changed = true; }
    }
    if (changed) writeProjects(projects);
  }

  const bridge = () => (window.NativeBridge && window.NativeBridge.isNative && window.NativeBridge.writeLinkedFile) ? window.NativeBridge : null;

  /** open-with.js: "the import that is about to start came from this file". */
  api.expect = (info) => { pending = Object.assign({ at: Date.now() }, info); };

  /** finishImport(): claims the link for the project it just created (only if it is for that same file, and recent). */
  api.take = (fileName) => {
    const p = pending;
    pending = null;
    if (!p || Date.now() - p.at > PENDING_MS || p.name !== fileName) return null;
    try { releaseFromOthers(p.path, state.projectId); } catch (err) { console.warn('Could not release the file from older projects:', err); }
    return { name: p.name, path: p.path, format: p.format, hash: p.hash };
  };

  function render(link) {
    return link.format === 'xml'
      ? generateXmlString()
      : '<?xml version="1.0" encoding="UTF-8"?>\n' + generateSvgString();
  }

  /** Called just before the project is stored: renders the file text now and fingerprints it, so the stored link
   *  knows exactly what is about to be written. */
  api.stamp = () => {
    staged = null;
    const link = state.sourceFile;
    if (!link || !link.path || !bridge()) return;
    try { staged = render(link); link.hash = fingerprint(staged); }
    catch (err) { console.warn('Could not prepare the linked file:', err); }
  };

  /** Writes the current drawing into the linked file. Resolves true when written. Writes never overlap or reorder. */
  api.save = () => {
    const link = state.sourceFile;
    const nb = bridge();
    if (!link || !link.path || !nb) { api.last = Promise.resolve(false); return api.last; }
    let content;
    try { content = staged != null ? staged : render(link); staged = null; }   // taken now, so later edits can't leak into this write
    catch (err) { console.warn('Could not prepare the linked file:', err); api.last = Promise.resolve(false); return api.last; }

    const run = chain
      .then(() => nb.writeLinkedFile(link.path, content))
      .then(() => { lastFailure = ''; return true; })
      .catch((err) => {
        const reason = (err && err.message) || 'unknown error';
        if (/no longer exists/i.test(reason)) {
          if (state.sourceFile === link) state.sourceFile = null;     // nothing left to write to
          showToast('“' + link.name + '” was moved or deleted — your changes are saved in the project only');
        } else if (lastFailure !== reason) {
          showToast('Couldn’t save to “' + link.name + '”: ' + reason);
        }
        lastFailure = reason;
        return false;
      });
    chain = run;
    api.last = run;
    return run;
  };

  return api;
})();
