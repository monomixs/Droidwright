/* =====================================================================================
   Part 12: doc settings panel wiring + global sync
   ===================================================================================== */
function syncDocSettingsUI(){
  const d = state.doc;
  const setVal = (id, val) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = val; };
  setVal('docWidth', fmtAttr(d.width));
  setVal('docHeight', fmtAttr(d.height));
  setVal('docVpWidth', fmtAttr(d.viewportWidth));
  setVal('docVpHeight', fmtAttr(d.viewportHeight));
  const linkEl = document.getElementById('docLink'); if (linkEl) linkEl.checked = d.linkSize;
  const tintEl = document.getElementById('docTint'); if (tintEl && document.activeElement!==tintEl) tintEl.value = d.tint || '#000000';
  const tintSwatch = document.getElementById('tintSwatch'); if (tintSwatch) tintSwatch.style.background = d.tint || 'transparent';
  const alphaEl = document.getElementById('docAlpha'); if (alphaEl && document.activeElement!==alphaEl) alphaEl.value = Math.round(d.alpha*100);
  const alphaVal = document.getElementById('docAlphaVal'); if (alphaVal) alphaVal.textContent = Math.round(d.alpha*100) + '%';
  const autoMirrorEl = document.getElementById('docAutoMirror'); if (autoMirrorEl) autoMirrorEl.checked = d.autoMirrored;

  // Sync background settings
  const bgEnabledEl = document.getElementById('docBgEnabled');
  const bgControls = document.getElementById('docBgControls');
  const bgColorEl = document.getElementById('docBgColor');
  const bgHexEl = document.getElementById('docBgHex');
  const bgSwatch = document.getElementById('docBgSwatch');
  const bgAlphaEl = document.getElementById('docBgAlpha');
  const bgAlphaVal = document.getElementById('docBgAlphaVal');
  const bgExportEl = document.getElementById('docBgExport');

  if (bgEnabledEl) bgEnabledEl.checked = Boolean(d.backgroundEnabled);
  if (bgControls) bgControls.style.display = d.backgroundEnabled ? 'flex' : 'none';
  const bgCol = d.backgroundColor || '#1E222B';
  if (bgColorEl && document.activeElement !== bgColorEl) bgColorEl.value = bgCol;
  if (bgHexEl && document.activeElement !== bgHexEl) bgHexEl.value = bgCol;
  if (bgSwatch) bgSwatch.style.background = bgCol;
  const bgAlpha = d.backgroundOpacity != null ? Math.round(d.backgroundOpacity * 100) : 100;
  if (bgAlphaEl && document.activeElement !== bgAlphaEl) bgAlphaEl.value = bgAlpha;
  if (bgAlphaVal) bgAlphaVal.textContent = bgAlpha + '%';
  if (bgExportEl) bgExportEl.checked = d.backgroundExport !== false;

  if (DOM.docNameInput && document.activeElement !== DOM.docNameInput) DOM.docNameInput.value = d.name;
  DOM.viewportReadout.textContent = `${fmtAttr(d.viewportWidth)} × ${fmtAttr(d.viewportHeight)} viewport · ${fmtAttr(d.width)} × ${fmtAttr(d.height)} dp`;
}
function wireDocSettings(){
  const widthEl=document.getElementById('docWidth'), heightEl=document.getElementById('docHeight');
  const vpwEl=document.getElementById('docVpWidth'), vphEl=document.getElementById('docVpHeight');
  const linkEl=document.getElementById('docLink');
  const tintEl=document.getElementById('docTint'), tintSwatch=document.getElementById('tintSwatch');
  const alphaEl=document.getElementById('docAlpha'), alphaVal=document.getElementById('docAlphaVal');
  const autoMirrorEl=document.getElementById('docAutoMirror');

  function liveSync(){
    DOM.viewportReadout.textContent = `${fmtAttr(state.doc.viewportWidth)} × ${fmtAttr(state.doc.viewportHeight)} viewport · ${fmtAttr(state.doc.width)} × ${fmtAttr(state.doc.height)} dp`;
    renderStage();
    renderPreviewStrip();
  }
  widthEl.addEventListener('input', () => {
    beginEdit();
    const v = Math.max(1, parseFloat(widthEl.value)||1);
    state.doc.width = v;
    if (state.doc.linkSize){ state.doc.viewportWidth = v; if (document.activeElement!==vpwEl) vpwEl.value = fmtAttr(v); }
    liveSync();
  });
  heightEl.addEventListener('input', () => {
    beginEdit();
    const v = Math.max(1, parseFloat(heightEl.value)||1);
    state.doc.height = v;
    if (state.doc.linkSize){ state.doc.viewportHeight = v; if (document.activeElement!==vphEl) vphEl.value = fmtAttr(v); }
    liveSync();
  });
  vpwEl.addEventListener('input', () => {
    beginEdit();
    const v = Math.max(1, parseFloat(vpwEl.value)||1);
    state.doc.viewportWidth = v;
    if (state.doc.linkSize){ state.doc.width = v; if (document.activeElement!==widthEl) widthEl.value = fmtAttr(v); }
    liveSync();
  });
  vphEl.addEventListener('input', () => {
    beginEdit();
    const v = Math.max(1, parseFloat(vphEl.value)||1);
    state.doc.viewportHeight = v;
    if (state.doc.linkSize){ state.doc.height = v; if (document.activeElement!==heightEl) heightEl.value = fmtAttr(v); }
    liveSync();
  });
  [widthEl,heightEl,vpwEl,vphEl].forEach(el => el.addEventListener('change', () => { commitEdit(); fitZoom(); renderAll(); }));

  linkEl.addEventListener('change', () => {
    doAction(() => {
      state.doc.linkSize = linkEl.checked;
      if (state.doc.linkSize){ state.doc.width = state.doc.viewportWidth; state.doc.height = state.doc.viewportHeight; }
    });
    syncDocSettingsUI();
  });
  document.querySelectorAll('[data-size]').forEach(btn => {
    btn.addEventListener('click', () => {
      const n = parseFloat(btn.dataset.size);
      doAction(() => { state.doc.width=n; state.doc.height=n; state.doc.viewportWidth=n; state.doc.viewportHeight=n; state.doc.linkSize=true; });
      syncDocSettingsUI(); fitZoom(); renderAll();
    });
  });
  tintEl.addEventListener('input', () => { beginEdit(); state.doc.tint = tintEl.value; tintSwatch.style.background = tintEl.value; renderPreviewStrip(); });
  tintEl.addEventListener('change', () => { commitEdit(); renderAll(); });
  document.getElementById('btnClearTint').addEventListener('click', () => { doAction(() => { state.doc.tint = ''; }); syncDocSettingsUI(); });

  alphaEl.addEventListener('input', () => {
    beginEdit();
    state.doc.alpha = clamp(parseFloat(alphaEl.value)/100, 0, 1);
    alphaVal.textContent = Math.round(state.doc.alpha*100) + '%';
    renderPreviewStrip();
  });
  alphaEl.addEventListener('change', () => { commitEdit(); renderAll(); });
  autoMirrorEl.addEventListener('change', () => { doAction(() => { state.doc.autoMirrored = autoMirrorEl.checked; }); });

  // Background layer event handlers
  const bgEnabledEl = document.getElementById('docBgEnabled');
  const bgControls = document.getElementById('docBgControls');
  const bgColorEl = document.getElementById('docBgColor');
  const bgHexEl = document.getElementById('docBgHex');
  const bgSwatch = document.getElementById('docBgSwatch');
  const bgAlphaEl = document.getElementById('docBgAlpha');
  const bgAlphaVal = document.getElementById('docBgAlphaVal');
  const bgExportEl = document.getElementById('docBgExport');

  if (bgEnabledEl){
    bgEnabledEl.addEventListener('change', () => {
      doAction(() => {
        state.doc.backgroundEnabled = bgEnabledEl.checked;
        if (state.doc.backgroundColor == null) state.doc.backgroundColor = '#1E222B';
        if (state.doc.backgroundOpacity == null) state.doc.backgroundOpacity = 1;
        if (state.doc.backgroundExport == null) state.doc.backgroundExport = true;
      });
      syncDocSettingsUI();
      renderStage();
      renderPreviewStrip();
      renderXmlPreview();
    });
  }

  function setBgColor(hex){
    beginEdit();
    state.doc.backgroundColor = hex;
    if (bgColorEl && document.activeElement !== bgColorEl) bgColorEl.value = hex;
    if (bgHexEl && document.activeElement !== bgHexEl) bgHexEl.value = hex;
    if (bgSwatch) bgSwatch.style.background = hex;
    renderStage();
    renderPreviewStrip();
    renderXmlPreview();
  }

  if (bgColorEl){
    bgColorEl.addEventListener('input', () => setBgColor(bgColorEl.value));
    bgColorEl.addEventListener('change', () => { commitEdit(); renderAll(); });
  }

  if (bgHexEl){
    bgHexEl.addEventListener('input', () => {
      let val = bgHexEl.value.trim();
      if (!val.startsWith('#')) val = '#' + val;
      if (/^#[0-9A-Fa-f]{6}$/.test(val)){
        setBgColor(val);
      }
    });
    bgHexEl.addEventListener('change', () => { commitEdit(); renderAll(); });
  }

  document.querySelectorAll('[data-bg-color]').forEach(dot => {
    dot.addEventListener('click', () => {
      setBgColor(dot.dataset.bgColor);
      commitEdit();
      renderAll();
    });
  });

  if (bgAlphaEl){
    bgAlphaEl.addEventListener('input', () => {
      beginEdit();
      const val = clamp(parseFloat(bgAlphaEl.value) / 100, 0, 1);
      state.doc.backgroundOpacity = val;
      if (bgAlphaVal) bgAlphaVal.textContent = Math.round(val * 100) + '%';
      renderStage();
      renderPreviewStrip();
      renderXmlPreview();
    });
    bgAlphaEl.addEventListener('change', () => { commitEdit(); renderAll(); });
  }

  if (bgExportEl){
    bgExportEl.addEventListener('change', () => {
      doAction(() => {
        state.doc.backgroundExport = bgExportEl.checked;
      });
      renderXmlPreview();
    });
  }

  DOM.docNameInput.addEventListener('input', () => {
    beginEdit();
    const enteredName = DOM.docNameInput.value.trim();
    state.projectName = enteredName || 'Untitled icon';
    state.doc.name = sanitizeResourceName(enteredName || 'Untitled icon');
    renderXmlPreview();
  });
  DOM.docNameInput.addEventListener('change', () => { commitEdit(); renderAll(); });
}

function wirePresetShapesPopover(){
  const btn = document.getElementById('btnPresetShapes');
  const popover = document.getElementById('presetsPopover');
  if (!btn || !popover) return;

  function togglePopover(){
    if (!popover.hidden){
      popover.hidden = true;
      btn.classList.remove('active');
      return;
    }
    const rect = btn.getBoundingClientRect();
    popover.hidden = false;
    btn.classList.add('active');
    popover.style.left = (rect.right + 8) + 'px';
    popover.style.top = Math.max(10, Math.min(rect.top - 20, window.innerHeight - 420)) + 'px';
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePopover();
  });

  document.addEventListener('click', (e) => {
    const presetBtn = e.target.closest('[data-insert-preset]');
    if (presetBtn){
      const presetId = presetBtn.dataset.insertPreset;
      if (presetId){
        popover.hidden = true;
        btn.classList.remove('active');
        insertPresetShape(presetId);
      }
    }
  });

  window.addEventListener('pointerdown', (e) => {
    if (!popover.hidden && !popover.contains(e.target) && e.target !== btn && !btn.contains(e.target)){
      popover.hidden = true;
      btn.classList.remove('active');
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.hidden){
      popover.hidden = true;
      btn.classList.remove('active');
    }
  });
}


/* =====================================================================================
   Part 12b: settings
   One flat, validated object (`settings`) is the single source of truth. It is persisted
   to localStorage, and every key has exactly one place that applies it (applySetting), so
   the dialog, the canvas toggles and the boot sequence can't drift out of step.
   ===================================================================================== */
const SETTINGS_KEY = 'droidwright.settings.v1';
const SETTINGS_BOOT_KEY = 'droidwright.boot.v1';   // read by the inline <head> script to avoid a theme flash

const ACCENT_PRESETS = [
  { name:'Mint',   value:'#5ee1a0' },
  { name:'Sky',    value:'#6fa8ff' },
  { name:'Violet', value:'#b98cff' },
  { name:'Rose',   value:'#ff7eb6' },
  { name:'Coral',  value:'#ff6b6b' },
  { name:'Amber',  value:'#f5b75e' },
  { name:'Slate',  value:'#9aa1af' },
];
const CANVAS_SIZE_CHOICES = [24, 32, 48, 64, 96, 108, 512];
const DEFAULT_ZOOM_CHOICES = ['fit', 0.5, 1, 2, 4];
const AUTOSAVE_MODES = ['afterDelay', '30s', '1m', '5m'];
const AUTOSAVE_TICK_MS = { '30s': 30000, '1m': 60000, '5m': 300000 };
// Tools that make sense to come back to; node/cut only work with a selection or mid-gesture.
const RESTORABLE_TOOLS = ['select', 'rect', 'ellipse', 'polygon', 'line', 'pen', 'arc', 'curve', 'text', 'pan'];

function settingNumber(min, max, decimals){
  return (v) => {
    const n = (typeof v === 'string' && v.trim() === '') ? NaN : Number(v);
    if (!isFinite(n)) return null;
    const p = Math.pow(10, decimals || 0);
    return Math.round(clamp(n, min, max) * p) / p;
  };
}
const settingBool = (v) => typeof v === 'boolean' ? v : null;
const settingOneOf = (list) => (v) => list.indexOf(v) >= 0 ? v : null;

const SETTING_DEFS = {
  // Appearance
  theme:              { default: 'dark',       sanitize: settingOneOf(['dark', 'light', 'system']) },
  accentColor:        { default: '#5ee1a0',    sanitize: (v) => normalizeHexColor(String(v || '')) },
  toastDuration:      { default: 2600,         sanitize: (v) => { const n = settingNumber(1000, 10000, 0)(v); return n == null ? null : Math.round(n / 100) * 100; } },
  // Canvas & editing
  canvasSize:         { default: 24,           sanitize: (v) => CANVAS_SIZE_CHOICES.indexOf(Number(v)) >= 0 ? Number(v) : null },
  gridSize:           { default: 1,            sanitize: settingNumber(0.25, 32, 2) },
  showGrid:           { default: true,         sanitize: settingBool },
  snapToGrid:         { default: false,        sanitize: settingBool },
  showGuides:         { default: true,         sanitize: settingBool },
  defaultZoom:        { default: 'fit',        sanitize: (v) => v === 'fit' ? 'fit' : (DEFAULT_ZOOM_CHOICES.indexOf(Number(v)) > 0 ? Number(v) : null) },
  // Tools
  defaultStrokeWidth: { default: 2,            sanitize: settingNumber(0.25, 48, 2) },
  defaultFill:        { default: '#000000',    sanitize: (v) => normalizeHexColor(String(v || '')) },
  defaultStroke:      { default: '#000000',    sanitize: (v) => normalizeHexColor(String(v || '')) },
  rememberTool:       { default: false,        sanitize: settingBool },
  lastTool:           { default: 'select',     sanitize: settingOneOf(RESTORABLE_TOOLS) },
  // Files & projects
  autosave:           { default: false,        sanitize: settingBool },
  autosaveInterval:   { default: 'afterDelay', sanitize: settingOneOf(AUTOSAVE_MODES) },
  autosaveDelay:      { default: 2000,         sanitize: settingNumber(250, 60000, 0) },
  confirmDelete:      { default: true,         sanitize: settingBool },
  confirmClose:       { default: true,         sanitize: settingBool },
};

function normalizeSettingsObject(raw){
  const saved = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const key in SETTING_DEFS){
    const clean = key in saved ? SETTING_DEFS[key].sanitize(saved[key]) : null;
    out[key] = clean == null ? SETTING_DEFS[key].default : clean;
  }
  return out;
}
function loadSettings(){
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
  catch (e){ /* corrupt or unavailable storage: fall back to defaults */ }
  return normalizeSettingsObject(saved);
}
let settings = loadSettings();

function persistSettings(){
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e){ /* private mode / quota */ }
}
/* Validates, stores, persists and applies one setting. Returns false if the value was
   unusable (the caller should re-sync its control from `settings`). */
function setSetting(key, value){
  const def = SETTING_DEFS[key];
  if (!def) return false;
  const clean = def.sanitize(value);
  if (clean == null) return false;
  if (settings[key] === clean) return true;
  settings[key] = clean;
  persistSettings();
  applySetting(key);
  return true;
}
function applySetting(key){
  switch (key){
    case 'theme':
    case 'accentColor': applyAppearance(); break;
    case 'gridSize': state.grid.snapSize = settings.gridSize; renderStage(); break;
    case 'showGrid':
      if (state.grid.show !== settings.showGrid){ state.grid.show = settings.showGrid; renderStage(); }
      syncGridControls(); break;
    case 'snapToGrid': state.grid.snap = settings.snapToGrid; syncGridControls(); break;
    case 'showGuides': state.grid.guides = settings.showGuides; syncGridControls(); break;
    case 'defaultStrokeWidth':
    case 'defaultFill':
    case 'defaultStroke': applyToolDefaults(); break;
    case 'rememberTool': if (settings.rememberTool) rememberLastTool(state.tool); break;
    case 'autosave':
    case 'autosaveInterval':
    case 'autosaveDelay': configureAutosave(); break;
    // toastDuration, canvasSize, defaultZoom, confirmDelete, confirmClose are read where they're used.
  }
}

/* ---------------- appearance: theme + accent ---------------- */
function rgbToHsl(r, g, b){
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d){
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s, l };
}
function hslToHex(h, s, l){
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60){ r = c; g = x; } else if (h < 120){ r = x; g = c; } else if (h < 180){ g = c; b = x; }
  else if (h < 240){ g = x; b = c; } else if (h < 300){ r = x; b = c; } else { r = c; b = x; }
  const to = (v) => clamp(Math.round((v + m) * 255), 0, 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}
function relLuminance(hex){
  const { r, g, b } = hexToRgb(hex);
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastRatio(a, b){
  const la = relLuminance(a), lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// The shipped mint keeps its hand-tuned companions so the default look is unchanged.
const ACCENT_EXACT = { '#5ee1a0': { dim:'#3aa679', ink:'#08251a', hover:'#7ce9b3' } };
/* Everything that derives from the accent, for one theme. `--accent-text` is the accent as
   it appears on *text* (tabs, active chips): it's nudged until it stays readable on the panel color. */
function buildAccentVars(accent, theme){
  const hex = normalizeHexColor(accent) || SETTING_DEFS.accentColor.default;
  const rgb = hexToRgb(hex);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const exact = ACCENT_EXACT[hex];
  const dim = exact ? exact.dim : hslToHex(hsl.h, hsl.s * 0.7, hsl.l * 0.7);
  const hover = exact ? exact.hover : hslToHex(hsl.h, hsl.s, hsl.l > 0.72 ? hsl.l - 0.08 : Math.min(0.92, hsl.l + 0.08));
  const darkInk = exact ? exact.ink : hslToHex(hsl.h, Math.min(hsl.s, 0.5), 0.09);
  const ink = contrastRatio(hex, darkInk) >= contrastRatio(hex, '#ffffff') ? darkInk : '#ffffff';
  const panel = theme === 'light' ? '#f8f9fc' : '#181b23';
  let text = hex, l = hsl.l, guard = 0;
  while (contrastRatio(text, panel) < 4.5 && guard++ < 50){
    l += theme === 'light' ? -0.02 : 0.02;
    text = hslToHex(hsl.h, hsl.s, clamp(l, 0, 1));
  }
  return {
    '--accent': hex, '--accent-rgb': `${rgb.r},${rgb.g},${rgb.b}`, '--accent-dim': dim,
    '--accent-hover': hover, '--accent-ink': ink, '--accent-text': text,
  };
}
function resolveTheme(){
  if (settings.theme !== 'system') return settings.theme;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
}
function applyAppearance(){
  const theme = resolveTheme();
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  const vars = buildAccentVars(settings.accentColor, theme);
  for (const k in vars) root.style.setProperty(k, vars[k]);
  // Cache both variants for the inline <head> script, so a 'system' theme that flips while
  // the app is closed still paints correctly on the next load.
  try {
    localStorage.setItem(SETTINGS_BOOT_KEY, JSON.stringify({
      theme: settings.theme,
      vars: { dark: buildAccentVars(settings.accentColor, 'dark'), light: buildAccentVars(settings.accentColor, 'light') },
    }));
  } catch (e){ /* storage unavailable */ }
}

/* ---------------- canvas & editing ---------------- */
function syncGridControls(){
  [['chkGrid', 'chipGrid', 'show'], ['chkSnap', 'chipSnap', 'snap'], ['chkGuides', 'chipGuides', 'guides']].forEach(([chkId, chipId, prop]) => {
    const chk = document.getElementById(chkId), chip = document.getElementById(chipId);
    if (chk) chk.checked = !!state.grid[prop];
    if (chip) chip.classList.toggle('on', !!state.grid[prop]);
  });
}
// The canvas chips and these settings are two views of the same switches, so flipping a
// chip while you work is remembered next session, exactly like flipping it here.
function wireGridChipSync(){
  [['chkGrid', 'showGrid'], ['chkSnap', 'snapToGrid'], ['chkGuides', 'showGuides']].forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => setSetting(key, el.checked));
  });
}
function applyDefaultZoom(){
  const z = settings.defaultZoom;
  if (z === 'fit'){ fitZoom(); return; }
  const rect = DOM.canvasScroll.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
  state.view.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
  centerStage();
  layoutStage();
  if (state.selectedIds.length && gOverlay) renderSelectionOverlay();
  if (state.hoveredShapeId) updateHoverOutline(state.hoveredShapeId);
}

/* ---------------- tools ---------------- */
// New shapes read state.lastFillColor / lastStrokeColor / lastStrokeWidth (which also track
// whatever you last edited in the inspector). Seeding them from Settings makes the setting
// the starting point, and changing it here takes effect on the very next shape.
function applyToolDefaults(){
  state.lastFillColor = settings.defaultFill;
  state.lastStrokeColor = settings.defaultStroke;
  state.lastStrokeWidth = settings.defaultStrokeWidth;
}
function rememberLastTool(tool){
  if (!settings.rememberTool || RESTORABLE_TOOLS.indexOf(tool) < 0 || settings.lastTool === tool) return;
  settings.lastTool = tool;
  persistSettings();
}
function restoreLastTool(){
  if (settings.rememberTool && settings.lastTool !== 'select') setTool(settings.lastTool);
}

/* ---------------- files & projects: autosave ---------------- */
let __autosaveDebounce = null, __autosaveTicker = null;
function scheduleAutosave(){
  if (!settings.autosave) return;
  updateSaveStatus();
  if (settings.autosaveInterval !== 'afterDelay') return;   // interval modes are driven by the ticker
  clearTimeout(__autosaveDebounce);
  __autosaveDebounce = setTimeout(runAutosave, settings.autosaveDelay);
}
function runAutosave(){
  clearTimeout(__autosaveDebounce);
  if (!settings.autosave || !state.dirty || !state.projectId) return false;
  // Mid-gesture (a drag, or a number field being typed in) the document isn't in a committed state.
  if (__historySnapshotBeforeEdit){
    if (settings.autosaveInterval === 'afterDelay') __autosaveDebounce = setTimeout(runAutosave, 500);
    return false;
  }
  try { persistActiveProject(); return true; }
  catch (err){ showToast('Autosave failed — browser storage may be full'); return false; }
}
function flushAutosave(){ return (settings.autosave && state.dirty && state.projectId) ? runAutosave() : false; }
function configureAutosave(){
  clearTimeout(__autosaveDebounce);
  clearInterval(__autosaveTicker);
  if (settings.autosave && AUTOSAVE_TICK_MS[settings.autosaveInterval]){
    __autosaveTicker = setInterval(runAutosave, AUTOSAVE_TICK_MS[settings.autosaveInterval]);
  }
  if (settings.autosave && settings.autosaveInterval === 'afterDelay' && state.dirty) scheduleAutosave();
  updateSaveStatus();
}
function updateSaveStatus(){
  const el = document.getElementById('saveStatus');
  if (!el) return;
  if (!settings.autosave){ el.hidden = true; return; }
  el.hidden = false;
  let text, stateName;
  if (state.dirty){ text = 'Unsaved changes'; stateName = 'pending'; }
  else if (state.lastSavedAt){
    text = 'Saved ' + new Date(state.lastSavedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    stateName = 'saved';
  } else { text = 'Autosave is on'; stateName = 'saved'; }
  if (el.textContent !== text) el.textContent = text;   // don't re-announce an unchanged status
  el.dataset.state = stateName;
}

/* ---------------- keybinds: customizable shortcuts ---------------- */
/* Every rebindable shortcut, grouped for the Keybinds tab. Delete/Backspace, Escape,
   Enter (mid-draw), arrow-key nudging and the Space-to-pan hold are deliberately left
   out — they're contextual (which element they act on depends on what's selected or
   mid-draw) rather than a single action, so there's nothing sensible to rebind them to. */
const KEYBIND_ACTIONS = {
  undo: () => undo(),
  redo: () => redo(),
  redoAlt: () => redo(),
  cut: () => cutSelectionToClipboard(),
  copy: () => copySelectionToClipboard(),
  paste: () => pasteClipboard(),
  duplicate: () => duplicateSelectionAction(),
  group: () => groupSelectedShapes(),
  ungroup: () => ungroupSelectedShapes(),
  selectAll: () => { selectAllShapes(); renderAll(); },
  save: () => saveProjectFile(),
  openSettingsShortcut: () => openSettings(),
  zoomIn: () => applyZoomAt(state.view.zoom * 1.2),
  zoomOut: () => applyZoomAt(state.view.zoom / 1.2),
  zoomFit: () => fitZoom(),
  zoomActual: () => applyZoomAt(1),
  toolSelect: () => setTool('select'),
  toolNode: () => setTool('node'),
  toolRect: () => setTool('rect'),
  toolEllipse: () => setTool('ellipse'),
  toolArc: () => setTool('arc'),
  toolPolygon: () => setTool('polygon'),
  toolLine: () => setTool('line'),
  toolCurve: () => setTool('curve'),
  toolPen: () => setTool('pen'),
  toolPan: () => setTool('pan'),
  toolCut: () => setTool('cut'),
  toolText: () => setTool('text'),
};
const KEYBIND_DEFS = [
  { id:'undo', label:'Undo', group:'Editing', default:'ctrl+z' },
  { id:'redo', label:'Redo', group:'Editing', default:'ctrl+shift+z' },
  { id:'redoAlt', label:'Redo (alternate)', group:'Editing', default:'ctrl+y' },
  { id:'cut', label:'Cut', group:'Editing', default:'ctrl+x' },
  { id:'copy', label:'Copy', group:'Editing', default:'ctrl+c' },
  { id:'paste', label:'Paste', group:'Editing', default:'ctrl+v' },
  { id:'duplicate', label:'Duplicate', group:'Editing', default:'ctrl+d' },
  { id:'group', label:'Group shapes', group:'Editing', default:'ctrl+g' },
  { id:'ungroup', label:'Ungroup shapes', group:'Editing', default:'ctrl+shift+g' },
  { id:'selectAll', label:'Select all', group:'Editing', default:'ctrl+a' },
  { id:'save', label:'Save project', group:'Editing', default:'ctrl+s' },
  { id:'openSettingsShortcut', label:'Open settings', group:'General', default:'ctrl+,' },
  { id:'zoomIn', label:'Zoom in', group:'View', default:'=' },
  { id:'zoomOut', label:'Zoom out', group:'View', default:'-' },
  { id:'zoomFit', label:'Zoom to fit', group:'View', default:'shift+1' },
  { id:'zoomActual', label:'Zoom to 100%', group:'View', default:'ctrl+0' },
  { id:'toolSelect', label:'Select tool', group:'Tools', default:'v' },
  { id:'toolNode', label:'Edit points tool', group:'Tools', default:'n' },
  { id:'toolRect', label:'Rectangle tool', group:'Tools', default:'r' },
  { id:'toolEllipse', label:'Ellipse tool', group:'Tools', default:'o' },
  { id:'toolArc', label:'Arc tool', group:'Tools', default:'a' },
  { id:'toolPolygon', label:'Polygon / Star tool', group:'Tools', default:'p' },
  { id:'toolLine', label:'Line tool', group:'Tools', default:'l' },
  { id:'toolCurve', label:'Bézier curve tool', group:'Tools', default:'c' },
  { id:'toolPen', label:'Freehand path tool', group:'Tools', default:'f' },
  { id:'toolPan', label:'Pan tool', group:'Tools', default:'h' },
  { id:'toolCut', label:'Cut tool', group:'Tools', default:'k' },
  { id:'toolText', label:'Text tool', group:'Tools', default:'t' },
];
const KEYBIND_GROUP_ORDER = ['General', 'Editing', 'Tools', 'View'];
const KEYBINDS_KEY = 'droidwright.keybinds.v1';
function readKeybindOverrides(){
  try {
    const data = JSON.parse(localStorage.getItem(KEYBINDS_KEY) || '{}');
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch (err){ return {}; }
}
function writeKeybindOverrides(){
  try { localStorage.setItem(KEYBINDS_KEY, JSON.stringify(keybindOverrides)); } catch (err){ /* storage unavailable */ }
}
let keybindOverrides = readKeybindOverrides();
function keybindDef(id){ return KEYBIND_DEFS.find((k) => k.id === id) || null; }
/* A key is missing from keybindOverrides entirely -> use its default. Present but set to
   null/'' -> explicitly cleared (e.g. it was freed up to resolve a conflict), so it has no
   shortcut at all until the person picks one — that's different from "never touched",
   which still means "the default". */
function keybindCombo(id){
  const def = keybindDef(id);
  if (!def) return null;
  if (!(id in keybindOverrides)) return def.default;
  const override = keybindOverrides[id];
  return (typeof override === 'string' && override) ? override : null;
}
function keybindIdForCombo(combo){
  const found = KEYBIND_DEFS.find((def) => keybindCombo(def.id) === combo);
  return found ? found.id : null;
}
function setKeybind(id, combo){
  if (!keybindDef(id)) return;
  keybindOverrides[id] = combo || null;
  writeKeybindOverrides();
  refreshShortcutTooltips();
}
function resetKeybind(id){
  delete keybindOverrides[id];
  writeKeybindOverrides();
  refreshShortcutTooltips();
}
function resetAllKeybinds(){
  keybindOverrides = {};
  writeKeybindOverrides();
  refreshShortcutTooltips();
}
/* Turns a KeyboardEvent into a canonical combo string like "ctrl+shift+z" or "v", in a
   fixed ctrl-alt-shift-key order so it can be compared against a stored binding with
   plain string equality. "+" and "_" are folded onto the physical "=" / "-" keys (with
   shift dropped) so the zoom shortcuts work whether or not the layout needs shift to
   reach the symbol — matching how they behaved before they were rebindable. */
function comboFromEvent(e){
  let key = e.key;
  if (key === ' ') key = 'Space';
  const symbolAlias = { '+':'=', '_':'-' };
  let dropShift = false;
  if (key in symbolAlias){ key = symbolAlias[key]; dropShift = true; }
  if (key.length === 1) key = key.toLowerCase();
  const mod = (e.ctrlKey || e.metaKey) ? 'ctrl+' : '';
  const alt = e.altKey ? 'alt+' : '';
  const shift = (e.shiftKey && !dropShift) ? 'shift+' : '';
  return mod + alt + shift + key;
}
/* True for a keydown that's only a modifier on its own (Control, Shift, Alt, Meta) —
   the capture popup waits past these instead of treating them as the chosen shortcut. */
function isBareModifierKey(e){ return ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key); }
function formatComboPart(part){
  const named = { ctrl:'Ctrl', alt:'Alt', shift:'Shift', '=':'+', space:'Space', enter:'Enter', tab:'Tab' };
  if (named[part]) return named[part];
  if (part.length === 1) return part.toUpperCase();
  return part.charAt(0).toUpperCase() + part.slice(1);
}
function formatCombo(combo){ return combo ? combo.split('+').map(formatComboPart).join('+') : ''; }

/* ---------------- keybinds: tooltips that show the current shortcut ---------------- */
/* Buttons inside #rail have their `title` moved into `data-tip` at init (see wireRail) so
   the custom CSS tooltip renders instead of the native one; everywhere else (topbar,
   Home) keeps a plain `title`. Each entry here is refreshed on init and again whenever a
   binding changes, so a tooltip never goes stale after a rebind. */
const TOOLTIP_BINDINGS = [
  { selector:'#btnUndo', id:'undo', render:(c) => `Undo (${formatCombo(c)})` },
  { selector:'#btnRedo', id:'redo', render:(c) => `Redo (${formatCombo(c)})` },
  { selector:'#btnSettings, #homeSettingsBtn', id:'openSettingsShortcut', render:(c) => `Settings (${formatCombo(c)})` },
  { selector:'[data-tool="select"]', id:'toolSelect', render:(c) => `Select (${formatCombo(c)})` },
  { selector:'[data-tool="rect"]', id:'toolRect', render:(c) => `Rectangle (${formatCombo(c)})` },
  { selector:'[data-tool="ellipse"]', id:'toolEllipse', render:(c) => `Ellipse (${formatCombo(c)})` },
  { selector:'[data-tool="polygon"]', id:'toolPolygon', render:(c) => `Polygon / Star (${formatCombo(c)})` },
  { selector:'[data-tool="line"]', id:'toolLine', render:(c) => `Line (${formatCombo(c)})` },
  { selector:'[data-tool="pen"]', id:'toolPen', render:(c) => `Freehand path (${formatCombo(c)})` },
  { selector:'[data-tool="text"]', id:'toolText', render:(c) => `Text (${formatCombo(c)})` },
  { selector:'[data-tool="node"]', id:'toolNode', render:(c) => `Edit points (${formatCombo(c)})` },
  { selector:'[data-tool="arc"]', id:'toolArc', render:(c) => `Arc — click two endpoints (${formatCombo(c)})` },
  { selector:'[data-tool="curve"]', id:'toolCurve', render:(c) => `Bézier Curve (${formatCombo(c)})` },
  { selector:'[data-tool="cut"]', id:'toolCut', render:(c) => `Cut tool — click points to trace a cutting shape, click the first point (or double-click) to slice it out (${formatCombo(c)})` },
  { selector:'[data-tool="pan"]', id:'toolPan', render:(c) => `Pan (Space / ${formatCombo(c)})` },
  { selector:'#btnZoomIn', id:'zoomIn', render:(c) => `Zoom in (${formatCombo(c)})` },
  { selector:'#btnZoomOut', id:'zoomOut', render:(c) => `Zoom out (${formatCombo(c)})` },
  { selector:'#btnZoomFit', id:'zoomFit', render:(c) => `Zoom to fit (${formatCombo(c)})` },
];
function setTooltipText(el, text){
  if (el.hasAttribute('data-tip') && el.getAttribute('data-tip')) el.dataset.tip = text;
  else el.title = text;
}
function refreshShortcutTooltips(){
  TOOLTIP_BINDINGS.forEach(({ selector, id, render }) => {
    const combo = keybindCombo(id);
    document.querySelectorAll(selector).forEach((el) => setTooltipText(el, render(combo)));
  });
}

/* ---------------- keybinds: "press a key" capture popup ---------------- */
const keybindCaptureUI = { open:false, id:null, listener:null, pendingCombo:null, conflictId:null };
function keybindCaptureEls(){
  return {
    backdrop: document.getElementById('keybindCaptureBackdrop'),
    action: document.getElementById('keybindCaptureAction'),
    preview: document.getElementById('keybindCapturePreview'),
    warn: document.getElementById('keybindCaptureWarn'),
    cancel: document.getElementById('keybindCaptureCancel'),
    reassign: document.getElementById('keybindCaptureReassign'),
  };
}
function closeKeybindCapture(){
  if (!keybindCaptureUI.open) return;
  const { backdrop, reassign } = keybindCaptureEls();
  keybindCaptureUI.open = false;
  keybindCaptureUI.id = null;
  keybindCaptureUI.pendingCombo = null;
  keybindCaptureUI.conflictId = null;
  reassign.hidden = true;
  if (keybindCaptureUI.listener){ window.removeEventListener('keydown', keybindCaptureUI.listener, true); keybindCaptureUI.listener = null; }
  backdrop.classList.remove('show');
  setTimeout(() => { if (!keybindCaptureUI.open) backdrop.hidden = true; }, 180);
}
function openKeybindCapture(id){
  const def = keybindDef(id);
  if (!def) return;
  const { backdrop, action, preview, warn, reassign } = keybindCaptureEls();
  keybindCaptureUI.open = true;
  keybindCaptureUI.id = id;
  keybindCaptureUI.pendingCombo = null;
  keybindCaptureUI.conflictId = null;
  action.textContent = def.label;
  preview.textContent = 'Press a key…';
  preview.className = 'keybind-capture-preview is-listening';
  warn.hidden = true;
  warn.textContent = '';
  reassign.hidden = true;
  backdrop.hidden = false;
  requestAnimationFrame(() => backdrop.classList.add('show'));
  const listener = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape'){ closeKeybindCapture(); return; }
    if (isBareModifierKey(e)) return;   // still waiting — a modifier alone isn't a shortcut
    const combo = comboFromEvent(e);
    const conflictId = keybindIdForCombo(combo);
    if (conflictId && conflictId !== id){
      // Already taken — offer a choice instead of just blocking: back out (Cancel), or
      // take the combo here and free it up on whichever action currently has it.
      keybindCaptureUI.pendingCombo = combo;
      keybindCaptureUI.conflictId = conflictId;
      preview.textContent = formatCombo(combo);
      preview.className = 'keybind-capture-preview is-conflict';
      warn.hidden = false;
      warn.textContent = `“${formatCombo(combo)}” is already used by “${keybindDef(conflictId).label}”.`;
      reassign.hidden = false;
      reassign.textContent = `Use it here, remove from “${keybindDef(conflictId).label}”`;
      return;
    }
    keybindCaptureUI.pendingCombo = null;
    keybindCaptureUI.conflictId = null;
    reassign.hidden = true;
    setKeybind(id, combo);
    renderKeybindsPane();
    closeKeybindCapture();
  };
  keybindCaptureUI.listener = listener;
  window.addEventListener('keydown', listener, true);
}
function wireKeybindCapture(){
  const { backdrop, cancel, reassign } = keybindCaptureEls();
  cancel.addEventListener('click', closeKeybindCapture);
  reassign.addEventListener('click', () => {
    const { id, pendingCombo, conflictId } = keybindCaptureUI;
    if (!id || !pendingCombo || !conflictId) return;
    const freedLabel = keybindDef(conflictId).label;
    setKeybind(conflictId, null);   // explicitly cleared, not just reverted to default
    setKeybind(id, pendingCombo);
    renderKeybindsPane();
    closeKeybindCapture();
    showToast(`“${freedLabel}” no longer has a shortcut`);
  });
  let downOnBackdrop = false;
  backdrop.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => { if (downOnBackdrop && e.target === backdrop) closeKeybindCapture(); downOnBackdrop = false; });
}

/* ---------------- keybinds: the settings-tab pane itself ---------------- */
/* Shared by the Keybinds tab and by a settings search match — same row either place,
   so a rebind made from a search result looks and behaves identically to one made from
   the tab itself, and the tab re-renders itself the same way after either. */
function buildKeybindRow(def, onChange){
  const combo = keybindCombo(def.id);
  const isCustom = def.id in keybindOverrides;
  const row = document.createElement('div');
  row.className = 'setting-row keybind-row' + (isCustom ? ' is-custom' : '');
  const text = document.createElement('div');
  text.className = 'setting-text';
  text.innerHTML = `<span class="setting-label">${escapeHtml(def.label)}</span>`;
  const control = document.createElement('div');
  control.className = 'setting-control keybind-control';
  const badge = document.createElement('kbd');
  badge.className = 'keybind-badge' + (combo ? '' : ' is-unset');
  badge.textContent = combo ? formatCombo(combo) : 'Not set';
  const change = document.createElement('button');
  change.type = 'button'; change.className = 'btn small';
  change.textContent = 'Change';
  change.addEventListener('click', () => openKeybindCapture(def.id));
  const reset = document.createElement('button');
  reset.type = 'button'; reset.className = 'btn small ghost keybind-reset';
  reset.textContent = 'Reset';
  reset.addEventListener('click', () => { resetKeybind(def.id); (onChange || renderKeybindsPane)(); });
  control.append(badge, change, reset);
  row.append(text, control);
  return row;
}
function renderKeybindsPane(){
  const pane = settingsUI.els.pane;
  pane.innerHTML = '';
  KEYBIND_GROUP_ORDER.forEach((groupName) => {
    const defs = KEYBIND_DEFS.filter((d) => d.group === groupName);
    if (!defs.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'keybind-group';
    const heading = document.createElement('h4');
    heading.className = 'keybind-group-title';
    heading.textContent = groupName;
    wrap.appendChild(heading);
    defs.forEach((def) => wrap.appendChild(buildKeybindRow(def)));
    pane.appendChild(wrap);
  });
}

/* ---------------- dialog: schema ---------------- */
const SETTINGS_ICONS = {
  appearance: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  canvas: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  tools: '<path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="m2 2 7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  files: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  keybinds: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9.5 14h5"/>',
};
const SETTINGS_SCHEMA = [
  { id:'appearance', label:'Appearance', icon:SETTINGS_ICONS.appearance,
    blurb:'How Droidwright looks, and how long its confirmations stay on screen.',
    items:[
      { key:'theme', type:'segmented', label:'Theme', hint:'Choose dark or light, or follow your device.',
        options:[{ value:'dark', label:'Dark' }, { value:'light', label:'Light' }, { value:'system', label:'System' }] },
      { key:'accentColor', type:'accent', stacked:true, label:'Accent color', hint:'Used for selection, buttons and highlights across the editor.' },
      { key:'toastDuration', type:'range', label:'Toast duration', hint:'How long messages like “Project saved” stay visible.',
        min:1000, max:10000, step:100, format:(v) => (v / 1000).toFixed(1) + ' s',
        onCommit:(v) => showToast('Messages like this stay for ' + (v / 1000).toFixed(1) + ' s') },
    ] },
  { id:'canvas', label:'Canvas & Editing', icon:SETTINGS_ICONS.canvas,
    blurb:'The artboard, grid and guides you draw against.',
    items:[
      { key:'canvasSize', type:'select', label:'Default canvas size', hint:'Artboard size for new projects. Existing projects keep their own.',
        options:CANVAS_SIZE_CHOICES.map((n) => ({ value:String(n), label:`${n} × ${n} dp` + (n === 24 ? ' (Material icon)' : n === 108 ? ' (adaptive icon layer)' : '') })), parse:Number },
      { key:'gridSize', type:'number', label:'Grid size', hint:'Spacing between grid lines. Snapping uses the same distance.', min:0.25, max:32, step:0.25, unit:'dp' },
      { key:'showGrid', type:'toggle', label:'Show grid', hint:'Draw grid lines over the artboard.' },
      { key:'snapToGrid', type:'toggle', label:'Snap to grid', hint:'Pull points onto grid lines as you draw and move shapes.' },
      { key:'showGuides', type:'toggle', label:'Show guides', hint:'Show alignment guides when a shape lines up with others.' },
      { key:'defaultZoom', type:'select', label:'Default zoom', hint:'Zoom level when a project opens.',
        options:[{ value:'fit', label:'Fit to canvas' }, { value:'0.5', label:'50%' }, { value:'1', label:'100%' }, { value:'2', label:'200%' }, { value:'4', label:'400%' }],
        parse:(v) => v === 'fit' ? 'fit' : Number(v) },
    ] },
  { id:'tools', label:'Tools', icon:SETTINGS_ICONS.tools,
    blurb:'What new shapes look like, and which tool you start with.',
    items:[
      { key:'defaultStrokeWidth', type:'number', label:'Default stroke width', hint:'Stroke width for new shapes and lines.', min:0.25, max:48, step:0.25, unit:'dp' },
      { key:'defaultFill', type:'color', label:'Default fill', hint:'Fill color for new shapes.' },
      { key:'defaultStroke', type:'color', label:'Default stroke', hint:'Stroke color for new shapes and lines.' },
      { key:'rememberTool', type:'toggle', label:'Remember last-used tool', hint:'Start each session with the tool you were using.' },
    ] },
  { id:'files', label:'Files & Projects', icon:SETTINGS_ICONS.files,
    blurb:'Saving, and when Droidwright checks with you first.',
    items:[
      { key:'autosave', type:'toggle', label:'Autosave', hint:'Save the open project to this device as you work.' },
      { key:'autosaveInterval', type:'select', child:true, label:'Autosave interval', hint:'When autosave runs.',
        enabledWhen:(s) => s.autosave,
        options:[{ value:'afterDelay', label:'After a pause in editing' }, { value:'30s', label:'Every 30 seconds' }, { value:'1m', label:'Every minute' }, { value:'5m', label:'Every 5 minutes' }],
        parse:String },
      { key:'autosaveDelay', type:'number', child:true, label:'Auto after delay', hint:'Milliseconds to wait after your last edit before saving.',
        min:250, max:60000, step:250, unit:'ms',
        visibleWhen:(s) => s.autosaveInterval === 'afterDelay', enabledWhen:(s) => s.autosave },
      { key:'confirmDelete', type:'toggle', label:'Confirm before deleting', hint:'Ask before permanently deleting a project from Home.' },
      { key:'confirmClose', type:'toggle', label:'Confirm before closing unsaved projects', hint:'Ask before leaving a project that has unsaved changes.' },
      { key:'dataTransfer', type:'dataTransfer', stacked:true, label:'Data export', hint:'Download every local project, setting and Droidwright preference as a JSON backup. Importing replaces the data in this browser.' },
    ] },
  { id:'keybinds', label:'Keybinds', icon:SETTINGS_ICONS.keybinds,
    blurb:'Every shortcut in Droidwright. Click Change and press a new key to rebind it.',
    items:[] },
];

/* ---------------- dialog: controls ---------------- */
const settingsUI = { open:false, activeId:'appearance', opener:null, closeTimer:null, els:null, rows:[], searchQuery:'' };

function wireRadioGroupKeys(group){
  const step = { ArrowRight:1, ArrowDown:1, ArrowLeft:-1, ArrowUp:-1 };
  group.addEventListener('keydown', (e) => {
    if (!(e.key in step)) return;
    const radios = Array.from(group.querySelectorAll('[role="radio"]:not(:disabled)'));
    const i = radios.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = radios[(i + step[e.key] + radios.length) % radios.length];
    next.focus();
    next.click();
  });
}
function commitFromDialog(key, value){
  setSetting(key, value);
  syncSettingsRows();
  updateSettingRowStates();
}
const SETTING_CONTROLS = {
  toggle(control, item, id){
    const input = document.createElement('input');
    input.type = 'checkbox'; input.className = 'sw'; input.id = id;
    input.addEventListener('change', () => commitFromDialog(item.key, input.checked));
    control.appendChild(input);
    return { input, sync: () => { input.checked = !!settings[item.key]; } };
  },
  select(control, item, id){
    const select = document.createElement('select');
    select.className = 'select'; select.id = id;
    select.innerHTML = item.options.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
    select.addEventListener('change', () => commitFromDialog(item.key, item.parse ? item.parse(select.value) : select.value));
    control.appendChild(select);
    return { input: select, sync: () => { select.value = String(settings[item.key]); } };
  },
  number(control, item, id){
    const wrap = document.createElement('div');
    wrap.className = 'setting-number';
    const input = document.createElement('input');
    input.type = 'number'; input.id = id;
    input.min = item.min; input.max = item.max; input.step = item.step;
    input.addEventListener('change', () => commitFromDialog(item.key, input.value));
    const unit = document.createElement('span');
    unit.className = 'setting-unit'; unit.textContent = item.unit || '';
    wrap.append(input, unit);
    control.appendChild(wrap);
    return { input, sync: () => { input.value = String(settings[item.key]); } };
  },
  range(control, item, id){
    const input = document.createElement('input');
    input.type = 'range'; input.id = id;
    input.min = item.min; input.max = item.max; input.step = item.step;
    const out = document.createElement('output');
    out.className = 'setting-value'; out.htmlFor = id;
    input.addEventListener('input', () => { setSetting(item.key, input.value); out.textContent = item.format(settings[item.key]); });
    input.addEventListener('change', () => { if (item.onCommit) item.onCommit(settings[item.key]); });
    control.append(input, out);
    return { input, sync: () => { if (String(input.value) !== String(settings[item.key])) input.value = settings[item.key]; out.textContent = item.format(settings[item.key]); } };
  },
  dataTransfer(control){
    const wrap = document.createElement('div');
    wrap.className = 'data-transfer-actions';
    const exportButton = document.createElement('button');
    exportButton.type = 'button'; exportButton.className = 'btn primary'; exportButton.textContent = 'Export all data';
    exportButton.addEventListener('click', downloadDataExport);
    const importButton = document.createElement('button');
    importButton.type = 'button'; importButton.className = 'btn'; importButton.textContent = 'Import data';
    importButton.addEventListener('click', () => {
      const input = document.getElementById('dataImportInput');
      if (input) input.click();
    });
    wrap.append(exportButton, importButton);
    control.appendChild(wrap);
    return { input:null, sync: () => {} };
  },
  segmented(control, item, id, labelId){
    const group = document.createElement('div');
    group.className = 'segmented'; group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-labelledby', labelId);
    const buttons = item.options.map((o) => {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.value = o.value; b.textContent = o.label;
      b.addEventListener('click', () => commitFromDialog(item.key, o.value));
      group.appendChild(b);
      return b;
    });
    wireRadioGroupKeys(group);
    control.appendChild(group);
    return { input: null, sync: () => buttons.forEach((b) => {
      const on = b.dataset.value === String(settings[item.key]);
      b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1;
    }) };
  },
  color(control, item, id){
    const field = document.createElement('div');
    field.className = 'color-field';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.innerHTML = '<i></i><input type="color" aria-label="Pick a color">';
    const picker = swatch.querySelector('input'), chip = swatch.querySelector('i');
    const hex = document.createElement('input');
    hex.type = 'text'; hex.className = 'hexinput'; hex.id = id; hex.maxLength = 7; hex.spellcheck = false; hex.autocomplete = 'off';
    picker.addEventListener('input', () => commitFromDialog(item.key, picker.value));
    hex.addEventListener('change', () => commitFromDialog(item.key, hex.value));
    field.append(swatch, hex);
    control.appendChild(field);
    return { input: hex, sync: () => {
      const v = settings[item.key];
      chip.style.background = v; picker.value = v; hex.value = v.toUpperCase();
    } };
  },
  accent(control, item, id, labelId){
    const group = document.createElement('div');
    group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-labelledby', labelId);
    group.style.display = 'contents';
    const check = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    const dots = ACCENT_PRESETS.map((p) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'accent-dot'; b.setAttribute('role', 'radio'); b.dataset.value = p.value;
      b.setAttribute('aria-label', p.name); b.title = p.name;
      b.style.setProperty('--dot', p.value);
      b.style.setProperty('--dot-ink', contrastRatio(p.value, '#0b1512') >= contrastRatio(p.value, '#ffffff') ? '#0b1512' : '#ffffff');
      b.innerHTML = check;
      b.addEventListener('click', () => commitFromDialog(item.key, p.value));
      group.appendChild(b);
      return b;
    });
    wireRadioGroupKeys(group);
    const sep = document.createElement('span'); sep.className = 'accent-picker-sep';
    const custom = document.createElement('span');
    custom.className = 'swatch accent-custom';
    custom.innerHTML = '<i></i><input type="color" aria-label="Custom accent color">';
    const picker = custom.querySelector('input'), chip = custom.querySelector('i');
    picker.addEventListener('input', () => commitFromDialog(item.key, picker.value));
    const hex = document.createElement('input');
    hex.type = 'text'; hex.className = 'hexinput'; hex.id = id; hex.maxLength = 7; hex.spellcheck = false; hex.autocomplete = 'off';
    hex.addEventListener('change', () => commitFromDialog(item.key, hex.value));
    control.append(group, sep, custom, hex);
    return { input: hex, sync: () => {
      const v = settings[item.key];
      let matched = false;
      dots.forEach((d, i) => {
        const on = ACCENT_PRESETS[i].value === v; matched = matched || on;
        d.setAttribute('aria-checked', String(on));
      });
      dots.forEach((d, i) => { d.tabIndex = (d.getAttribute('aria-checked') === 'true' || (!matched && i === 0)) ? 0 : -1; });
      custom.classList.toggle('is-current', !matched);
      chip.style.background = v; picker.value = v; hex.value = v.toUpperCase();
    } };
  },
};

function buildSettingRow(item){
  const row = document.createElement('div');
  row.className = 'setting-row' + (item.child ? ' is-child' : '') + (item.stacked ? ' is-stacked' : '');
  row.dataset.key = item.key;
  const inputId = 'set-' + item.key, labelId = inputId + '-label', hintId = inputId + '-hint';
  const control = document.createElement('div');
  control.className = 'setting-control';
  const built = SETTING_CONTROLS[item.type](control, item, inputId, labelId);
  const text = document.createElement('div');
  text.className = 'setting-text';
  const tag = built.input ? 'label' : 'span';
  text.innerHTML = `<${tag} class="setting-label" id="${labelId}"${built.input ? ` for="${inputId}"` : ''}>${escapeHtml(item.label)}</${tag}>` +
                   `<span class="setting-hint" id="${hintId}">${escapeHtml(item.hint)}</span>`;
  if (built.input) built.input.setAttribute('aria-describedby', hintId);
  row.append(text, control);
  row._sync = built.sync;
  return row;
}
function syncSettingsRows(){ settingsUI.rows.forEach(({ row }) => row._sync()); }
function updateSettingRowStates(){
  settingsUI.rows.forEach(({ item, row }) => {
    row.hidden = item.visibleWhen ? !item.visibleWhen(settings) : false;
    const enabled = item.enabledWhen ? !!item.enabledWhen(settings) : true;
    row.classList.toggle('is-disabled', !enabled);
    row.querySelectorAll('input, select, button').forEach((c) => { c.disabled = !enabled; });
  });
}

/* ---------------- dialog: shell ---------------- */
function activeSettingsCategory(){ return SETTINGS_SCHEMA.find((c) => c.id === settingsUI.activeId) || SETTINGS_SCHEMA[0]; }
function buildSettingsNav(){
  const nav = settingsUI.els.nav;
  nav.innerHTML = '';
  SETTINGS_SCHEMA.forEach((cat) => {
    const tab = document.createElement('button');
    tab.type = 'button'; tab.className = 'settings-tab'; tab.id = 'settings-tab-' + cat.id;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'settingsPane'); tab.dataset.id = cat.id;
    tab.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${cat.icon}</svg><span>${escapeHtml(cat.label)}</span>`;
    tab.addEventListener('click', () => { clearSettingsSearch(); selectSettingsCategory(cat.id); });
    nav.appendChild(tab);
  });
  nav.addEventListener('keydown', (e) => {
    const keys = { ArrowDown:1, ArrowUp:-1, Home:'first', End:'last' };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const ids = SETTINGS_SCHEMA.map((c) => c.id);
    let i = ids.indexOf(settingsUI.activeId);
    if (keys[e.key] === 'first') i = 0; else if (keys[e.key] === 'last') i = ids.length - 1;
    else i = (i + keys[e.key] + ids.length) % ids.length;
    selectSettingsCategory(ids[i], true);
  });
}
function selectSettingsCategory(id, focusTab){
  settingsUI.activeId = id;
  const cat = activeSettingsCategory();
  const { pane, title, desc, reset, nav } = settingsUI.els;
  title.textContent = cat.label;
  desc.textContent = cat.blurb;
  reset.hidden = false;   // a search result view hides it (see renderSettingsSearchResults); undo that here
  reset.textContent = 'Restore ' + cat.label + ' defaults';
  pane.setAttribute('aria-labelledby', 'settings-tab-' + cat.id);
  nav.querySelectorAll('.settings-tab').forEach((tab) => {
    const on = tab.dataset.id === cat.id;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focusTab) tab.focus();
  });
  pane.innerHTML = '';
  settingsUI.rows = [];
  if (cat.id === 'keybinds'){
    renderKeybindsPane();
  } else {
    settingsUI.rows = cat.items.map((item) => {
      const row = buildSettingRow(item);
      pane.appendChild(row);
      return { item, row };
    });
    enhanceNumberInputs(pane);   // same up/down steppers as the inspector
    syncSettingsRows();
    updateSettingRowStates();
  }
  pane.scrollTop = 0;
}
function restoreCategoryDefaults(){
  const cat = activeSettingsCategory();
  if (cat.id === 'keybinds'){
    resetAllKeybinds();
    renderKeybindsPane();
    showToast('Keybinds restored');
    return;
  }
  cat.items.forEach((item) => {
    if (SETTING_DEFS[item.key]) setSetting(item.key, SETTING_DEFS[item.key].default);
  });
  syncSettingsRows();
  updateSettingRowStates();
  showToast(cat.label + ' settings restored');
}

/* ---------------- dialog: search across every tab ---------------- */
/* Matches on the same label/hint text the tabs already show, plus (for Keybinds) the
   group name and the shortcut itself, so typing "ctrl+z" finds Undo as readily as
   typing "undo" does. Typing a tab's own name (e.g. "canvas") surfaces everything on
   that tab, as a quick way to jump straight to it without leaving the search box. */
function settingsSearchMatches(query){
  const q = query.trim().toLowerCase();
  const results = [];
  if (!q) return results;
  SETTINGS_SCHEMA.forEach((cat) => {
    const catMatch = cat.label.toLowerCase().includes(q);
    if (cat.id === 'keybinds'){
      const defs = KEYBIND_DEFS.filter((def) => catMatch
        || def.label.toLowerCase().includes(q)
        || def.group.toLowerCase().includes(q)
        || formatCombo(keybindCombo(def.id)).toLowerCase().includes(q));
      if (defs.length) results.push({ cat, keybindDefs: defs });
      return;
    }
    const items = cat.items.filter((item) => catMatch
      || (item.label && item.label.toLowerCase().includes(q))
      || (item.hint && item.hint.toLowerCase().includes(q)));
    if (items.length) results.push({ cat, items });
  });
  return results;
}
function clearSettingsSearch(){
  const { search, searchClear } = settingsUI.els;
  if (search) search.value = '';
  if (searchClear) searchClear.hidden = true;
  settingsUI.searchQuery = '';
}
function exitSettingsSearchMode(){
  selectSettingsCategory(settingsUI.activeId);   // also puts reset.hidden back
}
function jumpToSettingsCategoryFromSearch(catId){
  clearSettingsSearch();
  selectSettingsCategory(catId, true);
}
function renderSettingsSearchResults(query){
  const { pane, title, desc, reset, nav } = settingsUI.els;
  nav.querySelectorAll('.settings-tab').forEach((tab) => { tab.setAttribute('aria-selected', 'false'); tab.tabIndex = -1; });
  pane.innerHTML = '';
  settingsUI.rows = [];
  const groups = settingsSearchMatches(query);
  const total = groups.reduce((n, g) => n + (g.items ? g.items.length : g.keybindDefs.length), 0);
  title.textContent = 'Search results';
  desc.textContent = total
    ? `${total} setting${total === 1 ? '' : 's'} matching "${query.trim()}"`
    : `Nothing matches "${query.trim()}"`;
  reset.hidden = true;   // "Restore defaults" doesn't make sense against a mixed set of tabs
  if (!total){
    const empty = document.createElement('p');
    empty.className = 'settings-search-empty';
    empty.textContent = `No settings found for “${query.trim()}”. Try a different word, or clear the search to browse by tab.`;
    pane.appendChild(empty);
    return;
  }
  groups.forEach(({ cat, items, keybindDefs }) => {
    const section = document.createElement('div');
    section.className = 'settings-search-group';
    const heading = document.createElement('button');
    heading.type = 'button';
    heading.className = 'settings-search-group-title';
    heading.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${cat.icon}</svg><span>${escapeHtml(cat.label)}</span>`;
    heading.title = `Go to ${cat.label}`;
    heading.addEventListener('click', () => jumpToSettingsCategoryFromSearch(cat.id));
    section.appendChild(heading);
    if (keybindDefs){
      keybindDefs.forEach((def) => section.appendChild(buildKeybindRow(def, () => renderSettingsSearchResults(settingsUI.searchQuery))));
    } else {
      items.forEach((item) => {
        const row = buildSettingRow(item);
        settingsUI.rows.push({ item, row });
        section.appendChild(row);
      });
    }
    pane.appendChild(section);
  });
  enhanceNumberInputs(pane);
  syncSettingsRows();
  updateSettingRowStates();
  pane.scrollTop = 0;
}
function enterSettingsSearchMode(query){
  settingsUI.searchQuery = query;
  renderSettingsSearchResults(query);
}
function wireSettingsSearch(){
  const { search, searchClear } = settingsUI.els;
  if (!search) return;
  search.addEventListener('input', () => {
    const q = search.value;
    searchClear.hidden = !q;
    if (q.trim()) enterSettingsSearchMode(q);
    else exitSettingsSearchMode();
  });
  searchClear.addEventListener('click', () => { clearSettingsSearch(); exitSettingsSearchMode(); search.focus(); });
}
function openSettings(categoryId){
  if (settingsUI.open) return;
  const { backdrop, nav } = settingsUI.els;
  clearTimeout(settingsUI.closeTimer);
  settingsUI.opener = document.activeElement;
  settingsUI.open = true;
  if (categoryId) settingsUI.activeId = categoryId;
  clearSettingsSearch();
  selectSettingsCategory(settingsUI.activeId);
  backdrop.hidden = false;
  requestAnimationFrame(() => backdrop.classList.add('show'));
  const tab = nav.querySelector('.settings-tab[aria-selected="true"]');
  if (tab) tab.focus();
}
function closeSettings(){
  if (!settingsUI.open) return;
  const { backdrop } = settingsUI.els;
  settingsUI.open = false;
  backdrop.classList.remove('show');
  settingsUI.closeTimer = setTimeout(() => { if (!settingsUI.open) backdrop.hidden = true; }, 160);
  const opener = settingsUI.opener;
  if (opener && opener.focus && document.contains(opener)) opener.focus();
}
function trapSettingsFocus(e){
  const focusable = Array.from(settingsUI.els.dialog.querySelectorAll('button, input, select, [tabindex]'))
    .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (!settingsUI.els.dialog.contains(document.activeElement)){ e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
}
function wireSettingsDialog(){
  const $ = (id) => document.getElementById(id);
  settingsUI.els = {
    backdrop: $('settingsBackdrop'), dialog: $('settingsDialog'), nav: $('settingsNav'), pane: $('settingsPane'),
    title: $('settingsPaneTitle'), desc: $('settingsPaneDesc'), reset: $('settingsReset'),
    search: $('settingsSearchInput'), searchClear: $('settingsSearchClear'),
  };
  buildSettingsNav();
  wireSettingsSearch();
  $('settingsClose').addEventListener('click', closeSettings);
  $('settingsDone').addEventListener('click', closeSettings);
  const dataImport = $('dataImportInput');
  if (dataImport) dataImport.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) importDroidwrightDataFile(e.target.files[0]);
    e.target.value = '';
  });
  settingsUI.els.reset.addEventListener('click', restoreCategoryDefaults);
  // Only a press that *starts* on the backdrop dismisses; dragging a slider out of the dialog must not.
  let downOnBackdrop = false;
  settingsUI.els.backdrop.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === settingsUI.els.backdrop; });
  settingsUI.els.backdrop.addEventListener('click', (e) => {
    if (downOnBackdrop && e.target === settingsUI.els.backdrop) closeSettings();
    downOnBackdrop = false;
  });
  ['homeSettingsBtn', 'btnSettings'].forEach((id) => { const b = $(id); if (b) b.addEventListener('click', () => openSettings()); });
  window.addEventListener('keydown', (e) => {
    // While the "press a key" popup is waiting for a shortcut, its own listener (added
    // later, so it runs after this one) owns every keydown — don't let Escape close the
    // whole settings dialog or Ctrl+, fire while it's capturing.
    if (keybindCaptureUI.open) return;
    if (comboFromEvent(e) === keybindCombo('openSettingsShortcut')){ e.preventDefault(); openSettings(); return; }
    if (!settingsUI.open) return;
    if (e.key === 'Escape'){
      e.preventDefault(); e.stopPropagation();
      const { search } = settingsUI.els;
      // Escape while actively searching clears the search box first; press it again
      // (now with nothing to clear) to close the whole dialog, same as anywhere else.
      if (search && document.activeElement === search && search.value){ clearSettingsSearch(); exitSettingsSearchMode(); return; }
      closeSettings();
    }
    else if (e.key === 'Tab') trapSettingsFocus(e);
  }, true);
  wireKeybindCapture();
}

function initSettings(){
  applyAppearance();
  if (window.matchMedia){
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => { if (settings.theme === 'system') applyAppearance(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
  }
  state.grid.show = settings.showGrid;
  state.grid.snap = settings.snapToGrid;
  state.grid.guides = settings.showGuides;
  state.grid.snapSize = settings.gridSize;
  syncGridControls();
  wireGridChipSync();
  applyToolDefaults();
  wireSettingsDialog();
  configureAutosave();
  // A tab that's hidden or closing may never get another chance to save.
  window.addEventListener('pagehide', flushAutosave);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAutosave(); });
  restoreLastTool();
}

