/* =====================================================================================
   Local fonts: the built-in  web\Fonts  folder  +  fonts the user adds

   Fonts that are always available, so text works with no internet, a slow connection, or when
   the online font service is down. They come from two places:

     BUILT IN      web\Fonts\<Category>\...font files...        e.g.  Fonts\Sans-Serif\Inter.ttf
     CUSTOM        fonts the user adds with "Add font..." in the font browser. They are copied to
                   %LocalAppData%\Droidwright\Fonts\My Fonts and listed under the "My Fonts" category.

   The folder name is the CATEGORY (it becomes a filter in the font browser). Nothing needs to be
   listed anywhere: the Windows app scans the folders when it starts (FontCatalog.cs reads each
   file's real family / weight / italic) and this file turns the result into:

     - @font-face rules, so every font can be previewed in its own typeface
     - face picking: "give me Inter, 700, italic" -> the right file
     - opentype.js fonts, used to turn text into vector outlines (see utils.js)

   VARIABLE FONTS (one file holding Thin...Black) offer every weight along their axis. Before being
   traced they are baked at the exact weight asked for (variable-fonts.js).

   Defaults: the font "Inter" is the default text font, and "Sans-Serif" is the primary category
   (listed first and selected first). Change them below.

   A third source needs no bridge at all: fonts the user DROPS onto the window (or picks) are kept by the
   browser itself (custom-fonts.js, IndexedDB) and listed under "My Fonts" next to the ones above. Their faces
   have urls that start with "idb:" and behave exactly like the other custom ones.

   Needs native-bridge.js, custom-fonts.js (and variable-fonts.js) loaded first. In a plain browser there is no
   folder scan, so only the fonts added in the browser are listed, plus the online fonts (if any).
   ===================================================================================== */
const BundledFonts = (function () {
  'use strict';

  const DEFAULT_FAMILY = 'Inter';
  const PRIMARY_CATEGORY = 'Sans-Serif';
  const CUSTOM_CATEGORY = 'My Fonts';       // where "Add font..." puts uploaded fonts (see Bridge.cs)

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  const data = { primary: PRIMARY_CATEGORY, categories: [], fonts: [], ignored: [], error: '' };
  const byFamily = new Map();      // lower-case family -> [entry, ...]   (an entry = one family in one category)
  const bytesCache = new Map();    // file url -> Promise<ArrayBuffer>
  const outlineCache = new Map();  // file url + weight -> Promise<opentype.Font>
  const previewed = new Map();     // custom font file url -> its FontFace, for fonts already registered for previews
  let lastNative = null;           // the last folder scan, so browser-added fonts can be re-merged without scanning again
  let loading = null;
  let warnedInstancing = false;

  const isCustomFace = (face) => /^(user|idb):/.test(String(face.url));    // user: = added with the app's picker, idb: = kept by the browser
  const isBrowserFace = (face) => String(face.url).startsWith('idb:');

  /* ---------------------------------------------------------------- loading ---- */
  /** `method` = which bridge call lists the folder, or null to skip the bridge and just re-merge what we already have. */
  function scan(method) {
    return (async () => {
      const nb = window.NativeBridge;
      if (method && nb && nb.isNative && nb[method]) {
        try {
          data.error = '';
          lastNative = await nb[method]();
        } catch (err) {
          data.error = (err && err.message) || 'Could not read the Fonts folder';
          console.warn('Local fonts unavailable:', data.error);
        }
      }
      // Fonts kept by the browser are read before merging; a failure there must never hide the built-in ones.
      if (typeof CustomFonts !== 'undefined') { try { await CustomFonts.ready; } catch (err) { /* storage unavailable: none to add */ } }
      ingest(lastNative || {});
      return data;
    })();
  }
  function load() {
    if (!loading) loading = scan('listFonts');
    return loading;
  }
  /** Re-scan after the user added fonts. */
  function reload() {
    outlineCache.clear();
    bytesCache.clear();
    loading = scan('refreshFonts');
    return loading;
  }
  /** After fonts were added or removed in the browser (no bridge involved): re-merge them into the list. */
  function refreshLocal() {
    outlineCache.clear();
    bytesCache.clear();
    loading = scan(null);
    return loading;
  }

  function ingest(catalog) {
    data.primary = catalog.primary || PRIMARY_CATEGORY;
    data.categories = Array.isArray(catalog.categories) ? catalog.categories : [];
    data.fonts = Array.isArray(catalog.fonts) ? catalog.fonts.filter((f) => f && f.family && f.faces && f.faces.length) : [];
    data.ignored = Array.isArray(catalog.ignored) ? catalog.ignored : [];

    // Fonts kept by the browser (custom-fonts.js) join the list under "My Fonts".
    if (typeof CustomFonts !== 'undefined') {
      for (const f of CustomFonts.families()) {
        data.fonts.push({
          family: f.family,
          category: CustomFonts.CATEGORY,
          faces: f.faces.map((x) => ({ url: 'idb:' + x.id + '#' + x.rev, weight: x.weight, italic: x.italic, variable: x.variable, wmin: x.wmin, wmax: x.wmax })),
        });
      }
      if (data.fonts.some((f) => f.category === CustomFonts.CATEGORY) && !data.categories.some((c) => norm(c) === norm(CustomFonts.CATEGORY))) {
        data.categories = data.categories.concat(CustomFonts.CATEGORY).sort((a, b) => a.localeCompare(b));
      }
    }

    byFamily.clear();
    for (const entry of data.fonts) {
      entry.custom = entry.faces.every(isCustomFace);
      entry.removable = entry.faces.every(isBrowserFace);          // only these can be taken out from the font browser
      const key = entry.family.toLowerCase();
      if (!byFamily.has(key)) byFamily.set(key, []);
      byFamily.get(key).push(entry);
    }
    if (data.ignored.length) {
      console.warn('Fonts folder: ' + data.ignored.length + ' file(s) ignored (only .ttf, .otf and .woff can be used for text):', data.ignored);
    }
    registerFontFaces();

    // A removed or replaced browser font must stop being offered as a preview typeface.
    const live = new Set();
    for (const entry of data.fonts) for (const face of entry.faces) live.add(face.url);
    for (const [url, fontFace] of previewed) {
      if (live.has(url)) continue;
      previewed.delete(url);
      try { if (fontFace) document.fonts.delete(fontFace); } catch (err) { /* already gone */ }
    }
  }

  /* A file path such as "Fonts/Sans-Serif/My Font-Bold.ttf" -> a safe relative URL. */
  function urlOf(face) {
    return face.url.split('/').map(encodeURIComponent).join('/').replace(/%2C/gi, ',');
  }
  const weightDescriptor = (face) => (face.variable && face.wmax > face.wmin ? `${face.wmin} ${face.wmax}` : String(face.weight));

  /* Built-in fonts are previewed straight from their files. (Custom fonts live outside the app's
     folder, so they are registered from their bytes instead - see ensurePreview.) */
  function registerFontFaces() {
    const css = [];
    const seen = new Set();
    for (const entry of data.fonts) {
      for (const face of entry.faces) {
        if (isCustomFace(face)) continue;
        const url = urlOf(face);
        const id = entry.family + '|' + url;
        if (seen.has(id)) continue;
        seen.add(id);
        const format = /\.otf$/i.test(face.url) ? 'opentype' : /\.woff$/i.test(face.url) ? 'woff' : 'truetype';
        css.push(`@font-face{font-family:"${entry.family.replace(/["\\]/g, '')}";src:url("${url}") format("${format}");` +
                 `font-weight:${weightDescriptor(face)};font-style:${face.italic ? 'italic' : 'normal'};font-display:swap;}`);
      }
    }
    let el = document.getElementById('bundledFontFaces');
    if (!el) {
      el = document.createElement('style');
      el.id = 'bundledFontFaces';
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = css.join('\n');
  }

  /** Makes a custom font's own typeface available to the page (for the font browser's previews). */
  function ensurePreview(family) {
    const entry = entryFor(family);
    if (!entry || !entry.custom || typeof FontFace !== 'function') return Promise.resolve();
    return Promise.all(entry.faces.map(async (face) => {
      if (previewed.has(face.url)) return;
      previewed.set(face.url, null);
      try {
        const bytes = await loadBytes(face);
        const fontFace = new FontFace(entry.family, bytes.slice(0), { weight: weightDescriptor(face), style: face.italic ? 'italic' : 'normal' });
        await fontFace.load();
        document.fonts.add(fontFace);
        if (previewed.has(face.url)) previewed.set(face.url, fontFace);      // (it may have been removed while loading)
      } catch (err) {
        previewed.delete(face.url);
        console.warn('Could not preview', entry.family, err);
      }
    }));
  }

  /* ---------------------------------------------------------------- lookups ---- */
  /** The entry for a family. If it exists in several categories, the primary category wins. */
  function entryFor(family) {
    const list = byFamily.get(String(family || '').toLowerCase());
    if (!list || !list.length) return null;
    return list.find((e) => norm(e.category) === norm(data.primary)) || list[0];
  }

  const clampWeight = (weight, face) => {
    const w = Math.round(weight) || 400;
    return face.wmax >= face.wmin ? Math.min(face.wmax, Math.max(face.wmin, w)) : face.weight;
  };

  /**
   * Which weights / italic a local family can really produce, for the Weight dropdown.
   *  - separate (static) files: the weight each file is
   *  - a variable font: every step of 100 along its weight axis (Thin 100 ... Black 900, or however
   *    far that font goes) - the font is baked at the chosen weight before it is traced
   * Returns null if the family isn't a local font.
   */
  function variantsInfo(family) {
    const entry = entryFor(family);
    if (!entry) return null;
    const weights = new Set();
    for (const face of entry.faces) {
      if (!face.variable || face.wmax <= face.wmin) { weights.add(face.weight); continue; }
      for (let w = Math.ceil(face.wmin / 100) * 100; w <= face.wmax; w += 100) weights.add(w);
    }
    return {
      weights: [...weights].sort((a, b) => a - b),
      hasItalic: entry.faces.some((f) => f.italic),
    };
  }

  /**
   * The file to use for "family, weight, italic" (or null if it isn't a local font).
   * An exact static file wins; otherwise a variable font that covers the weight (it will be baked
   * at exactly that weight); otherwise the nearest static weight.
   */
  function pickFace(family, weight, italic) {
    const entry = entryFor(family);
    if (!entry) return null;
    const want = Math.round(weight) || 400;

    const best = (wantItalic) => {
      const faces = entry.faces.filter((f) => f.italic === wantItalic);
      const exact = faces.find((f) => !f.variable && f.weight === want);
      if (exact) return exact;
      const variable = faces.find((f) => f.variable && want >= f.wmin && want <= f.wmax);
      if (variable) return variable;
      const statics = faces.filter((f) => !f.variable);
      if (statics.length) return statics.reduce((a, b) => (Math.abs(b.weight - want) < Math.abs(a.weight - want) ? b : a));
      return faces.find((f) => f.variable) || null;
    };
    return best(!!italic) || best(false) || entry.faces[0] || null;
  }

  /** The font used for new text, and as the instant placeholder while another font loads (Regular, 400). */
  function defaultFace() {
    let face = pickFace(DEFAULT_FAMILY, 400, false);
    if (face) return face;
    const inPrimary = data.fonts.find((f) => norm(f.category) === norm(data.primary)) || data.fonts[0];
    return inPrimary ? pickFace(inPrimary.family, 400, false) : null;
  }

  /* ------------------------------------------------------ reading font files ---- */
  function base64ToBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  /** The raw bytes of a font file (cached). Built-in files are fetched; custom ones come from the app. */
  function loadBytes(face) {
    const key = face.url;
    if (bytesCache.has(key)) return bytesCache.get(key);
    const promise = (async () => {
      if (isBrowserFace(face)) return CustomFonts.bytes(face.url.slice(4));          // kept by the browser: no bridge
      if (isCustomFace(face)) return base64ToBuffer(await window.NativeBridge.readFontFile(face.url));
      const response = await fetch(urlOf(face));
      if (!response.ok) throw new Error(`Couldn't read the font file ${face.url} (${response.status})`);
      return response.arrayBuffer();
    })().catch((err) => { bytesCache.delete(key); throw err; });
    bytesCache.set(key, promise);
    return promise;
  }

  /**
   * An opentype.js font ready to trace text with. For a variable font, `weight` picks the weight it
   * is baked at; static fonts ignore it. Cached per file + weight.
   */
  function loadOpentype(face, weight) {
    const w = face.variable ? clampWeight(weight, face) : 0;
    const key = face.url + '@' + w;
    if (outlineCache.has(key)) return outlineCache.get(key);
    const promise = (async () => {
      if (typeof opentype === 'undefined') throw new Error('The text engine (opentype.js) did not load.');
      let buffer = await loadBytes(face);
      if (face.variable) {
        try {
          buffer = await VariableFonts.instantiate(buffer, w);
        } catch (err) {
          // Without the converter the font still works, but only at its built-in default weight.
          if (!warnedInstancing) console.warn('Variable fonts: could not set the weight, using the font\'s default instead.', err);
          warnedInstancing = true;
        }
      }
      return opentype.parse(buffer);
    })().catch((err) => { outlineCache.delete(key); throw err; });
    outlineCache.set(key, promise);
    return promise;
  }

  /* ------------------------------------------------------------- public API ---- */
  load();   // start right away; everything else waits on `ready`

  // Fonts added or removed in the browser: re-merge them (CustomFonts waits for this before telling the page).
  if (typeof CustomFonts !== 'undefined') {
    CustomFonts.onChange(() => refreshLocal());
    CustomFonts.setNameChecker((family) => (byFamily.get(String(family || '').toLowerCase()) || []).some((e) => !e.custom));
  }

  return {
    DEFAULT_FAMILY,
    CUSTOM_CATEGORY,
    get ready() { return load(); },
    get error() { return data.error; },
    primary: () => data.primary,
    categories: () => data.categories.slice(),
    /** [{ family, category, variable, custom }] for every local font */
    families: () => data.fonts.map((f) => ({ family: f.family, category: f.category, variable: f.faces.some((x) => x.variable), custom: !!f.custom, removable: !!f.removable })),
    has: (family) => !!entryFor(family),
    /** True if a font that ships with the app (or sits in its Fonts folder) already uses this family name. */
    hasBuiltInName: (family) => (byFamily.get(String(family || '').toLowerCase()) || []).some((e) => !e.custom),
    variantsInfo,
    pickFace,
    defaultFace,
    loadOpentype,
    reload,
    refreshLocal,
    ensurePreview,
    // exposed for tests
    _ingest: ingest,
  };
})();
