/* =====================================================================================
   Variable fonts  ->  one ordinary font at the weight you ask for

   A variable font is a single file that contains every weight (Thin ... Black) as an axis you
   can slide along. opentype.js, which turns text into vector outlines (see utils.js), can only
   read the font at its DEFAULT setting - and the default is not always Regular (Montserrat's is
   Thin, Fraunces' is Black).

   So before a variable font is traced it is run through HarfBuzz's font "instancer", which bakes
   the font at one exact weight and returns a normal, static font file. Everything after that
   (opentype.js, the text tool, exporting) works exactly as it does for any other font.

   HarfBuzz ships as a small WebAssembly file (JS/vendor/harfbuzz-subset.wasm - no internet needed).
   It is loaded the first time a variable font is used, and takes a few milliseconds per font.
   Checked against the fontTools reference instancer on your fonts: outlines and widths match to
   within rounding (about 0.01 px at 24px text).
   ===================================================================================== */
const VariableFonts = (function () {
  'use strict';

  const WASM_URL = 'JS/vendor/harfbuzz-subset.wasm';
  const HB_MEMORY_MODE_READONLY = 1;
  let loading = null;

  const tag = (s) => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;

  function load() {
    if (loading) return loading;
    loading = (async () => {
      if (typeof WebAssembly !== 'object') throw new Error('WebAssembly is not available');
      const response = await fetch(WASM_URL);
      if (!response.ok) throw new Error(`Couldn't read ${WASM_URL} (${response.status})`);
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      const exports = instance.exports;
      if (exports._initialize) exports._initialize();
      return exports;
    })().catch((err) => { loading = null; throw err; });
    return loading;
  }

  /**
   * Returns a copy of the font (an ArrayBuffer) with the weight axis fixed at `weight` and every
   * other axis (width, optical size, ...) at its default. A font with no weight axis just comes
   * back with all axes at their defaults.
   */
  async function instantiate(buffer, weight) {
    const hb = await load();
    const input = new Uint8Array(buffer);
    // The WebAssembly memory can move when it grows, so a fresh view is taken after every call into it.
    const view = () => new Uint8Array(hb.memory.buffer);

    const ptr = hb.malloc(input.length);
    view().set(input, ptr);
    const blob = hb.hb_blob_create(ptr, input.length, HB_MEMORY_MODE_READONLY, 0, 0);
    const face = hb.hb_face_create(blob, 0);
    const request = hb.hb_subset_input_create_or_fail();
    let subset = 0;
    let outBlob = 0;
    try {
      hb.hb_subset_input_keep_everything(request);                  // keep every glyph, the kerning, names...
      hb.hb_subset_input_pin_all_axes_to_default(request, face);    // a fully static result...
      if (weight != null) hb.hb_subset_input_pin_axis_location(request, face, tag('wght'), weight); // ...at this weight
      subset = hb.hb_subset_or_fail(face, request);
      if (!subset) throw new Error('The variable font could not be converted');
      outBlob = hb.hb_face_reference_blob(subset);
      const length = hb.hb_blob_get_length(outBlob);
      const dataPtr = hb.hb_blob_get_data(outBlob, 0);
      return view().slice(dataPtr, dataPtr + length).buffer;
    } finally {
      if (outBlob) hb.hb_blob_destroy(outBlob);
      if (subset) hb.hb_face_destroy(subset);
      hb.hb_subset_input_destroy(request);
      hb.hb_face_destroy(face);
      hb.hb_blob_destroy(blob);
      hb.free(ptr);
    }
  }

  return { instantiate, load };
})();
