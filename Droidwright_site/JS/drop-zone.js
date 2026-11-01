/* =====================================================================================
   Drag and drop: drop files anywhere on the window

   While a file is dragged over Droidwright a full-window overlay fades in and says what will
   happen when it is let go. Dropping it then:

     .svg                    -> imported like the "Import SVG" button
     .xml                    -> read as Android vector XML (the same reader as the XML tab)
     .json                   -> opened as a Droidwright project (or a data backup)
     .ttf .otf .woff         -> added to "My Fonts" (see custom-fonts.js) - any number at once
     .png .jpg .webp ...     -> shown in the Reference panel, to trace or pick colours from

   Everything here is plain browser code (drag events + the File API), so it behaves the same in
   the website and in the Windows app and needs nothing from the native bridge.

   The overlay never takes the mouse (pointer-events: none), so the drop still lands on the page
   and nothing flickers when the cursor crosses buttons and panels. It is hidden again when the
   file is dropped, leaves the window, or stops being dragged (a watchdog covers the cases where
   browsers forget to say so).

   Only drags that carry FILES are handled. Dragging text, links or the page's own elements is left
   alone - except that a dragged link is refused, so it can't navigate the window away.
   ===================================================================================== */
const DropZone = (function () {
  'use strict';

  const FONT_EXT = new Set(['ttf', 'otf', 'woff', 'woff2', 'ttc']);     // woff2/ttc are recognised so we can explain why they fail
  const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);
  const WATCHDOG_MS = 800;           // browsers send dragover at least every ~350 ms while a file is over the page
  const KINDS = ['design', 'project', 'font', 'image'];

  let overlay = null;
  let depth = 0;                     // dragenter/dragleave pairs, so crossing child elements doesn't hide the overlay
  let lastOver = 0;
  let watchdog = null;
  let visible = false;

  /* ------------------------------------------------------------ what is a file? ---- */
  const extOf = (name) => { const m = /\.([a-z0-9]+)$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };

  const imagesSupported = () =>
    typeof loadReferenceImage === 'function' && !!document.getElementById('referenceImg');

  /** 'design' | 'project' | 'font' | 'image' | 'unsupported' - from the file name, then its type. */
  function kindOfFile(file) {
    const ext = extOf(file && file.name);
    const type = String((file && file.type) || '').toLowerCase();
    if (FONT_EXT.has(ext) || /^font\//.test(type)) return 'font';
    if (ext === 'svg' || type === 'image/svg+xml') return 'design';
    if (ext === 'xml' || /\/(.+\+)?xml$/.test(type)) return 'design';
    if (ext === 'json' || type === 'application/json') return 'project';
    if (IMAGE_EXT.has(ext) || /^image\//.test(type)) return imagesSupported() ? 'image' : 'unsupported';
    return 'unsupported';
  }

  /** Same idea while the file is still being dragged: the browser only tells us the MIME type, not the name. */
  function kindOfMime(type) {
    const t = String(type || '').toLowerCase();
    if (!t) return null;
    if (t === 'image/svg+xml' || /\/(.+\+)?xml$/.test(t)) return 'design';
    if (t === 'application/json') return 'project';
    if (/^font\//.test(t) || /^application\/(x-)?font/.test(t) || t === 'application/vnd.ms-fontobject' || t === 'application/x-truetype-font') return 'font';
    if (/^image\//.test(t)) return imagesSupported() ? 'image' : null;
    return null;
  }

  /* ---------------------------------------------------------------- the situation ---- */
  const inEditor = () => !document.body.classList.contains('home-visible');
  const hasShapes = () => typeof state !== 'undefined' && !!(state.shapes && state.shapes.length);
  const startsNewProject = () => !inEditor() || !hasShapes();      // same rule as routeImportedShapes()

  /** Something is open on top of the editor that a dropped file shouldn't quietly change behind. */
  function blocked() {
    const modal = document.getElementById('modalBackdrop');
    if (modal && modal.classList.contains('show')) return true;
    if (document.getElementById('onboarding')) return true;
    if (typeof settingsUI !== 'undefined' && settingsUI && settingsUI.open) return true;
    return false;
  }

  /* -------------------------------------------------------------------- overlay ---- */
  function build() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'dropZone';
    overlay.className = 'dz';
    overlay.setAttribute('aria-hidden', 'true');
    const kind = (key, title, types, action) =>
      `<div class="dz-kind" data-kind="${key}"><b>${title}</b><span>${types}</span><i>${action}</i></div>`;
    overlay.innerHTML =
      '<div class="dz-frame"><div class="dz-card">' +
        '<div class="dz-icon">' +
          '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
            '<path class="dz-arrow" d="M24 7v22M15 21l9 9 9-9"/><path d="M8 32v4a4 4 0 0 0 4 4h24a4 4 0 0 0 4-4v-4"/>' +
          '</svg>' +
        '</div>' +
        '<div class="dz-title" id="dzTitle">Drop files to open them</div>' +
        '<div class="dz-sub" id="dzSub"></div>' +
        '<div class="dz-kinds">' +
          kind('design', 'Drawings', 'SVG \u00b7 Android XML', 'Import') +
          kind('project', 'Projects', 'JSON', 'Open') +
          kind('font', 'Fonts', 'TTF \u00b7 OTF \u00b7 WOFF', 'Add to My Fonts') +
          (imagesSupported() ? kind('image', 'Images', 'PNG \u00b7 JPG \u00b7 WEBP', 'Use as reference') : '') +
        '</div>' +
      '</div></div>';
    document.body.appendChild(overlay);
    return overlay;
  }

  /** The headline and the one line under it, for what is being dragged. */
  function describe(kinds, count) {
    const many = count > 1;
    const only = kinds.length === 1 ? kinds[0] : null;
    if (only === 'font') {
      return { title: many ? 'Drop to add ' + count + ' fonts' : 'Drop to add this font',
               sub: 'Added to My Fonts \u2014 find it in the font browser on any text layer' };
    }
    if (only === 'design') {
      return { title: many ? 'Drop to import a drawing' : 'Drop to import this drawing',
               sub: (startsNewProject() ? 'Starts a new project from it' : 'Adds it to your current drawing') + (many ? ' \u00b7 one drawing at a time' : '') };
    }
    if (only === 'project') {
      return { title: many ? 'Drop to open a project' : 'Drop to open this project', sub: 'Opens it in the editor' };
    }
    if (only === 'image') {
      return { title: 'Drop to use as a reference', sub: 'Opens in the Reference panel \u2014 trace it or pick colours from it' };
    }
    return { title: many ? 'Drop ' + count + ' files to open them' : 'Drop to open', sub: 'Drawings, projects, fonts and reference images all work' };
  }

  function show(event) {
    build();
    const items = (event.dataTransfer && event.dataTransfer.items) ? Array.from(event.dataTransfer.items).filter((i) => i.kind === 'file') : [];
    const kinds = [...new Set(items.map((i) => kindOfMime(i.type)).filter(Boolean))];
    const count = items.length || 1;
    const text = describe(kinds, count);
    overlay.querySelector('#dzTitle').textContent = text.title;
    overlay.querySelector('#dzSub').textContent = text.sub;
    overlay.dataset.kinds = kinds.join(' ');      // highlights the matching card(s), dims the others
    if (!visible) {
      visible = true;
      overlay.classList.add('show');
      watchdog = setInterval(() => { if (Date.now() - lastOver > WATCHDOG_MS) hide(); }, 200);
    }
  }

  function hide() {
    depth = 0;
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    if (!visible) return;
    visible = false;
    if (overlay) overlay.classList.remove('show');
  }

  /* -------------------------------------------------------------- opening files ---- */
  function openImageAsReference(file) {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof toggleReferencePanel === 'function') toggleReferencePanel(true);
      loadReferenceImage(reader.result);
      if (typeof showToast === 'function') showToast('Reference image loaded');
    };
    reader.onerror = () => { if (typeof showToast === 'function') showToast('Couldn\u2019t read \u201c' + file.name + '\u201d'); };
    reader.readAsDataURL(file);
  }

  function openDocument(entry) {
    const { file, kind } = entry;
    try {
      if (kind === 'project') loadProjectFromFile(file);
      else if (kind === 'image') openImageAsReference(file);
      else if (/\.xml$/i.test(file.name) && typeof openXmlFile === 'function') openXmlFile(file);   // the site's XML reader
      else importSvgFile(file);                                                                        // also reads Android XML in the app
    } catch (err) {
      if (typeof showToast === 'function') showToast('Couldn\u2019t open \u201c' + file.name + '\u201d');
    }
  }

  /** What to do with a set of dropped files. Fonts are all added; only ONE drawing/project/image is opened per drop. */
  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const toast = (m) => { if (typeof showToast === 'function') showToast(m); };

    const fonts = [];
    const documents = [];
    const rejected = [];
    for (const file of files) {
      const kind = kindOfFile(file);
      if (kind === 'font') fonts.push(file);
      else if (kind === 'unsupported') rejected.push(file);
      else documents.push({ file, kind });
    }

    if (fonts.length) {
      if (typeof CustomFonts === 'undefined') toast('Adding fonts isn\u2019t available in this version');
      else await CustomFonts.importFiles(fonts);
    }

    if (documents.length) {
      openDocument(documents[0]);
      if (documents.length > 1) {
        const skipped = documents.length - 1;
        // after the opened file's own message, so both can be read
        setTimeout(() => toast('Opened \u201c' + documents[0].file.name + '\u201d \u2014 ' + skipped + ' other file' + (skipped > 1 ? 's were' : ' was') + ' skipped (one drawing at a time)'), 1400);
      }
    } else if (rejected.length && !fonts.length) {
      const first = rejected[0].name;
      toast('Can\u2019t open \u201c' + first + '\u201d' + (rejected.length > 1 ? ' and ' + (rejected.length - 1) + ' more' : '') +
            ' \u2014 drop an SVG, Android XML, project JSON, a font' + (imagesSupported() ? ' or an image' : ''));
    }
  }

  /* ---------------------------------------------------------------------- events ---- */
  const hasFiles = (e) => !!(e.dataTransfer && e.dataTransfer.types && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1);
  const isEditable = (el) => !!(el && el.closest && el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));

  function init() {
    // Capture phase, so nothing inside the page can swallow the drag before we see it.
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (blocked()) return;
      depth++;
      lastOver = Date.now();
      show(e);
    }, true);

    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) {
        // Not a file (a link, say): refuse it so dropping it can't navigate away. Leave typing fields alone.
        if (!isEditable(e.target)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'; }
        return;
      }
      e.preventDefault();
      if (blocked()) { if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'; hide(); return; }
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      lastOver = Date.now();
      if (!visible) show(e);                     // also recovers from a missed dragenter
    }, true);

    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e) || !visible) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) hide();
    }, true);

    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) { if (!isEditable(e.target)) e.preventDefault(); return; }
      e.preventDefault();                        // otherwise the browser would navigate to the dropped file
      const wasBlocked = blocked();
      hide();
      if (wasBlocked) {
        if (typeof showToast === 'function') showToast('Close this window first, then drop the file');
        return;
      }
      handleFiles(e.dataTransfer.files);
    }, true);

    window.addEventListener('dragend', hide, true);
    window.addEventListener('blur', hide);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  const api = { handleFiles, kindOfFile, kindOfMime, describe, show, hide, KINDS, get visible() { return visible; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
