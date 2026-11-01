/* =====================================================================================
   Imported fonts -> the site's font system

   custom-fonts.js keeps the font FILES (IndexedDB, no server, no bridge). This file turns them into
   entries shaped like the built-in ones (see fonts-data.js), so the font browser, the weight dropdown
   and the text tracer (getOpentypeFont in utils.js) can use them:

     customFontEntries()        every imported family, for the font browser
     findCustomFont(family)     one entry, or null
     pickCustomFace(entry, weight, italic)   the file to use (an exact static weight, else a variable
                                font covering that weight, else the nearest static weight)
     ensureCustomFontFaces(e)   registers the typeface so the font browser can preview it

   An entry: { family, category:'my-fonts', custom:true, isVariable, weights:[...], hasItalic, faces:[...] }
   ===================================================================================== */
'use strict';

const __customFontMap = new Map();          // lower-case family -> entry
const __customPreviewed = new Map();        // face id + revision -> FontFace
const CUSTOM_FONT_CATEGORY = 'my-fonts';

function rebuildCustomFonts(){
  __customFontMap.clear();
  if (typeof CustomFonts === 'undefined') return;
  for (const f of CustomFonts.families()){
    const weights = new Set();
    let isVariable = false, hasItalic = false;
    for (const face of f.faces){
      if (face.italic) hasItalic = true;
      if (face.variable){
        isVariable = true;
        for (let w = Math.ceil(face.wmin / 100) * 100; w <= face.wmax; w += 100) weights.add(w);
      } else {
        weights.add(face.weight);
      }
    }
    const sorted = [...weights].sort((a, b) => a - b);
    __customFontMap.set(f.family.toLowerCase(), {
      family: f.family, category: CUSTOM_FONT_CATEGORY, custom: true,
      isVariable, hasItalic, weights: sorted.length ? sorted : [400], faces: f.faces,
    });
  }
  // Previews of fonts that were removed or replaced must go away.
  const live = new Set();
  __customFontMap.forEach(e => e.faces.forEach(face => live.add(face.id + '#' + face.rev)));
  for (const [key, fontFace] of __customPreviewed){
    if (live.has(key)) continue;
    __customPreviewed.delete(key);
    try { if (fontFace) document.fonts.delete(fontFace); } catch(e) {}
  }
}

function customFontEntries(){ return [...__customFontMap.values()]; }
function findCustomFont(family){
  return family ? (__customFontMap.get(String(family).trim().toLowerCase()) || null) : null;
}

function pickCustomFace(entry, weight, italic){
  const want = Math.round(weight) || 400;
  const best = (wantItalic) => {
    const faces = entry.faces.filter(f => !!f.italic === wantItalic);
    const exact = faces.find(f => !f.variable && f.weight === want);
    if (exact) return exact;
    const variable = faces.find(f => f.variable && want >= f.wmin && want <= f.wmax);
    if (variable) return variable;
    const statics = faces.filter(f => !f.variable);
    if (statics.length) return statics.reduce((a, b) => Math.abs(b.weight - want) < Math.abs(a.weight - want) ? b : a);
    return faces.find(f => f.variable) || null;
  };
  return best(!!italic) || best(false) || entry.faces[0];
}

function ensureCustomFontFaces(entry){
  if (!entry || typeof FontFace !== 'function') return;
  for (const face of entry.faces){
    const key = face.id + '#' + face.rev;
    if (__customPreviewed.has(key)) continue;
    __customPreviewed.set(key, null);
    CustomFonts.bytes(face.id).then(bytes => {
      const weight = face.variable ? (face.wmin + ' ' + face.wmax) : String(face.weight);
      const fontFace = new FontFace(entry.family, bytes, { weight, style: face.italic ? 'italic' : 'normal' });
      return fontFace.load().then(() => {
        if (!__customPreviewed.has(key)) return;           // removed while loading
        document.fonts.add(fontFace);
        __customPreviewed.set(key, fontFace);
      });
    }).catch(err => {
      __customPreviewed.delete(key);
      console.warn('Could not preview', entry.family, err);
    });
  }
}

if (typeof CustomFonts !== 'undefined'){
  // A name already used by a built-in or Google font would make two identical rows in the font browser.
  CustomFonts.setNameChecker((family) => {
    if (typeof findBuiltinFont === 'function' && findBuiltinFont(family)) return true;
    const list = (typeof __googleFontsList !== 'undefined' && __googleFontsList) || [];
    const lower = String(family).toLowerCase();
    return list.some(f => f.family && f.family.toLowerCase() === lower);
  });
  CustomFonts.onChange(() => rebuildCustomFonts());          // awaited before the page is told (see custom-fonts.js)
  CustomFonts.ready.then(() => {
    rebuildCustomFonts();
    window.dispatchEvent(new CustomEvent('droidwright:fonts-changed', { detail: { reason: 'ready' } }));
  });
}
