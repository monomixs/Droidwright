/* =====================================================================================
   Files Windows asks Droidwright to open

   Right-click an .svg or .xml file in Explorer > Open with > Droidwright (or double-click it, once Droidwright is
   the default app for that type), and Windows starts the app with the file. If Droidwright is already running, the
   running window receives the file instead (see SingleInstance.cs).

   The app reads the file and sends it here as { kind: 'open-file', name, text }.
     .svg  -> imported like the "Import SVG" button
     .xml  -> read as Android vector XML (the same reader as the XML tab)
   Either way it becomes a NEW PROJECT, so whatever you were working on is left exactly as it was. The project stays
   linked to the file: every save writes the drawing back into it (linked-file.js).

   Loaded last. bootstrap.js tells the app when the page is ready (NativeBridge.notifyReady), and the app only
   sends files after that.
   ===================================================================================== */
(function () {
  'use strict';

  const nb = window.NativeBridge;
  if (!nb || !nb.isNative || !nb.onMessage) return;

  function openIncoming(message) {
    const name = String(message.name || 'Imported file');
    const isSvg = /\.svg$/i.test(name);
    let file;
    try { file = new File([String(message.text || '')], name, { type: isSvg ? 'image/svg+xml' : 'application/xml' }); }
    catch (err) { showToast('Could not open ' + name); return; }

    // The incoming file becomes a new project, the way an import from the home screen does.
    const proceed = () => {
      try { if (typeof closeSettings === 'function') closeSettings(); } catch (err) { /* not open */ }
      state.dirty = false;
      // Opened before, and the file is still exactly as Droidwright left it: go back to that project, not a copy.
      const known = (message.path && typeof LinkedFile !== 'undefined') ? LinkedFile.find(String(message.path), message.text) : '';
      if (known) { openLocalProject(known); showToast('Opened your project for “' + name + '”'); return; }
      document.body.classList.add('home-visible');
      // Remember which file this came from, so saving writes back into it (linked-file.js attaches it to the new project).
      if (message.path && typeof LinkedFile !== 'undefined') {
        const text = String(message.text || '');
        LinkedFile.expect({ name, path: String(message.path), hash: LinkedFile.fingerprint(text),
                            format: (typeof looksLikeAndroidVector === 'function' && looksLikeAndroidVector(text)) ? 'xml' : 'svg' });
      }
      importSvgFile(file);
    };

    try { if (typeof flushAutosave === 'function') flushAutosave(); } catch (err) { /* opening matters more */ }
    const inEditor = !document.body.classList.contains('home-visible');
    if (inEditor && state.dirty && settings.confirmClose && typeof showConfirmModal === 'function') {
      showConfirmModal({
        title: 'Open file',
        message: 'Your current project has unsaved changes. Open “' + name + '” as a new project anyway?',
        confirmLabel: 'Open',
        danger: true,
        onConfirm: proceed,
      });
    } else {
      proceed();
    }
  }

  nb.onMessage((message) => {
    if (!message) return;
    if (message.kind === 'open-file') openIncoming(message);
    else if (message.kind === 'open-file-error') showToast(message.message || 'Could not open that file');
  });
})();
