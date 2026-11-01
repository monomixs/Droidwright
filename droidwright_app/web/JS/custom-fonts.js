/* =====================================================================================
   Custom fonts: import your own .ttf / .otf / .woff files — no bridge, no server

   Works the same in the website and in the Windows app, because it only uses what every
   browser (and WebView2) already has: the File API to read the font, opentype.js to read what
   is inside it, and IndexedDB to remember it between visits.

     add / drop a font file  ->  read its family, weight and italic from the file itself
                             ->  keep the bytes in IndexedDB (the browser's own storage)
                             ->  it is listed under "My Fonts" in the font browser

   A file with several weights of one family (Roboto-Regular.ttf, Roboto-Bold.ttf, ...) is grouped
   into ONE family. A variable font (one file holding Thin...Black) is detected from its weight
   axis and offers every weight, the same as the built-in variable fonts.

   This file only knows about FONT FILES. How the fonts appear in the font browser and get traced
   into outlines is the job of each version's own font code (fonts.js in the app, the small
   adapter in fonts-data.js on the site) - they ask this file for the list and the bytes.

   Needs opentype.js loaded first (it is what reads the font). Nothing else.

   If the browser won't keep data (private window, storage blocked, disk full) the fonts still
   work for the current session and the person is told they won't be remembered.
   ===================================================================================== */
const CustomFonts = (function () {
  'use strict';

  const DB_NAME = 'droidwright-custom-fonts';
  const STORE = 'fonts';
  const CATEGORY = 'My Fonts';
  const MAX_FILE_BYTES = 30 * 1024 * 1024;       // one font file; bigger is almost certainly not what was meant
  const IMPORTED_SUFFIX = ' (imported)';          // added when a font's name is already taken by a built-in one
  const ACCEPT = '.ttf,.otf,.woff';

  class FontError extends Error {}

  const records = new Map();                      // id -> { id, family, ..., data: ArrayBuffer }
  const changeHandlers = [];
  let db = null;
  let persistent = false;
  let nameTaken = () => false;
  let pickerInput = null;                         // kept referenced so the browser can't discard it mid-dialog

  /* ------------------------------------------------------------------ helpers ---- */
  const familyKey = (family) => String(family || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const faceId = (family, face) => familyKey(family) + '|' + (face.variable ? 'var' : face.weight) + '|' + (face.italic ? 'i' : 'n');
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /* A family name ends up inside CSS strings and HTML attributes, so keep it plain. */
  function cleanFamily(name) {
    return String(name || '')
      .replace(/[\u0000-\u001f\u007f"\\<>]/g, '')
      .replace(/'/g, '\u2019')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  function weightFromName(text) {
    const s = String(text || '').toLowerCase();
    if (/(extra|ultra)[\s-]?light/.test(s)) return 200;
    if (/thin|hairline/.test(s)) return 100;
    if (/light/.test(s)) return 300;
    if (/(semi|demi)[\s-]?bold/.test(s)) return 600;
    if (/(extra|ultra)[\s-]?bold/.test(s)) return 800;
    if (/black|heavy/.test(s)) return 900;
    if (/bold/.test(s)) return 700;
    if (/medium/.test(s)) return 500;
    return 400;
  }

  /* The two opentype.js versions in use lay `font.names` out differently (the app's 1.3 keeps a flat
     table, the site's 2.x nests it under "windows" / "macintosh" / "unicode"), so look in all of them. */
  function pickName(font, keys) {
    const names = font.names || {};
    const tables = [names, names.windows, names.unicode, names.macintosh].filter(Boolean);
    for (const key of keys) {
      for (const table of tables) {
        const entry = table[key];
        if (!entry || typeof entry !== 'object') continue;
        const text = entry.en || entry[Object.keys(entry)[0]];
        if (text && String(text).trim()) return String(text).trim();
      }
    }
    return '';
  }

  /* ------------------------------------------------------------ reading a font file ---- */
  /**
   * Looks inside a font file and says what it is. Throws FontError with a plain-English reason
   * if it can't be used. Exposed so it can be tested without any storage.
   */
  function inspect(buffer, fileName) {
    const ot = typeof opentype !== 'undefined' ? opentype : null;
    if (!ot) throw new FontError('The text engine (opentype.js) did not load');
    if (!buffer || buffer.byteLength < 12) throw new FontError('The file is too small to be a font');

    const view = new DataView(buffer);
    const tag = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (tag === 'wOF2') throw new FontError('WOFF2 isn\u2019t supported \u2014 convert it to .ttf, .otf or .woff first');
    if (tag === 'ttcf') throw new FontError('Font collections (.ttc) aren\u2019t supported \u2014 extract a single font first');
    const known = tag === '\u0000\u0001\u0000\u0000' || tag === 'true' || tag === 'OTTO' || tag === 'wOFF';
    if (!known) throw new FontError('That doesn\u2019t look like a font file');

    let font;
    try { font = ot.parse(buffer); }
    catch (err) { throw new FontError('This font couldn\u2019t be read (' + ((err && err.message) || 'unsupported format') + ')'); }
    if (!font || !font.glyphs || !font.glyphs.length) throw new FontError('This font has no glyphs');
    // Checked glyph by glyph, NOT with font.getPath(text): opentype.js 2.x throws on some fonts' layout
    // (GSUB) tables there, and the site already copes with that when it traces text (wrapFontSafely).
    // Rejecting those here would turn away fonts that work fine.
    try { font.charToGlyph('A').getPath(0, 0, 24); }
    catch (err) { throw new FontError('This font can\u2019t be turned into outlines, so it can\u2019t be used for text'); }

    const tables = font.tables || {};
    const os2 = tables.os2 || {};
    const head = tables.head || {};
    const post = tables.post || {};

    const styleName = pickName(font, ['preferredSubfamily', 'fontSubfamily']);
    const baseName = String(fileName || '').replace(/\.[^.]+$/, '');
    let family = cleanFamily(pickName(font, ['preferredFamily', 'fontFamily']));
    if (!family) family = cleanFamily(baseName.split(/[-\[]/)[0].replace(/[_]+/g, ' ')) || 'Imported font';

    const italic = !!((os2.fsSelection & 1) || (head.macStyle & 2) ||
      /italic|oblique/i.test(styleName) || Math.abs(Number(post.italicAngle) || 0) > 0.5);

    const axis = tables.fvar && (tables.fvar.axes || []).find((a) => a.tag === 'wght');
    const variable = !!axis && axis.maxValue > axis.minValue;

    let weight = Math.round((Number(os2.usWeightClass) || 0) / 100) * 100;
    if (!weight) weight = weightFromName(styleName || baseName);
    if (variable) weight = Math.round(axis.defaultValue / 100) * 100 || 400;
    weight = clamp(weight, 100, 900);

    return {
      family,
      style: styleName || (italic ? 'Italic' : 'Regular'),
      weight,
      italic,
      variable,
      wmin: variable ? Math.round(axis.minValue) : weight,
      wmax: variable ? Math.round(axis.maxValue) : weight,
    };
  }

  function readBuffer(file) {
    if (file && typeof file.arrayBuffer === 'function') return file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('The file couldn\u2019t be read'));
      reader.readAsArrayBuffer(file);
    });
  }

  /* ------------------------------------------------------------------ storage ---- */
  function openDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) { reject(new Error('IndexedDB is not available')); return; }
      let request;
      try { request = indexedDB.open(DB_NAME, 1); }
      catch (err) { reject(err); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB could not be opened'));
      request.onblocked = () => reject(new Error('IndexedDB is blocked'));
    });
  }

  function runStore(mode, work) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let value;
      try { value = work(tx.objectStore(STORE)); }
      catch (err) { reject(err); return; }
      tx.oncomplete = () => resolve(value && 'result' in value ? value.result : undefined);
      tx.onerror = () => reject(tx.error || new Error('The font could not be saved'));
      tx.onabort = () => reject(tx.error || new Error('The font could not be saved'));
    });
  }

  const loadAll = () => runStore('readonly', (store) => store.getAll());
  const putAll = (list) => runStore('readwrite', (store) => { list.forEach((r) => store.put(r)); });
  const deleteAll = (ids) => runStore('readwrite', (store) => { ids.forEach((id) => store.delete(id)); });

  const ready = (async () => {
    try {
      db = await openDb();
      const saved = await loadAll();
      for (const r of saved || []) {
        if (r && r.id && r.family && r.data) records.set(r.id, r);
      }
      persistent = true;
    } catch (err) {
      persistent = false;
      db = null;
      console.warn('Custom fonts: browser storage unavailable, fonts will last this session only.', err);
    }
  })();

  /* ------------------------------------------------------------------- public ---- */
  async function announce(detail) {
    for (const handler of changeHandlers) {
      try { await handler(detail); } catch (err) { console.warn('Custom fonts: a change handler failed', err); }
    }
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('droidwright:fonts-changed', { detail }));
    }
  }

  const ownsFamily = (key) => [...records.values()].some((r) => familyKey(r.family) === key);

  /**
   * Adds font files. Returns
   *   { added: [{ family, faces }], skipped: [{ name, reason }], replaced, persisted }
   * One bad file never stops the others.
   */
  async function add(fileList) {
    await ready;
    const files = Array.from(fileList || []);
    const result = { added: [], skipped: [], replaced: 0, persisted: persistent };
    const staged = new Map();
    const chosenNames = new Map();     // family key -> the name used for it in this batch

    for (const file of files) {
      const name = (file && file.name) || 'font';
      try {
        if (!file.size) throw new FontError('The file is empty');
        if (file.size > MAX_FILE_BYTES) throw new FontError('It\u2019s too large (the limit is ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MB)');
        const buffer = await readBuffer(file);
        const meta = inspect(buffer, name);

        // A name already used by a built-in or online font would hide the imported one, so rename it.
        const key = familyKey(meta.family);
        let family = meta.family;
        if (!ownsFamily(key)) {
          if (!chosenNames.has(key)) chosenNames.set(key, nameTaken(family) ? cleanFamily(family + IMPORTED_SUFFIX) : family);
          family = chosenNames.get(key);
        }
        const id = faceId(family, meta);
        staged.set(id, Object.assign({ id, family, fileName: name, size: buffer.byteLength, added: Date.now(), data: buffer }, {
          style: meta.style, weight: meta.weight, italic: meta.italic, variable: meta.variable, wmin: meta.wmin, wmax: meta.wmax,
        }));
      } catch (err) {
        result.skipped.push({ name, reason: (err && err.message) || 'It couldn\u2019t be read' });
      }
    }
    if (!staged.size) return result;

    const list = [...staged.values()];
    for (const record of list) {
      if (records.has(record.id)) result.replaced++;
      records.set(record.id, record);
    }
    if (db) {
      try { await putAll(list); }
      catch (err) {
        persistent = false;
        console.warn('Custom fonts: could not save to browser storage.', err);
      }
    }
    result.persisted = persistent;

    const perFamily = new Map();
    for (const record of list) perFamily.set(record.family, (perFamily.get(record.family) || 0) + 1);
    perFamily.forEach((faces, family) => result.added.push({ family, faces }));

    await announce({ reason: 'add', families: result.added.map((a) => a.family) });
    return result;
  }

  /** Removes a whole family (every weight of it). */
  async function remove(family) {
    await ready;
    const key = familyKey(family);
    const ids = [...records.values()].filter((r) => familyKey(r.family) === key).map((r) => r.id);
    if (!ids.length) return false;
    ids.forEach((id) => records.delete(id));
    if (db) {
      try { await deleteAll(ids); }
      catch (err) { console.warn('Custom fonts: could not remove from browser storage.', err); }
    }
    await announce({ reason: 'remove', families: [family] });
    return true;
  }

  /** Every imported family, with its faces (no font bytes), A-Z. */
  function families() {
    const groups = new Map();
    for (const r of records.values()) {
      const key = familyKey(r.family);
      if (!groups.has(key)) groups.set(key, { family: r.family, category: CATEGORY, faces: [] });
      groups.get(key).faces.push({
        id: r.id, rev: r.added, style: r.style, weight: r.weight, italic: r.italic,
        variable: r.variable, wmin: r.wmin, wmax: r.wmax, fileName: r.fileName,
      });
    }
    const list = [...groups.values()];
    list.forEach((g) => g.faces.sort((a, b) => (a.italic - b.italic) || (a.weight - b.weight)));
    return list.sort((a, b) => a.family.localeCompare(b.family));
  }

  /** The font file's bytes (a fresh copy each time, so callers can't disturb the stored one). */
  async function bytes(id) {
    await ready;
    // Callers may pass an id with a trailing "#<revision>" (see the face URLs in fonts.js). A real id never
    // ends that way, so strip only that - a family name can contain '#' itself.
    const key = records.has(id) ? id : String(id).replace(/#\d+$/, '');
    const record = records.get(key);
    if (!record) throw new Error('That font is no longer available');
    return record.data.slice(0);
  }

  /** One short sentence about what an add() did, for a toast. '' if there is nothing to say. */
  function summarize(result) {
    if (!result) return '';
    const parts = [];
    if (result.added.length === 1) {
      const one = result.added[0];
      parts.push('Added \u201c' + one.family + '\u201d' + (one.faces > 1 ? ' (' + one.faces + ' styles)' : '') + ' to My Fonts');
    } else if (result.added.length > 1) {
      parts.push('Added ' + result.added.length + ' fonts to My Fonts');
    }
    if (result.skipped.length) {
      const first = result.skipped[0];
      parts.push('\u201c' + first.name + '\u201d: ' + first.reason + (result.skipped.length > 1 ? ' (and ' + (result.skipped.length - 1) + ' more skipped)' : ''));
    }
    if (result.added.length && !result.persisted) parts.push('this browser won\u2019t keep them after you close it');
    return parts.join(' \u00b7 ');
  }

  /** add() + a toast. What the font picker button and the drop zone both call. */
  async function importFiles(fileList) {
    const result = await add(fileList);
    const message = summarize(result);
    if (message && typeof showToast === 'function') showToast(message);
    return result;
  }

  /** Opens the system file picker for fonts, then imports what was chosen. */
  function pickAndImport() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = ACCEPT;
      input.style.display = 'none';
      pickerInput = input;
      const finish = async () => {
        const files = Array.from(input.files || []);
        pickerInput = null;
        resolve(files.length ? await importFiles(files) : null);
      };
      input.addEventListener('change', finish);
      input.addEventListener('cancel', () => { pickerInput = null; resolve(null); });
      input.click();
    });
  }

  const api = {
    CATEGORY,
    ACCEPT,
    ready,
    get persistent() { return persistent; },
    add,
    remove,
    families,
    bytes,
    has: (family) => ownsFamily(familyKey(family)),
    summarize,
    importFiles,
    pickAndImport,
    /** Runs (and is awaited) after fonts were added or removed, before the page is told. */
    onChange: (handler) => { changeHandlers.push(handler); },
    /** The font code tells us which names are already used by other fonts, so imports never get hidden. */
    setNameChecker: (fn) => { nameTaken = typeof fn === 'function' ? fn : () => false; },
    // exposed for tests
    inspect,
    FontError,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
