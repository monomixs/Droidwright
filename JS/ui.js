/* ---------------- mobile block: the vector editor needs a real cursor + a decent
   viewport for precise node/handle work, so it's intentionally desktop-only for now ---------------- */
/* The physical screen's shorter edge, in CSS px. Unlike innerWidth this doesn't move when
   a browser is put into "Desktop site" mode — that toggle changes the layout viewport, not
   the screen object — which is what makes it a reliable phone signal. The threshold sits
   well below ordinary laptop screens (even a cheap 1366×768 laptop has a 768px edge) and
   comfortably above real phones (which top out under ~500px on their narrow edge, even the
   large ones — iPhone 14 Pro Max is 430, Pixel 8 Pro is 412). Tablets land above this too
   and are intentionally let through, matching how the check behaved before this pass. */
function physicalScreenMin(){
  const sw = (window.screen && screen.width) || window.innerWidth;
  const sh = (window.screen && screen.height) || window.innerHeight;
  return Math.min(sw, sh);
}
function hasCoarsePointer(){
  if ((navigator.maxTouchPoints || 0) > 1) return true;
  return window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
}
/* Windows, macOS or desktop Linux is enough on its own — skips the touch/screen-size
   checks below entirely, so window size never matters on a real desktop OS. "X11" is the
   check for Linux rather than the literal word "Linux", because Android's user agent also
   contains "Linux" (it's Linux-based); X11 is the windowing system desktop Linux browsers
   report and Android never does.
   Trade-off: a phone's "Desktop site" mode rewrites the UA to look exactly like one of
   these, on purpose — so a spoofed phone passes this check too. Given the choice between
   occasionally missing a phone in desktop mode and ever blocking a real desktop user,
   this errs toward the latter. */
function isDesktopOS(){
  return /Windows NT|Macintosh|X11/i.test(navigator.userAgent);
}
function isMobileDevice(){
  if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone|BlackBerry|IEMobile/i.test(navigator.userAgent)) return true;
  if (isDesktopOS()) return false;
  // "Desktop site" mode hands out a desktop user-agent and a wide layout viewport, so
  // neither of those can be trusted on its own — but a touchscreen laptop shouldn't be
  // caught by what's left either, hence the low, phone-specific threshold below.
  if (!hasCoarsePointer()) return false;
  if (physicalScreenMin() < 500) return true;
  // Fallback for a touch device with an unusually small browser window.
  return Math.min(window.innerWidth, window.innerHeight) < 760;
}
function checkMobileEditorBlock(){
  if (!DOM.mobileBlockOverlay) return;
  const inEditor = !document.body.classList.contains('home-visible');
  const blocked = inEditor && isMobileDevice();
  DOM.mobileBlockOverlay.classList.toggle('show', blocked);
  // Stop the editor scrolling underneath the overlay while it's up.
  document.body.classList.toggle('mobile-blocked', blocked);
}

/* ---------------- custom number steppers ----------------
   Every type=number input across the app — doc settings, shape geometry, gradient
   controls — gets a matching pair of up/down buttons instead of the browser's native
   spinner. Rather than editing each template that builds one of these inputs, a
   MutationObserver wraps them generically the moment they land in the DOM, so panels
   that get rebuilt wholesale via innerHTML (which is most of them here) are covered
   automatically and stay covered as new fields are added later. */
function stepDecimalPlaces(step){
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}
function fireInputAndChange(input){
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function stepNumberInput(input, dir){
  if (input.disabled || input.readOnly) return;
  const step = parseFloat(input.step) || 1;
  const min = input.min !== '' ? parseFloat(input.min) : -Infinity;
  const max = input.max !== '' ? parseFloat(input.max) : Infinity;
  const base = parseFloat(input.value);
  let next = clamp((isNaN(base) ? 0 : base) + dir * step, min, max);
  const places = stepDecimalPlaces(step);
  const scale = Math.pow(10, places);
  next = Math.round(next * scale) / scale;
  input.value = places > 0 ? next.toFixed(places) : String(next);
  fireInputAndChange(input);
}
function stepperArrowSvg(dir){
  const path = dir > 0 ? 'M1 4l4-4 4 4' : 'M1 1l4 4 4-4';
  return `<svg viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
}
function wrapNumberInput(input){
  if (!input || input.dataset.stepped === '1' || input.dataset.noStepper === '1') return;
  input.dataset.stepped = '1'; // set before moving the node so the observer doesn't re-visit it
  const wrap = document.createElement('span');
  wrap.className = 'num-stepper';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const btns = document.createElement('span');
  btns.className = 'num-stepper-btns';
  btns.innerHTML = `<button type="button" class="num-stepper-btn up" tabindex="-1" aria-label="Increase">${stepperArrowSvg(1)}</button><button type="button" class="num-stepper-btn down" tabindex="-1" aria-label="Decrease">${stepperArrowSvg(-1)}</button>`;
  wrap.appendChild(btns);
  const up = btns.querySelector('.up'), down = btns.querySelector('.down');
  let holdDelay = null, holdInterval = null;
  const stop = () => { clearTimeout(holdDelay); clearInterval(holdInterval); };
  const start = (dir) => {
    stop();
    stepNumberInput(input, dir);
    // A short delay before repeat kicks in, same shape as a scrollbar's autorepeat, so a
    // quick tap doesn't accidentally fire twice.
    holdDelay = setTimeout(() => { holdInterval = setInterval(() => stepNumberInput(input, dir), 70); }, 380);
  };
  up.addEventListener('pointerdown', (e) => { e.preventDefault(); start(1); });
  down.addEventListener('pointerdown', (e) => { e.preventDefault(); start(-1); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(evt => {
    up.addEventListener(evt, stop);
    down.addEventListener(evt, stop);
  });
}
function enhanceNumberInputs(root){
  if (!root) return;
  const scope = root.querySelectorAll ? root : document;
  scope.querySelectorAll('input[type="number"]:not([data-stepped="1"])').forEach(wrapNumberInput);
}
function initNumberSteppers(){
  // Scoped to the panels that actually hold number inputs — not document.body — so the
  // observer stays quiet while the canvas re-renders continuously during a drag.
  const roots = [document.getElementById('tab-design'), DOM.modalBody].filter(Boolean);
  roots.forEach(enhanceNumberInputs);
  if (!roots.length || typeof MutationObserver === 'undefined') return;
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations){
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.matches && node.matches('input[type="number"]')) wrapNumberInput(node);
        else if (node.querySelectorAll) enhanceNumberInputs(node);
      });
    }
  });
  roots.forEach(root => observer.observe(root, { childList: true, subtree: true }));
}

function wireMobileBlock(){
  if (!DOM.mobileBlockOverlay) return;
  const homeBtn = document.getElementById('mobileBlockHomeBtn');
  if (homeBtn) homeBtn.addEventListener('click', () => { showHome(); checkMobileEditorBlock(); });
  window.addEventListener('resize', checkMobileEditorBlock);
  window.addEventListener('orientationchange', checkMobileEditorBlock);
  // Toggling desktop mode re-lays-out the page without always firing a window resize,
  // so watch the visual viewport too.
  if (window.visualViewport && window.visualViewport.addEventListener){
    window.visualViewport.addEventListener('resize', checkMobileEditorBlock);
  }
  if (window.matchMedia){
    const mq = window.matchMedia('(pointer: coarse)');
    if (mq.addEventListener) mq.addEventListener('change', checkMobileEditorBlock);
  }
  new MutationObserver(checkMobileEditorBlock).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  checkMobileEditorBlock();
}

/* ---------------- reference image panel ---------------- */
function toggleReferencePanel(show){
  state.reference.visible = show;
  if (DOM.referencePanel) DOM.referencePanel.classList.toggle('show', show);
  if (DOM.chkReference) DOM.chkReference.checked = show;
  const chip = document.getElementById('chipReference');
  if (chip) chip.classList.toggle('on', show);
}

function loadReferenceImage(src){
  const img = document.getElementById('referenceImg');
  if (!img) return;
  state.reference.src = src;
  state.reference.zoom = 1;
  state.reference.offsetX = 0;
  state.reference.offsetY = 0;
  state.reference.rotation = 0;
  state.reference._sampleCanvas = null;
  img.crossOrigin = 'anonymous';
  img.onerror = () => {
    showToast('Could not load that image — check the URL or try importing a file instead');
  };
  img.onload = () => {
    applyReferenceTransform();
  };
  img.src = src;

  document.getElementById('referenceEmptyState').hidden = true;
  document.getElementById('referenceViewport').hidden = false;
  document.getElementById('referenceControls').hidden = false;
  document.getElementById('referenceSwatch').hidden = true;
  applyReferenceTransform();
}

function clearReferenceImage(){
  const img = document.getElementById('referenceImg');
  if (img){ img.src = ''; img.onload = null; img.onerror = null; }
  state.reference.src = null;
  state.reference._sampleCanvas = null;
  document.getElementById('referenceEmptyState').hidden = false;
  document.getElementById('referenceViewport').hidden = true;
  document.getElementById('referenceControls').hidden = true;
}

function applyReferenceTransform(){
  const img = document.getElementById('referenceImg');
  if (!img) return;
  const r = state.reference;
  img.style.transform = `translate(-50%, -50%) translate(${fmt(r.offsetX)}px, ${fmt(r.offsetY)}px) scale(${fmt(r.zoom)}) rotate(${fmt(r.rotation)}deg)`;
  const zoomLabel = document.getElementById('refZoomLabel');
  if (zoomLabel) zoomLabel.textContent = Math.round(r.zoom * 100) + '%';
  const rotLabel = document.getElementById('refRotateLabel');
  if (rotLabel) rotLabel.textContent = Math.round(r.rotation) + '°';
  const rotSlider = document.getElementById('refRotate');
  if (rotSlider && Number(rotSlider.value) !== Math.round(r.rotation)) rotSlider.value = Math.round(r.rotation);
}

function applyPickedReferenceColor(hex){
  const dot = document.getElementById('referenceSwatchDot');
  const label = document.getElementById('referenceSwatchHex');
  const swatch = document.getElementById('referenceSwatch');
  if (dot) dot.style.background = hex;
  if (label) label.textContent = hex.toUpperCase();
  if (swatch) swatch.hidden = false;

  const sel = selectedShapes().filter(s => !s.locked);
  if (sel.length){
    doAction(() => { for (const s of sel){ s.fillEnabled = true; s.fillColor = hex; } });
    renderAll();
    showToast(`Applied ${hex} to fill`);
  } else {
    state.lastFillColor = hex;
    showToast(`Picked ${hex} — copied to your next fill color`);
  }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(hex).catch(() => {});
  }
}

async function pickReferenceColor(){
  if (!state.reference.src) return;
  if (window.EyeDropper){
    try {
      const ed = new window.EyeDropper();
      const result = await ed.open();
      if (result && result.sRGBHex) applyPickedReferenceColor(result.sRGBHex);
    } catch (err){ /* user cancelled the pick — nothing to do */ }
    return;
  }
  // Fallback for browsers without the native EyeDropper API: sample the reference
  // <img> directly via an offscreen canvas. Only reliable while rotation is 0°,
  // since a rotated element's bounding box no longer maps 1:1 to source pixels.
  if (Math.round(state.reference.rotation) % 360 !== 0){
    showToast('Set rotation back to 0° to pick a color precisely in this browser');
    return;
  }
  state.reference.picking = true;
  document.getElementById('referenceViewport').classList.add('picking');
  showToast('Click anywhere on the reference image to pick a color');
}

function sampleReferencePixelAt(clientX, clientY){
  const img = document.getElementById('referenceImg');
  if (!img || !img.naturalWidth) return;
  let canvas = state.reference._sampleCanvas;
  if (!canvas){
    canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    state.reference._sampleCanvas = canvas;
  }
  const rect = img.getBoundingClientRect();
  const nx = (clientX - rect.left) / rect.width;
  const ny = (clientY - rect.top) / rect.height;
  state.reference.picking = false;
  document.getElementById('referenceViewport').classList.remove('picking');
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
  const px = Math.min(canvas.width - 1, Math.floor(nx * img.naturalWidth));
  const py = Math.min(canvas.height - 1, Math.floor(ny * img.naturalHeight));
  let data;
  try {
    data = canvas.getContext('2d').getImageData(px, py, 1, 1).data;
  } catch (err){
    showToast('Can\u2019t sample this image (cross-origin) — try importing it from your device instead');
    return;
  }
  const hex = '#' + [data[0], data[1], data[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  applyPickedReferenceColor(hex);
}

function wireReferencePanel(){
  if (!DOM.referencePanel) return;

  if (DOM.chkReference){
    DOM.chkReference.addEventListener('change', () => toggleReferencePanel(DOM.chkReference.checked));
  }
  const closeBtn = document.getElementById('btnCloseReference');
  if (closeBtn) closeBtn.addEventListener('click', () => toggleReferencePanel(false));

  const urlInput = document.getElementById('referenceUrlInput');
  const urlApply = document.getElementById('referenceUrlApply');
  const doApplyUrl = () => {
    const v = urlInput.value.trim();
    if (!v) return;
    loadReferenceImage(v);
  };
  if (urlApply) urlApply.addEventListener('click', doApplyUrl);
  if (urlInput) urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doApplyUrl(); });

  const importBtn = document.getElementById('referenceImportBtn');
  const fileInput = document.getElementById('referenceFileInput');
  if (importBtn && fileInput){
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => loadReferenceImage(reader.result);
      reader.readAsDataURL(file);
      fileInput.value = '';
    });
  }

  const swapBtn = document.getElementById('refSwapImage');
  if (swapBtn) swapBtn.addEventListener('click', clearReferenceImage);

  const zoomIn = document.getElementById('refZoomIn');
  const zoomOut = document.getElementById('refZoomOut');
  if (zoomIn) zoomIn.addEventListener('click', () => { state.reference.zoom = clamp(state.reference.zoom * 1.25, 0.02, 10); applyReferenceTransform(); });
  if (zoomOut) zoomOut.addEventListener('click', () => { state.reference.zoom = clamp(state.reference.zoom / 1.25, 0.02, 10); applyReferenceTransform(); });

  const panLeft = document.getElementById('refPanLeft');
  const panRight = document.getElementById('refPanRight');
  if (panLeft) panLeft.addEventListener('click', () => { state.reference.offsetX -= 30; applyReferenceTransform(); });
  if (panRight) panRight.addEventListener('click', () => { state.reference.offsetX += 30; applyReferenceTransform(); });

  const resetBtn = document.getElementById('refResetView');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    state.reference.zoom = 1; state.reference.offsetX = 0; state.reference.offsetY = 0; state.reference.rotation = 0;
    applyReferenceTransform();
  });

  const rotate = document.getElementById('refRotate');
  if (rotate) rotate.addEventListener('input', () => { state.reference.rotation = Number(rotate.value); applyReferenceTransform(); });

  const eyedropperBtn = document.getElementById('refEyedropper');
  if (eyedropperBtn) eyedropperBtn.addEventListener('click', pickReferenceColor);

  // Drag-to-pan directly on the viewport, and wheel-to-zoom for convenience.
  const viewport = document.getElementById('referenceViewport');
  if (viewport){
    viewport.addEventListener('pointerdown', (e) => {
      if (state.reference.picking){ sampleReferencePixelAt(e.clientX, e.clientY); return; }
      if (!state.reference.src) return;
      const startX = e.clientX, startY = e.clientY;
      const origX = state.reference.offsetX, origY = state.reference.offsetY;
      const pointerId = e.pointerId;
      if (pointerId != null && viewport.setPointerCapture) viewport.setPointerCapture(pointerId);
      function onMove(ev){
        state.reference.offsetX = origX + (ev.clientX - startX);
        state.reference.offsetY = origY + (ev.clientY - startY);
        applyReferenceTransform();
      }
      function onUp(){
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    viewport.addEventListener('wheel', (e) => {
      if (!state.reference.src) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1/1.1;
      state.reference.zoom = clamp(state.reference.zoom * factor, 0.02, 10);
      applyReferenceTransform();
    }, { passive: false });
  }
}

function showHome(){
  flushAutosave();
  const goHome = () => {
    state.dirty = false;
    document.body.classList.add('home-visible');
    renderHome();
  };
  if (state.dirty && settings.confirmClose){
    showConfirmModal({
      title: 'Unsaved changes',
      message: 'This project has unsaved changes. Return to the home screen?',
      confirmLabel: 'Return home',
      onConfirm: goHome,
    });
    return;
  }
  goHome();
}
// Clears any stray transient text-loading/error flags that might have been serialized into
// a saved project (e.g. a save that landed mid-fetch) — the shape's baked rawD is already
// valid and displayable regardless, so these should never carry over as false "loading"
// states in a freshly opened project.
function normalizeLoadedShapes(shapes){
  for (const s of shapes || []){
    if (s.type === 'text'){ s.__textLoading = false; s.__textError = null; }
  }
  return shapes;
}
function normalizeLoadedGroups(groups, shapes){
  const out = {};
  if (groups && typeof groups === 'object' && !Array.isArray(groups)){
    for (const [id, raw] of Object.entries(groups)){
      if (!raw || typeof raw !== 'object') continue;
      out[id] = {
        id,
        name: String(raw.name || 'Group').slice(0, 80),
        expanded: raw.expanded !== false,
      };
    }
  }
  for (const shape of shapes || []){
    if (!shape.groupId) continue;
    const id = String(shape.groupId);
    shape.groupId = id;
    if (!out[id]) out[id] = { id, name:'Group', expanded:true };
  }
  return out;
}
function openLocalProject(id){
  const project = readProjects().find(item => item.id === id);
  if (!project) return;
  state.projectId = project.id;
  state.projectName = project.name || project.doc.name;
  state.dirty = false;
  state.doc = Object.assign({}, state.doc, deepClone(project.doc));
  state.shapes = normalizeLoadedShapes(deepClone(project.shapes || []));
  state.groups = normalizeLoadedGroups(project.groups, state.shapes);
  state.selectedIds = [];
  state.history.past = [];
  state.history.future = [];
  state.lastSavedAt = project.updatedAt || null;
  document.body.classList.remove('home-visible');
  syncDocSettingsUI();
  applyDefaultZoom();
  renderAll();
}
function persistActiveProject(){
  if (!state.projectId) return;
  const existing = readProjects().find(project => project.id === state.projectId);
  const projects = readProjects().filter(project => project.id !== state.projectId);
  projects.unshift({
    id: state.projectId,
    name: state.projectName || state.doc.name,
    doc: deepClone(state.doc),
    shapes: deepClone(state.shapes),
    groups: deepClone(state.groups || {}),
    createdAt: (existing && existing.createdAt) || Date.now(),
    updatedAt: Date.now(),
  });
  writeProjects(projects);
  state.dirty = false;
  state.lastSavedAt = Date.now();
  updateSaveStatus();
}
function wireHome(){
  DOM.homeNewProject.addEventListener('click', createProjectFlow);
  DOM.homeImportProject.addEventListener('click', () => document.getElementById('fileImportSvg').click());
  DOM.homeGroupSelected.addEventListener('click', createHomeGroupFromSelection);
  if (DOM.homeInfoBtn) DOM.homeInfoBtn.addEventListener('click', showAboutModal);
  if (DOM.homeChangelogBtn) DOM.homeChangelogBtn.addEventListener('click', showChangelogModal);
  DOM.emptyNewProject.addEventListener('click', createProjectFlow);
  DOM.emptyImportProject.addEventListener('click', () => document.getElementById('fileImportSvg').click());
  DOM.homeSearchInput.addEventListener('input', () => { homeState.query = DOM.homeSearchInput.value; renderHome(); });
  DOM.homeClearSearch.addEventListener('click', () => {
    homeState.query = '';
    DOM.homeSearchInput.value = '';
    renderHome();
    DOM.homeSearchInput.focus();
  });
  DOM.homeSort.addEventListener('click', (e) => {
    const btn = e.target.closest('.sort-btn');
    if (!btn) return;
    homeState.sort = btn.dataset.sort;
    DOM.homeSort.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('on', b === btn));
    renderHome();
  });
}
function saveProjectFile(){
  persistActiveProject();
  showToast('Project saved locally');
}
function loadProjectFromFile(file){
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const payload = JSON.parse(reader.result);
      if (payload && payload.format === DATA_EXPORT_FORMAT){
        importDroidwrightDataPayload(payload);
        return;
      }
      if (!payload || !payload.shapes || !payload.doc) throw new Error('bad file');
      document.body.classList.remove('home-visible');
      doAction(() => {
        state.doc = Object.assign({}, state.doc, payload.doc);
        state.shapes = normalizeLoadedShapes(payload.shapes);
        state.groups = normalizeLoadedGroups(payload.groups, state.shapes);
        state.selectedIds = [];
      });
      syncDocSettingsUI();
      fitZoom();
      renderAll();
      showToast('Project loaded');
    }catch(err){
      showToast('Could not read that project file');
    }
  };
  reader.readAsText(file);
}


/* =====================================================================================
   Part 10: preview strip (real-size swatches)
   ===================================================================================== */
function renderPreviewStrip(){
  const strip = DOM.previewStrip;
  strip.innerHTML = '';
  const sizes = [16, 24, 32, 48, 64];
  const d = state.doc;
  sizes.forEach((px, idx) => {
    ['light','dark'].forEach(mode => {
      const wrap = document.createElement('div');
      wrap.className = 'preview-swatch';
      const frame = document.createElement('div');
      frame.className = 'frame ' + mode;
      const pad = Math.max(6, px*0.3);
      frame.style.width = (px+pad) + 'px';
      frame.style.height = (px+pad) + 'px';
      const svg = svgEl('svg', { viewBox:`0 0 ${d.viewportWidth} ${d.viewportHeight}`, width:px, height:px });
      svg.style.opacity = d.alpha;
      for (const shape of state.shapes){
        if (!shape.visible) continue;
        svg.appendChild(buildShapeVisualGroup(shape));
      }
      frame.appendChild(svg);
      const label = document.createElement('label');
      label.textContent = px + (mode==='dark' ? ' dark' : ' light');
      wrap.appendChild(frame);
      wrap.appendChild(label);
      strip.appendChild(wrap);
    });
    if (idx < sizes.length-1){ const sep = document.createElement('div'); sep.className='vsep'; strip.appendChild(sep); }
  });
}

function renderExportPreview(){
  const frame = document.getElementById('exportPreviewFrame');
  const dimsHint = document.getElementById('exportPopoverDims');
  if (!frame) return;
  const d = state.doc;
  if (dimsHint) dimsHint.textContent = `${fmt(d.viewportWidth)} × ${fmt(d.viewportHeight)} dp`;
  frame.innerHTML = '';
  frame.appendChild(buildExportSvgRoot());
}

/* =====================================================================================
   Part 11: toast / modal helpers
   ===================================================================================== */
let __toastTimer = null;
function showToast(msg){
  DOM.toastMsg.textContent = msg;
  DOM.toast.classList.add('show');
  clearTimeout(__toastTimer);
  __toastTimer = setTimeout(() => DOM.toast.classList.remove('show'), settings.toastDuration);
}
/* Some modals opt into a wider dialog (quick view, the welcome popup). Every modal-
   opening function clears all such variants before applying its own, and closeModal()
   clears them too — otherwise a stale width class could leak from whichever modal was
   open last into the next, unrelated one. Also cancels any pending closing-cleanup
   timer (see closeModal) so a fast reopen doesn't get its width variant yanked out
   from under it a moment later. */
let __modalCloseTimer = null;
function resetModalWidthVariants(){
  if (__modalCloseTimer){ clearTimeout(__modalCloseTimer); __modalCloseTimer = null; }
  homeGroupModalState = null;
  DOM.modalBackdrop.classList.remove('quickview-open', 'welcome-open', 'new-project-open', 'home-group-open');
}
function showModal(opts){
  resetModalWidthVariants();
  DOM.modalTitle.textContent = opts.title;
  DOM.modalBody.className = 'modal-body';
  DOM.modalBody.textContent = opts.body;
  DOM.modalFoot.innerHTML = '';
  for (const act of (opts.actions||[])){
    const b = document.createElement('button');
    b.className = 'btn' + (act.variant==='primary' ? ' primary' : act.variant==='danger' ? ' danger' : ' ghost');
    b.textContent = act.label;
    b.addEventListener('click', () => { if (act.onClick) act.onClick(); });
    DOM.modalFoot.appendChild(b);
  }
  DOM.modalBackdrop.classList.add('show');
}
/* In-app stand-in for window.confirm(). Every spot that used to block on a native
   confirm() dialog now opens this instead, so the prompt matches the rest of the UI
   and works the same way on every platform. Confirming (or cancelling) always closes
   the dialog first, then — only on confirm — runs onConfirm. */
function showConfirmModal(opts){
  const title = opts.title || 'Are you sure?';
  const confirmLabel = opts.confirmLabel || 'Confirm';
  const cancelLabel = opts.cancelLabel || 'Cancel';
  showModal({
    title,
    body: opts.message || '',
    actions: [
      { label: cancelLabel, variant: 'ghost', onClick: () => { closeModal(); if (opts.onCancel) opts.onCancel(); } },
      { label: confirmLabel, variant: opts.danger ? 'danger' : 'primary', onClick: () => { closeModal(); if (opts.onConfirm) opts.onConfirm(); } },
    ],
  });
}
function closeModal(){
  DOM.modalBackdrop.classList.remove('show');
  homeGroupModalState = null;
  // Some modals widen the dialog (the group popup included). Stripping that width
  // variant right away used to make the dialog snap back to its default size mid-
  // fade, which read as a jarring close. Instead let the fade-out transition play
  // at the modal's own width, then drop the variant once it's actually offscreen —
  // whatever opens next ("New project", About, any confirm) still gets its normal
  // width back, just without racing the close animation.
  if (__modalCloseTimer) clearTimeout(__modalCloseTimer);
  __modalCloseTimer = setTimeout(() => { __modalCloseTimer = null; resetModalWidthVariants(); }, 240);
}

function showAboutModal(){
  resetModalWidthVariants();
  DOM.modalTitle.textContent = 'About Droidwright';
  DOM.modalBody.innerHTML = `
    <div class="about-modal-body">
      <div class="about-modal-profile">
        <img class="about-modal-avatar" src="https://github.com/monomixs.png" alt="Wedley" loading="lazy"
             onerror="this.onerror=null;this.src='data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27%3E%3Crect width=%2724%27 height=%2724%27 rx=%2712%27 fill=%27%23282d39%27/%3E%3Ccircle cx=%2712%27 cy=%279%27 r=%274%27 fill=%27%235EE1A0%27/%3E%3Cpath d=%27M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8%27 fill=%27%235EE1A0%27/%3E%3C/svg%3E';">
        <div class="about-modal-who">
          <b>Wedley</b>
          <span>Creator &amp; maintainer of Droidwright</span>
          <a href="https://github.com/monomixs" target="_blank" rel="noopener noreferrer">github.com/monomixs ↗</a>
        </div>
      </div>
      <div class="about-modal-section">
        <b>Droidwright</b> is a local-first editor for building Android <b>vector drawable</b> icons on a real dp grid — draw shapes, arcs, curves and paths, then export clean, ready-to-use XML. Everything is saved straight to this device; nothing is uploaded anywhere.
      </div>
      <div class="about-modal-meta">
        <span>No account needed</span>
        <span>Runs 100% locally</span>
        <span>Exports Android VectorDrawable XML</span>
      </div>
    </div>`;
  DOM.modalFoot.innerHTML = '';
  const close = document.createElement('button');
  close.className = 'btn primary';
  close.textContent = 'Close';
  close.addEventListener('click', closeModal);
  DOM.modalFoot.append(close);
  DOM.modalBackdrop.classList.add('show');
}

/* =====================================================================================
   Changelog (GitHub releases)
   Fetched live from the repo's own release history rather than hand-maintaining a
   second copy of the changelog inside the app — this stays accurate on its own as new
   versions ship. The last successful fetch is cached in localStorage so a temporary
   GitHub outage still shows something instead of a dead end.
   ===================================================================================== */
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/monomixs/Droidwright/releases';
const CHANGELOG_CACHE_KEY = 'dw_changelog_cache_v1';

function readChangelogCache(){
  try {
    const parsed = JSON.parse(localStorage.getItem(CHANGELOG_CACHE_KEY) || 'null');
    return (parsed && Array.isArray(parsed.releases)) ? parsed : null;
  } catch (e){ return null; }
}
function writeChangelogCache(releases){
  try { localStorage.setItem(CHANGELOG_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), releases })); }
  catch (e){ /* private browsing, storage full, etc. — the cache is a nicety, not required */ }
}
function normalizeGithubRelease(r){
  return {
    tag: r.tag_name || '',
    name: r.name || '',
    publishedAt: r.published_at || r.created_at || null,
    body: r.body || '',
    url: r.html_url || '',
    prerelease: !!r.prerelease,
  };
}
function fetchGithubReleases(){
  return fetch(GITHUB_RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } })
    .then(r => { if (!r.ok) throw new Error('GitHub returned ' + r.status); return r.json(); })
    .then(data => {
      if (!Array.isArray(data)) throw new Error('Unexpected response from GitHub');
      const releases = data.filter(r => !r.draft).map(normalizeGithubRelease)
        .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
      writeChangelogCache(releases);
      return releases;
    });
}
function formatReleaseDate(iso){
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
}
/* A small, hand-rolled subset of GitHub-flavored Markdown — headings, bold/italic/
   strikethrough, inline and fenced code, links, blockquotes, horizontal rules, and both
   list types. That covers what release notes actually use in practice, without pulling
   in a full Markdown library for it. Everything is escaped first, and every pass after
   that only ever wraps already-escaped text in tags this function controls — a release
   body is untrusted external text, so nothing in it can inject raw HTML. */
function renderReleaseMarkdown(md){
  if (!md || !String(md).trim()) return '<p class="release-notes-empty">No release notes.</p>';
  const codeBlocks = [];
  // Fenced code blocks are pulled out before any inline-formatting pass touches the
  // text, then spliced back in as <pre><code> at the very end.
  let src = String(md).replace(/\r\n/g, '\n').replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(escapeHtml(code.replace(/\n$/, '')));
    return '\u0000CODEBLOCK' + (codeBlocks.length - 1) + '\u0000';
  });
  src = escapeHtml(src);
  src = src.replace(/^### (.*)$/gm, '<h4>$1</h4>');
  src = src.replace(/^##\s?(.*)$/gm, '<h3>$1</h3>');
  src = src.replace(/^#\s?(.*)$/gm, '<h3>$1</h3>');
  src = src.replace(/^(?:-{3,}|\*{3,})$/gm, '<hr>');
  src = src.replace(/^&gt; ?(.*)$/gm, '<blockquote>$1</blockquote>');
  src = src.replace(/`([^`]+?)`/g, '<code>$1</code>');
  src = src.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  src = src.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  src = src.replace(/__([^_]+?)__/g, '<strong>$1</strong>');
  src = src.replace(/~~([^~]+?)~~/g, '<del>$1</del>');
  src = src.replace(/(^|[^*_\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  src = src.replace(/(^|[^*_\w])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>');
  // Group consecutive bullet/numbered lines into one <ul>/<ol>.
  src = src.replace(/(^|\n)((?:[-*] .*(?:\n|$))+)/g, (m, lead, block) => {
    const items = block.replace(/\n$/, '').split('\n').map(l => '<li>' + l.replace(/^[-*] /, '') + '</li>').join('');
    return lead + '<ul>' + items + '</ul>';
  });
  src = src.replace(/(^|\n)((?:\d+\. .*(?:\n|$))+)/g, (m, lead, block) => {
    const items = block.replace(/\n$/, '').split('\n').map(l => '<li>' + l.replace(/^\d+\. /, '') + '</li>').join('');
    return lead + '<ol>' + items + '</ol>';
  });
  // Blank-line-separated blocks become paragraphs, unless already a block-level tag.
  src = src.split(/\n{2,}/).map(block => {
    const t = block.trim();
    if (!t) return '';
    if (/^<(h[1-6]|ul|ol|blockquote|hr)/.test(t)) return t;
    return '<p>' + t.replace(/\n/g, '<br>') + '</p>';
  }).join('');
  src = src.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => '<pre><code>' + codeBlocks[+i] + '</code></pre>');
  return src;
}
function renderChangelogList(releases, opts){
  const container = document.getElementById('changelogList');
  if (!container) return;
  opts = opts || {};
  if (!releases || !releases.length){
    container.innerHTML = '<div class="fb-status">No published releases yet.</div>';
    return;
  }
  const staleBanner = opts.stale
    ? `<div class="changelog-stale-banner">Showing a cached copy from ${escapeHtml(formatReleaseDate(opts.cachedAt))} — GitHub couldn't be reached just now.</div>`
    : '';
  const itemsHtml = releases.map(r => {
    const title = r.name && r.name.trim() && r.name.trim() !== r.tag ? `<span class="release-name">${escapeHtml(r.name)}</span>` : '';
    return `
      <div class="release-item">
        <div class="release-head">
          <span class="version-badge release-tag">${escapeHtml(r.tag || 'untagged')}</span>
          ${r.prerelease ? '<span class="release-prerelease-tag">Pre-release</span>' : ''}
          ${title}
          <span class="release-date">${escapeHtml(formatReleaseDate(r.publishedAt))}</span>
        </div>
        <div class="release-notes">${renderReleaseMarkdown(r.body)}</div>
        ${r.url ? `<a class="release-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">View on GitHub ↗</a>` : ''}
      </div>`;
  }).join('');
  container.innerHTML = staleBanner + itemsHtml;
}
function loadAndRenderChangelog(){
  fetchGithubReleases().then(releases => {
    if (document.getElementById('changelogList')) renderChangelogList(releases, {});
  }).catch(err => {
    const container = document.getElementById('changelogList');
    if (!container) return; // modal was closed (or reopened fresh) mid-fetch
    const cached = readChangelogCache();
    if (cached && cached.releases.length){
      renderChangelogList(cached.releases, { stale:true, cachedAt: cached.fetchedAt });
    } else {
      container.innerHTML = `<div class="fb-status">Couldn't load the changelog (${escapeHtml(err.message)}).<br><button class="btn small" id="changelogRetry" type="button">Try again</button></div>`;
      const retry = document.getElementById('changelogRetry');
      if (retry) retry.addEventListener('click', () => {
        container.innerHTML = '<div class="fb-status">Loading releases…</div>';
        loadAndRenderChangelog();
      });
    }
  });
}
function showChangelogModal(){
  resetModalWidthVariants();
  DOM.modalBackdrop.classList.add('changelog-open');
  DOM.modalTitle.textContent = 'Changelog';
  DOM.modalBody.innerHTML = '<div class="changelog-modal-body" id="changelogList"><div class="fb-status">Loading releases…</div></div>';
  DOM.modalFoot.innerHTML = '';
  const close = document.createElement('button');
  close.className = 'btn primary';
  close.textContent = 'Close';
  close.addEventListener('click', closeModal);
  DOM.modalFoot.appendChild(close);
  DOM.modalBackdrop.classList.add('show');
  loadAndRenderChangelog();
}

/* The home screen's hero used to show this — headline, subtitle, and the keyline
   illustration — inline, above the project grid, on every single visit. Now it only
   appears once, as a dismissible welcome popup, so a returning user sees their own
   projects immediately instead of scrolling past an intro they've already read. The
   flag is set the moment the popup is shown (not when it's explicitly dismissed), so
   closing it by clicking the backdrop counts the same as clicking "Got it" — either way,
   it's been seen. */
const WELCOME_SEEN_KEY = 'dw_welcome_seen_v1';
function showWelcomeModal(){
  resetModalWidthVariants();
  DOM.modalBackdrop.classList.add('welcome-open');
  DOM.modalTitle.textContent = 'Welcome';
  DOM.modalBody.innerHTML = `
    <div class="welcome-modal-body">
      <div class="welcome-modal-text">
        <p class="eyebrow">Local workspace · no account needed</p>
        <h2>Your icons, precisely drawn.</h2>
        <p class="hero-sub">Build Android vector drawables on a real dp grid, then export clean XML — every project saves straight to this device, nothing leaves it.</p>
      </div>
      <div class="welcome-modal-visual" aria-hidden="true">
        <svg class="keyline-diagram hero-blueprint" viewBox="0 0 200 200" focusable="false">
          <line x1="100" y1="16" x2="100" y2="184" class="bp-cross"/>
          <line x1="16" y1="100" x2="184" y2="100" class="bp-cross"/>
          <rect x="30" y="44" width="140" height="112" class="bp-rect"/>
          <rect x="44" y="30" width="112" height="140" class="bp-rect"/>
          <rect x="37" y="37" width="126" height="126" class="bp-square"/>
          <circle cx="100" cy="100" r="70" class="bp-circle"/>
          <rect x="16" y="16" width="168" height="168" rx="16" class="bp-frame"/>
          <circle cx="16" cy="16" r="2" class="bp-dot"/><circle cx="184" cy="16" r="2" class="bp-dot"/>
          <circle cx="16" cy="184" r="2" class="bp-dot"/><circle cx="184" cy="184" r="2" class="bp-dot"/>
          <circle cx="100" cy="100" r="2" class="bp-dot"/>
        </svg>
        <p class="hero-caption">24dp keyline guide</p>
      </div>
    </div>`;
  DOM.modalFoot.innerHTML = '';
  const gotIt = document.createElement('button');
  gotIt.className = 'btn primary';
  gotIt.textContent = 'Got it';
  gotIt.addEventListener('click', closeModal);
  DOM.modalFoot.appendChild(gotIt);
  DOM.modalBackdrop.classList.add('show');
  try { localStorage.setItem(WELCOME_SEEN_KEY, '1'); } catch (e){ /* private browsing, storage disabled, etc. */ }
}
function maybeShowWelcomeModal(){
  let seen = false;
  try { seen = localStorage.getItem(WELCOME_SEEN_KEY) === '1'; } catch (e){ /* fall through and show it */ }
  if (!seen) showWelcomeModal();
}

function showCreateProjectModal(){
  resetModalWidthVariants();
  DOM.modalTitle.textContent = 'New project';
  DOM.modalBody.className = 'modal-body new-project-modal';
  const initialSize = validCanvasDimension(settings.canvasSize) || 24;
  DOM.modalBody.innerHTML = `
    <label class="modal-input-label" for="newProjectName">Project name</label>
    <input id="newProjectName" class="modal-input" type="text" value="Untitled icon" maxlength="80" autocomplete="off">
    <div class="new-project-section">
      <div class="new-project-section-head"><span>Canvas size</span><small>Choose a preset or enter dimensions</small></div>
      <div class="canvas-preset-grid" id="newCanvasPresets"></div>
      <div class="recent-canvas-sizes" id="recentCanvasSizes"></div>
      <div class="canvas-custom-fields">
        <label>Width <input id="newCanvasWidth" class="modal-input" type="number" min="1" max="4096" step="1" value="${initialSize}" inputmode="numeric"></label>
        <span aria-hidden="true">×</span>
        <label>Height <input id="newCanvasHeight" class="modal-input" type="number" min="1" max="4096" step="1" value="${initialSize}" inputmode="numeric"></label>
        <span class="canvas-unit">dp</span>
      </div>
      <div class="canvas-dimensions-preview" aria-live="polite"><span>New canvas</span><strong id="newCanvasPreview"></strong></div>
    </div>`;
  const nameInput = document.getElementById('newProjectName');
  const widthInput = document.getElementById('newCanvasWidth');
  const heightInput = document.getElementById('newCanvasHeight');
  const preview = document.getElementById('newCanvasPreview');
  const presets = document.getElementById('newCanvasPresets');
  const recent = document.getElementById('recentCanvasSizes');
  const setCanvasSize = (width, height) => {
    widthInput.value = width;
    heightInput.value = height;
    updateCanvasPreview();
  };
  const updateCanvasPreview = () => {
    const width = validCanvasDimension(widthInput.value);
    const height = validCanvasDimension(heightInput.value);
    const valid = Boolean(width && height);
    preview.textContent = valid ? `${fmtAttr(width)} × ${fmtAttr(height)} dp` : 'Enter a size from 1 to 4,096 dp';
    create.disabled = !valid;
    presets.querySelectorAll('.canvas-preset').forEach((button) => {
      button.classList.toggle('active', Number(button.dataset.width) === width && Number(button.dataset.height) === height);
    });
  };
  CANVAS_PRESETS.forEach((preset) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'canvas-preset';
    button.dataset.width = preset.width;
    button.dataset.height = preset.height;
    button.innerHTML = `<b>${preset.label}</b><span>${preset.detail}</span>`;
    button.addEventListener('click', () => setCanvasSize(preset.width, preset.height));
    presets.appendChild(button);
  });
  const recentSizes = readRecentCanvasSizes();
  if (recentSizes.length){
    recent.innerHTML = '<span>Recently used</span>';
    recentSizes.forEach((size) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'recent-canvas-size';
      button.textContent = `${fmtAttr(size.width)} × ${fmtAttr(size.height)} dp`;
      button.addEventListener('click', () => setCanvasSize(size.width, size.height));
      recent.appendChild(button);
    });
  } else {
    recent.innerHTML = '<span class="recent-canvas-empty">Recently used sizes will appear here.</span>';
  }
  DOM.modalFoot.innerHTML = '';
  const cancel = document.createElement('button');
  cancel.className = 'btn ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeModal);
  const create = document.createElement('button');
  create.className = 'btn primary';
  create.textContent = 'Create project';
  create.addEventListener('click', () => {
    const width = validCanvasDimension(widthInput.value);
    const height = validCanvasDimension(heightInput.value);
    if (!width || !height) return;
    startProject(nameInput.value, { width, height });
    closeModal();
  });
  DOM.modalFoot.append(cancel, create);
  DOM.modalBackdrop.classList.add('new-project-open');
  DOM.modalBackdrop.classList.add('show');
  widthInput.addEventListener('input', updateCanvasPreview);
  heightInput.addEventListener('input', updateCanvasPreview);
  updateCanvasPreview();
  nameInput.focus();
  nameInput.select();
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') create.click(); });
}
function newProjectFlow(){
  createProjectFlow();
}
function createProjectFlow(){
  flushAutosave();
  if (state.dirty && settings.confirmClose){
    showConfirmModal({
      title: 'Unsaved changes',
      message: 'This project has unsaved changes. Start a new project anyway?',
      confirmLabel: 'Start new project',
      onConfirm: showCreateProjectModal,
    });
    return;
  }
  showCreateProjectModal();
}
function startProject(name, dimensions){
  const cleanName = String(name || '').trim() || 'Untitled icon';
  const width = validCanvasDimension(dimensions && dimensions.width) || settings.canvasSize;
  const height = validCanvasDimension(dimensions && dimensions.height) || settings.canvasSize;
  const id = 'dw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,6);
  state.projectId = id;
  state.projectName = cleanName;
  state.dirty = false;
  state.doc.name = sanitizeResourceName(cleanName);
  state.doc.width = state.doc.viewportWidth = width;
  state.doc.height = state.doc.viewportHeight = height;
  state.doc.linkSize = true;
  state.lastSavedAt = null;
  state.shapes = [];
  state.groups = {};
  state.selectedIds = [];
  state.history.past = [];
  state.history.future = [];
  rememberCanvasSize(width, height);
  document.body.classList.remove('home-visible');
  syncDocSettingsUI();
  applyDefaultZoom();
  renderAll();
}
function resetProject(){
  doAction(() => {
    state.doc = { name:'ic_custom_icon', width:24, height:24, viewportWidth:24, viewportHeight:24, linkSize:true, tint:'', alpha:1, autoMirrored:false };
    state.shapes = [];
    state.groups = {};
    state.selectedIds = [];
  });
  syncDocSettingsUI();
  fitZoom();
  renderAll();
}


/* =====================================================================================
   Part 13: remaining wiring + bootstrap
   ===================================================================================== */
function switchTab(name){
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab===name));
  document.querySelectorAll('.tabpanel').forEach(p => p.classList.toggle('active', p.id === 'tab-'+name));
}
function wireTabs(){ document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab))); }
function wireXmlEditor(){
  DOM.xmlout.addEventListener('input', () => { updateXmlHighlight(); updateXmlLineNumbers(); validateXmlEditor(); });
  DOM.xmlout.addEventListener('scroll', () => {
    DOM.xmlLines.scrollTop = DOM.xmlout.scrollTop;
    DOM.xmlHighlight.scrollTop = DOM.xmlout.scrollTop;
    DOM.xmlHighlight.scrollLeft = DOM.xmlout.scrollLeft;
  });
  DOM.xmlout.addEventListener('keydown', (e) => {
    if (e.key === 'Tab'){
      e.preventDefault();
      const start = DOM.xmlout.selectionStart, end = DOM.xmlout.selectionEnd;
      DOM.xmlout.setRangeText('    ', start, end, 'end');
      updateXmlLineNumbers();
    }
  });
  document.getElementById('btnApplyXml').addEventListener('click', applyEditedXml);
}
function wirePanelResize(){
  const handle = DOM.panelResizeHandle;
  if (!handle) return;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    document.body.classList.add('panel-resizing');
    if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId);
    function onMove(ev){
      const maxWidth = Math.min(720, window.innerWidth - 72);
      const width = clamp(window.innerWidth - ev.clientX, 260, Math.max(260, maxWidth));
      DOM.rightpanel.style.width = width + 'px';
      DOM.rightpanel.style.minWidth = width + 'px';
      layoutStage();
    }
    function onUp(){
      handle.classList.remove('dragging');
      document.body.classList.remove('panel-resizing');
      if (handle.releasePointerCapture) handle.releasePointerCapture(e.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}
function wireTopbar(){
  DOM.btnHome.addEventListener('click', showHome);
  DOM.btnUndo.addEventListener('click', undo);
  DOM.btnRedo.addEventListener('click', redo);
  document.getElementById('btnNew').addEventListener('click', createProjectFlow);
  document.getElementById('btnImportSvg').addEventListener('click', () => document.getElementById('fileImportSvg').click());
  document.getElementById('fileImportSvg').addEventListener('change', (e) => { if (e.target.files[0]) importSvgFile(e.target.files[0]); e.target.value=''; });
  document.getElementById('btnSaveProject').addEventListener('click', saveProjectFile);
  document.getElementById('btnLoadProject').addEventListener('click', () => document.getElementById('fileLoadProject').click());
  document.getElementById('fileLoadProject').addEventListener('change', (e) => { if (e.target.files[0]) loadProjectFromFile(e.target.files[0]); e.target.value=''; });
  document.getElementById('btnCopyXml').addEventListener('click', copyXmlToClipboard);
  document.getElementById('btnCopyXml2').addEventListener('click', copyXmlToClipboard);
  document.getElementById('btnExportXml2').addEventListener('click', downloadXmlFile);
}
function wireRail(){
  document.querySelectorAll('#rail [title]').forEach(button => {
    if (!button.dataset.tip) button.dataset.tip = button.getAttribute('title');
    button.removeAttribute('title');
  });
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => btn.addEventListener('click', () => {
    // Point editing is an explicit mode: pressing it again returns to normal handles.
    setTool(btn.dataset.tool === 'node' && state.tool === 'node' ? 'select' : btn.dataset.tool);
  }));
  const moreBtn = document.getElementById('btnMoreTools');
  const moreActions = document.getElementById('railMoreActions');
  // Positions the flyout against the button, then clamps it to the actual window size
  // using its own real rendered dimensions — not a hardcoded guess at its height —
  // so adding/removing entries, a small window, or the rail sitting low on a short
  // screen can never push the bottom entry (or the panel itself) off-screen.
  function positionMoreToolsPanel(){
    if (!moreBtn || !moreActions || !DOM.rail.classList.contains('more-open')) return;
    const margin = 10;
    const rect = moreBtn.getBoundingClientRect();
    const panelH = moreActions.offsetHeight;
    const panelW = moreActions.offsetWidth;
    const maxTop = Math.max(margin, window.innerHeight - panelH - margin);
    moreActions.style.top = Math.max(margin, Math.min(rect.top - 8, maxTop)) + 'px';
    // Normally opens to the right of the rail; if that would run off the right edge
    // (a narrow window, or the rail docked on the right), flip it to the left instead.
    const spaceRight = window.innerWidth - (rect.right + 10) - margin;
    if (spaceRight < panelW){
      moreActions.style.left = Math.max(margin, rect.left - 10 - panelW) + 'px';
    } else {
      moreActions.style.left = (rect.right + 10) + 'px';
    }
  }
  if (moreBtn){
    moreBtn.addEventListener('click', () => {
      const open = DOM.rail.classList.toggle('more-open');
      moreBtn.classList.toggle('active', open);
      moreBtn.setAttribute('aria-expanded', String(open));
      if (open) positionMoreToolsPanel();
      layoutStage();
    });
    window.addEventListener('resize', positionMoreToolsPanel);
  }
  document.getElementById('btnZoomIn').addEventListener('click', () => applyZoomAt(state.view.zoom*1.25));
  document.getElementById('btnZoomOut').addEventListener('click', () => applyZoomAt(state.view.zoom/1.25));
  document.getElementById('btnZoomFit').addEventListener('click', fitZoom);
}
function wirePanelVisibility(){
  const body = document.getElementById('body');
  const railBtn = document.getElementById('btnToggleRail');
  const inspectorBtn = document.getElementById('btnToggleRightPanel');
  const previewBtn = document.getElementById('btnTogglePreview');
  const focusBtn = document.getElementById('btnFocusCanvas');
  if (!body || !railBtn || !inspectorBtn || !previewBtn || !focusBtn) return;

  function sync(){
    const railHidden = body.classList.contains('rail-collapsed');
    const inspectorHidden = body.classList.contains('inspector-collapsed');
    const previewHidden = DOM.canvasArea.classList.contains('preview-collapsed');
    const allHidden = railHidden && inspectorHidden && previewHidden;
    railBtn.classList.toggle('active', railHidden);
    inspectorBtn.classList.toggle('active', inspectorHidden);
    previewBtn.classList.toggle('active', previewHidden);
    focusBtn.classList.toggle('active', allHidden);
    railBtn.setAttribute('aria-pressed', String(railHidden));
    inspectorBtn.setAttribute('aria-pressed', String(inspectorHidden));
    previewBtn.setAttribute('aria-pressed', String(previewHidden));
    focusBtn.setAttribute('aria-pressed', String(allHidden));
    railBtn.dataset.tip = railHidden ? 'Show left tools' : 'Hide left tools';
    inspectorBtn.dataset.tip = inspectorHidden ? 'Show inspector' : 'Hide inspector';
    previewBtn.dataset.tip = previewHidden ? 'Show icon previews' : 'Hide icon previews';
    focusBtn.dataset.tip = allHidden ? 'Restore all panels' : 'Focus canvas — hide all panels';
    layoutStage();
  }

  railBtn.addEventListener('click', () => {
    const hiding = !body.classList.contains('rail-collapsed');
    body.classList.toggle('rail-collapsed', hiding);
    if (hiding){
      DOM.rail.classList.remove('more-open');
      document.getElementById('btnMoreTools')?.setAttribute('aria-expanded', 'false');
    }
    sync();
  });
  inspectorBtn.addEventListener('click', () => { body.classList.toggle('inspector-collapsed'); sync(); });
  previewBtn.addEventListener('click', () => { DOM.canvasArea.classList.toggle('preview-collapsed'); sync(); });
  focusBtn.addEventListener('click', () => {
    const restore = body.classList.contains('rail-collapsed') && body.classList.contains('inspector-collapsed') && DOM.canvasArea.classList.contains('preview-collapsed');
    body.classList.toggle('rail-collapsed', !restore);
    body.classList.toggle('inspector-collapsed', !restore);
    DOM.canvasArea.classList.toggle('preview-collapsed', !restore);
    if (!restore) DOM.rail.classList.remove('more-open');
    sync();
  });
  sync();
}
function wireCanvasEvents(){
  DOM.stage.addEventListener('pointerdown', stagePointerDown);
  DOM.stage.addEventListener('pointermove', penMouseMove);
  DOM.stage.addEventListener('dblclick', () => { if (state.tool==='pen' && state.penActive) finalizePen(false); });
  DOM.stage.addEventListener('dblclick', () => { if (state.tool==='cut' && state.cutActive) finalizeCut(); });
  DOM.canvasScroll.addEventListener('pointerdown', (e) => {
    if (e.target === DOM.stage || e.target.namespaceURI === NS_SVG || (e.target.closest && e.target.closest('#stage-svg'))) return;
    if (state.penActive) cancelPen();
    else if (state.cutActive) cancelCut();
    else if (state.lineDraft){ state.lineDraft = null; state.lineHoverPoint = null; state.activeEndpointSnap = null; renderStage(); }
    else if (state.selectedIds.length){ clearSelection(); renderAll(); }
  });
  DOM.canvasScroll.addEventListener('wheel', stageWheel, { passive:false });
  const chkGrid=document.getElementById('chkGrid'), chipGrid=document.getElementById('chipGrid');
  const chkKeyline=document.getElementById('chkKeyline'), chipKeyline=document.getElementById('chipKeyline');
  const chkGuides=document.getElementById('chkGuides'), chipGuides=document.getElementById('chipGuides');
  const chkSnap=document.getElementById('chkSnap'), chipSnap=document.getElementById('chipSnap');
  chkGrid.addEventListener('change', () => { state.grid.show = chkGrid.checked; chipGrid.classList.toggle('on', chkGrid.checked); renderStage(); });
  chkKeyline.addEventListener('change', () => { state.grid.keyline = chkKeyline.checked; chipKeyline.classList.toggle('on', chkKeyline.checked); renderStage(); });
  if (chkGuides && chipGuides){
    chkGuides.addEventListener('change', () => { state.grid.guides = chkGuides.checked; chipGuides.classList.toggle('on', chkGuides.checked); });
  }
  chkSnap.addEventListener('change', () => { state.grid.snap = chkSnap.checked; chipSnap.classList.toggle('on', chkSnap.checked); });
}
let __gradDragActive = false;
function wireSelectionPanels(){
  DOM.selectionPanels.addEventListener('input', onSelectionPanelsInput);
  DOM.selectionPanels.addEventListener('change', onSelectionPanelsChange);
  DOM.selectionPanels.addEventListener('click', onSelectionPanelsClick);
  DOM.selectionPanels.addEventListener('pointerdown', onGradStopHandlePointerDown);
}
/* Which row's vertical band a Y coordinate falls in, clamped to the list. Shared by the
   gradient stop list and the layers list — both drag a set of same-height rows within a
   scrollable container using pointer events instead of native HTML5 drag-and-drop (see
   the comment on onGradStopHandlePointerDown for why). Iterating in order and returning
   on the first row whose bottom edge has been reached treats "in the gap above row i" the
   same as "inside row i" — a fine simplification for short lists of fixed-height rows. */
function rowIndexAtY(rows, y){
  for (let i = 0; i < rows.length; i++){
    if (y <= rows[i].getBoundingClientRect().bottom) return i;
  }
  return rows.length - 1;
}
/* Reorders a gradient's stop list by dragging. Deliberately pointer-events-based rather
   than native HTML5 drag-and-drop: this page already has a window-level dragover/drop
   listener for dropping an SVG or JSON file anywhere on the canvas, and it forces
   dropEffect to 'copy' on every drag it sees — which fights with a reorder drag's
   effectAllowed of 'move' and can make the browser refuse the drop outright. Pointer
   events sidestep that entirely, and work on trackpads and touch where native drag
   doesn't. Hit-testing is done by geometry (which row's band the pointer is over)
   rather than by event target, which stays reliable throughout the gesture. */
function onGradStopHandlePointerDown(e){
  if (e.button != null && e.button !== 0) return;
  const handle = e.target.closest('.drag-handle');
  const row = handle && handle.closest('.grad-stop');
  if (!row || __gradDragActive) return;
  e.preventDefault();
  __gradDragActive = true;
  const list = row.parentElement; // .grad-stops — scoped to this one channel's own stops
  const rows = Array.from(list.querySelectorAll('.grad-stop'));
  const fromIndex = rows.indexOf(row);
  const kind = row.dataset.kind;
  let hoverIndex = fromIndex;
  row.classList.add('dragging');

  function onMove(ev){
    hoverIndex = rowIndexAtY(rows, ev.clientY);
    rows.forEach((r, i) => r.classList.toggle('dragover', i === hoverIndex && i !== fromIndex));
  }
  function onUp(){
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    rows.forEach(r => r.classList.remove('dragging', 'dragover'));
    __gradDragActive = false;
    if (hoverIndex !== fromIndex){
      doAction(() => {
        for (const s of selectedShapes()){
          moveGradientStop(kind === 'stroke' ? s.strokeGradient : s.fillGradient, fromIndex, hoverIndex);
        }
      });
      renderPropertiesPanel();
    }
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}
function wireMisc(){
  document.getElementById('rightpanel').addEventListener('click', (e) => {
    const head = e.target.closest('.section-head');
    if (head && head.closest('.section')) head.closest('.section').classList.toggle('collapsed');
  });
  DOM.modalBackdrop.addEventListener('click', (e) => { if (e.target === DOM.modalBackdrop) closeModal(); });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('beforeunload', (e) => {
    flushAutosave();
    if (!state.dirty || !settings.confirmClose) return;
    e.preventDefault();
    e.returnValue = '';
  });
  window.addEventListener('resize', debounce(() => layoutStage(), 120));

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]){
      const file = e.dataTransfer.files[0];
      if (file.name.toLowerCase().endsWith('.svg') || file.type === 'image/svg+xml'){
        importSvgFile(file);
      } else if (file.name.toLowerCase().endsWith('.json')){
        loadProjectFromFile(file);
      }
    }
  });
}
function debounce(fn, ms){ let t; return function(){ clearTimeout(t); const args = arguments; t = setTimeout(() => fn.apply(null, args), ms); }; }

function wireContextMenu(){
  const menu = document.getElementById('canvasContextMenu');
  if (!menu) return;

  function hideContextMenu(){
    menu.hidden = true;
  }

  DOM.canvasScroll.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const target = e.target;
    const shapeNode = target.closest ? target.closest('.shape-node') : null;
    if (shapeNode){
      const id = shapeNode.dataset.id;
      if (!state.selectedIds.includes(id) && !e.shiftKey){
        selectOnly(id);
        renderAll();
      }
    }

    const selCount = state.selectedIds.length;
    const shapes = selectedShapes();
    const hasGroup = shapes.some(s => s.groupId);
    const hasClipboard = Boolean(state.clipboard && state.clipboard.length);

    // Check if any selected shape is a path or connected line that can be disconnected
    const canDisconnect = shapes.some(s => {
      if (s.type === 'path' && s.rawD){
        const sub = parseSvgPathToSubpaths(s.rawD);
        return sub.length > 1 || (sub.length === 1 && sub[0].points.length >= 2);
      }
      return false;
    });

    const linesOrPaths = shapes.filter(s => isLineShape(s) || (s.type === 'path' && !s.locked));

    // Update disabled states
    menu.querySelectorAll('[data-ctx]').forEach(btn => {
      const act = btn.dataset.ctx;
      if (act === 'paste'){
        btn.disabled = !hasClipboard;
      } else if (act === 'cut' || act === 'copy' || act === 'duplicate' || act === 'delete' || act === 'bringFront' || act === 'sendBack' || act === 'bringForward' || act === 'sendBackward' || act === 'flipH' || act === 'flipV' || act === 'resetTransform'){
        btn.disabled = selCount < 1;
      } else if (act === 'disconnectLines'){
        btn.disabled = !canDisconnect;
      } else if (act === 'connectLines'){
        btn.disabled = linesOrPaths.length < 2;
      } else if (act.startsWith('align') || act.startsWith('distribute') || act.startsWith('bool') || act === 'mergeShapes'){
        btn.disabled = selCount < 2;
      } else if (act === 'group'){
        btn.disabled = selCount < 2;
      } else if (act === 'ungroup'){
        btn.disabled = !hasGroup;
      }
    });

    menu.hidden = false;
    const menuWidth = 230, menuHeight = Math.min(500, window.innerHeight - 30);
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 12);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 12);
    menu.style.left = Math.max(10, x) + 'px';
    menu.style.top = Math.max(10, y) + 'px';
  });

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ctx]');
    if (!btn || btn.disabled) return;
    const action = btn.dataset.ctx;
    hideContextMenu();
    handlePropertiesAction(action);
  });

  window.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target)){
      hideContextMenu();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden){
      hideContextMenu();
    }
  });
}

// ---- Font Browser popover ----
let __fontBrowserState = { category: 'all', search: '', visibleCount: 60, targetShapeId: null };
const __fontPreviewLoadedFamilies = new Set();
// Loads real @font-face CSS (Google's public, key-less CSS2 endpoint) for whichever
// families are actually visible in the list right now, so entries preview in their own
// typeface without needing to fetch/parse the full font file (that heavier opentype.js
// path only happens once a font is actually applied to a shape).
function loadFontPreviewCss(families){
  const toLoad = families.filter(f => !__fontPreviewLoadedFamilies.has(f));
  if (!toLoad.length) return;
  toLoad.forEach(f => __fontPreviewLoadedFamilies.add(f));
  const params = toLoad.map(f => 'family=' + encodeURIComponent(f).replace(/%20/g, '+')).join('&');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?${params}&display=swap`;
  document.head.appendChild(link);
}
function renderFontBrowserList(){
  const container = document.getElementById('fontBrowserList');
  if (!container) return;
  if (!__googleFontsList){
    container.innerHTML = '<div class="fb-status">Loading fonts…</div>';
    return;
  }
  const st = __fontBrowserState;
  const q = st.search.trim().toLowerCase();
  const filtered = __googleFontsList.filter(f => {
    if (st.category !== 'all' && f.category !== st.category) return false;
    if (q && f.family.toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
  if (!filtered.length){
    container.innerHTML = '<div class="fb-status">No fonts match your search.</div>';
    return;
  }
  const visible = filtered.slice(0, st.visibleCount);
  loadFontPreviewCss(visible.map(f => f.family));
  const shape = state.shapes.find(s => s.id === st.targetShapeId);
  const itemsHtml = visible.map(f => `
    <button class="fb-item${shape && shape.fontFamily === f.family ? ' selected' : ''}" data-family="${escapeHtml(f.family)}" style="font-family:'${escapeHtml(f.family)}',sans-serif;">
      <span class="fb-item-name">${escapeHtml(f.family)}</span>
      <span class="fb-item-meta">${escapeHtml(f.category || '')}</span>
    </button>`).join('');
  const moreHtml = filtered.length > visible.length
    ? `<button class="fb-loadmore" id="fbLoadMore">Show more (${filtered.length - visible.length} more)</button>` : '';
  container.innerHTML = itemsHtml + moreHtml;
}
function openFontBrowserForSelection(){
  const shape = selectedShapes().find(s => s.type === 'text');
  if (!shape) return;
  const popover = document.getElementById('fontBrowserPopover');
  const btn = document.querySelector('#selectionPanels [data-action="openFontBrowser"]');
  if (!popover) return;
  __fontBrowserState = { category: 'all', search: '', visibleCount: 60, targetShapeId: shape.id };
  document.getElementById('fontBrowserSearch').value = '';
  document.querySelectorAll('#fontBrowserCategories .fb-cat').forEach(b => b.classList.toggle('active', b.dataset.category === 'all'));
  popover.hidden = false;
  if (btn){
    const rect = btn.getBoundingClientRect();
    popover.style.left = Math.max(10, Math.min(window.innerWidth - 312, rect.left)) + 'px';
    popover.style.top = Math.max(10, Math.min(window.innerHeight - 430, rect.bottom + 8)) + 'px';
  }
  renderFontBrowserList();
  fetchGoogleFontsList().then(() => renderFontBrowserList()).catch(err => {
    const container = document.getElementById('fontBrowserList');
    if (container) container.innerHTML = `<div class="fb-status">Couldn't load the font list (${escapeHtml(err.message)}). Check your connection and try again.</div>`;
  });
}
function selectFontForTargetShape(family){
  const shape = state.shapes.find(s => s.id === __fontBrowserState.targetShapeId);
  if (!shape) return;
  const info = getFontVariantsInfo(family);
  beginEdit();
  shape.fontFamily = family;
  if (!info.weights.includes(shape.fontWeight)) shape.fontWeight = info.weights.includes(400) ? 400 : info.weights[0];
  if (shape.fontItalic && !info.hasItalic) shape.fontItalic = false;
  const popover = document.getElementById('fontBrowserPopover');
  if (popover) popover.hidden = true;
  renderPropertiesPanel();
  renderStage();
  regenerateTextPath(shape).catch(err => showToast('Font error: ' + err.message)).then(() => { commitEdit(); renderAll(); });
}
function wireFontBrowserPopover(){
  const popover = document.getElementById('fontBrowserPopover');
  if (!popover) return;
  const closeBtn = document.getElementById('btnCloseFontBrowser');
  const searchInput = document.getElementById('fontBrowserSearch');
  const catRow = document.getElementById('fontBrowserCategories');
  const list = document.getElementById('fontBrowserList');

  closeBtn.addEventListener('click', () => { popover.hidden = true; });
  searchInput.addEventListener('input', () => {
    __fontBrowserState.search = searchInput.value;
    __fontBrowserState.visibleCount = 60;
    renderFontBrowserList();
  });
  catRow.addEventListener('click', (e) => {
    const btn = e.target.closest('.fb-cat');
    if (!btn) return;
    __fontBrowserState.category = btn.dataset.category;
    __fontBrowserState.visibleCount = 60;
    catRow.querySelectorAll('.fb-cat').forEach(b => b.classList.toggle('active', b === btn));
    renderFontBrowserList();
  });
  list.addEventListener('click', (e) => {
    if (e.target.closest('#fbLoadMore')){ __fontBrowserState.visibleCount += 60; renderFontBrowserList(); return; }
    const item = e.target.closest('.fb-item');
    if (item) selectFontForTargetShape(item.dataset.family);
  });
  window.addEventListener('pointerdown', (e) => {
    if (!popover.hidden && !popover.contains(e.target) && !e.target.closest('[data-action="openFontBrowser"]')){
      popover.hidden = true;
    }
  });
}

function wireExportPopover(){
  const btn = document.getElementById('btnExportMenu');
  const popover = document.getElementById('exportPopover');
  const formatSelect = document.getElementById('exportFormatSelect');
  const pngSizeField = document.getElementById('exportPngSizeField');
  const pngSizeSelect = document.getElementById('exportPngSize');
  const downloadBtn = document.getElementById('btnExportDownload');
  if (!btn || !popover) return;

  function syncFormatUI(){
    const format = formatSelect.value;
    pngSizeField.hidden = format !== 'png';
    downloadBtn.textContent = 'Download .' + format;
  }

  function openPopover(){
    renderExportPreview();
    syncFormatUI();
    const rect = btn.getBoundingClientRect();
    popover.hidden = false;
    btn.classList.add('active');
    popover.style.left = Math.max(10, rect.right - 260) + 'px';
    popover.style.top = (rect.bottom + 8) + 'px';
  }
  function closePopover(){
    popover.hidden = true;
    btn.classList.remove('active');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popover.hidden) openPopover(); else closePopover();
  });

  formatSelect.addEventListener('change', syncFormatUI);

  downloadBtn.addEventListener('click', () => {
    const format = formatSelect.value;
    if (format === 'xml') downloadXmlFile();
    else if (format === 'svg') downloadSvgFile();
    else if (format === 'png') downloadPngFile(parseInt(pngSizeSelect.value, 10));
    closePopover();
  });

  window.addEventListener('pointerdown', (e) => {
    if (!popover.hidden && !popover.contains(e.target) && e.target !== btn && !btn.contains(e.target)){
      closePopover();
    }
  });
}

function wireBooleanPopover(){
  const btn = document.getElementById('btnBoolean');
  const popover = document.getElementById('booleanMenuPopover');
  if (!btn || !popover) return;

  function togglePopover(){
    if (!popover.hidden){
      popover.hidden = true;
      btn.classList.remove('active');
      return;
    }

    const selCount = state.selectedIds.length;
    const hint = document.getElementById('boolSelectionHint');
    if (hint){
      hint.textContent = selCount >= 2 
        ? `${selCount} shapes selected — ready to merge or cut`
        : 'Select 2 or more shapes on canvas';
      hint.style.color = selCount >= 2 ? 'var(--accent-text)' : 'var(--text-2)';
    }

    popover.querySelectorAll('[data-bool]').forEach(b => {
      b.disabled = selCount < 2;
    });

    const rect = btn.getBoundingClientRect();
    popover.hidden = false;
    btn.classList.add('active');
    popover.style.left = (rect.right + 8) + 'px';
    popover.style.top = Math.max(10, Math.min(rect.top - 20, window.innerHeight - 300)) + 'px';
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePopover();
  });

  popover.addEventListener('click', (e) => {
    const boolBtn = e.target.closest('[data-bool]');
    if (boolBtn && !boolBtn.disabled){
      popover.hidden = true;
      btn.classList.remove('active');
      performBooleanOp(boolBtn.dataset.bool);
      return;
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

/* ---------------- hover outline for unselected shapes ---------------- */
// Rotation-aware stage bounding box for a local rect under a shape's full transform.
// getShapeStageBounds() (used everywhere else, e.g. alignment guides) deliberately ignores
// rotation for path/curve/text shapes — fine there since it's paired with a big fixed
// padding — but the text hover rectangle needs the real rotated extent, or a rotated/tilted
// text box can end up visibly clipped against the mask's own region and look like it
// doesn't match the shape's actual handle box.
function rotatedLocalRectStageBounds(shape, lb){
  const p = shapeLocalPivot(shape);
  const tx = shape.translateX || 0, ty = shape.translateY || 0;
  const rot = (shape.rotation || 0) * Math.PI / 180;
  const sx = shape.scaleX || 1, sy = shape.scaleY || 1;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const corners = [
    [lb.x, lb.y], [lb.x + lb.width, lb.y],
    [lb.x + lb.width, lb.y + lb.height], [lb.x, lb.y + lb.height],
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [cx0, cy0] of corners){
    // Same order as shapeGroupTransformStr: translate(-pivot) -> scale -> rotate -> translate(pivot+translate)
    let x = (cx0 - p.x) * sx, y = (cy0 - p.y) * sy;
    const rx = x * cos - y * sin, ry = x * sin + y * cos;
    const fx = rx + p.x + tx, fy = ry + p.y + ty;
    if (fx < minX) minX = fx; if (fx > maxX) maxX = fx;
    if (fy < minY) minY = fy; if (fy > maxY) maxY = fy;
  }
  const w = maxX - minX, h = maxY - minY;
  return { x: minX, y: minY, width: w, height: h, right: maxX, bottom: maxY, cx: minX + w/2, cy: minY + h/2 };
}
function updateHoverOutline(shapeId){
  if (!gHoverOutline) return;
  gHoverOutline.innerHTML = '';
  if (!shapeId) return;
  if (!(state.tool === 'select' || state.tool === 'node')) return;
  if (state.selectedIds.includes(shapeId)) return;
  const shape = findShapeById(shapeId);
  if (!shape || !shape.visible || shape.locked) return;

  // Hovering a grouped shape previews the whole group, since that's what a click here
  // would actually select and drag (see stagePointerDown) — hold Ctrl/Cmd to preview
  // (and then select/drag) just this one shape instead. Node-editing is always
  // single-shape regardless, since it works on one shape's own path points.
  const editIndividual = state.editIndividualHeld;
  const groupTargets = (!editIndividual && state.tool === 'select' && shape.groupId)
    ? state.shapes.filter((s) => s.groupId === shape.groupId && s.visible && !s.locked && !state.selectedIds.includes(s.id))
    : null;
  if (groupTargets && groupTargets.length){
    groupTargets.forEach(appendHoverRing);
  } else {
    appendHoverRing(shape);
  }
}
function appendHoverRing(shape){
  // Text (and anything converted from text — see convertShapeToPathShape) traces as a
  // plain rectangle instead of the actual letterform outlines: those are typically dozens
  // of small subpaths, several with hole/counter contours (the inside of an "o", "e", "a"),
  // and the ring-via-stroke technique below strokes every subpath individually — so a real
  // glyph trace also draws a spurious extra ring around the inside of every letter's
  // counter, on top of the real outer ring. A rectangle sidesteps that entirely. It's built
  // from visualHandleBBox (the same stroke-aware box the selection handles use) rather than
  // the raw fill-only bounds, so it fully encloses the text even when a stroke is applied,
  // and still follows the shape's rotation/scale via the same transform used to draw it.
  const isTextLike = shape.type === 'text' || shape.__fromText;
  let d, extraTransform = '';
  if (isTextLike){
    const lb = visualHandleBBox(shape);
    d = `M${fmt(lb.x)},${fmt(lb.y)} L${fmt(lb.x+lb.width)},${fmt(lb.y)} L${fmt(lb.x+lb.width)},${fmt(lb.y+lb.height)} L${fmt(lb.x)},${fmt(lb.y+lb.height)} Z`;
    extraTransform = shapeGroupTransformStr(shape);
  } else {
    d = getShapeTransformedPath(shape);
  }
  if (!d) return;

  // Trace a thin ring that hugs the OUTSIDE of the shape's real visible silhouette
  // (fill + stroke), using only native SVG stroke rendering — never our own polygon
  // offset/union math — so joins (miter/bevel/round) and concave outlines like a star
  // always come out geometrically correct and smooth, at any stroke width.
  //
  // How: stroke the same path at (real stroke width + a small margin on each side),
  // then mask away everything covering the shape's own real silhouette, leaving only
  // the thin outer band visible.
  // For the rectangle case, the shape's real stroke is already folded into visualHandleBBox
  // above, so the ring here only needs its own small cosmetic margin, not the stroke width
  // again on top.
  const strokeExtent = (!isTextLike && shape.strokeEnabled) ? Math.max(0, Number(shape.strokeWidth) || 0) : 0;
  const hasFill = isTextLike ? true : !!shape.fillEnabled;
  const hasStroke = strokeExtent > 0;
  const cap = shape.strokeLineCap || 'round';
  const join = shape.strokeLineJoin || 'round';
  const miter = shape.strokeMiterLimit || 4;
  const fillRule = shape.fillType === 'evenOdd' ? 'evenodd' : 'nonzero';

  const z = state.view.zoom || 1;
  const margin = 2.2 / (PX_PER_UNIT * z);
  const ringWidth = strokeExtent + margin * 2;

  const b = isTextLike ? rotatedLocalRectStageBounds(shape, visualHandleBBox(shape)) : getShapeStageBounds(shape);
  const pad = Math.max(ringWidth, 40);
  const maskId = 'hoverMask_' + shape.id;

  // NOTE: maskUnits is 'userSpaceOnUse', but that only governs the coordinate system for
  // the mask's *content*. The <mask> element's own region (its x/y/width/height) defaults
  // to -10%/-10%/120%/120% of the current SVG viewport when left unset — NOT the shape's
  // bounding box — so without explicit x/y/width/height here, any shape sitting outside
  // the artboard/bleed viewport gets silently clipped by the mask region itself before its
  // content is even considered, making the hover ring vanish for shapes far from center.
  // Setting them explicitly to the same rect we mask ensures the mask always covers the
  // shape regardless of where it sits on the canvas.
  const mask = svgEl('mask', {
    id: maskId, maskUnits: 'userSpaceOnUse',
    x: b.x - pad, y: b.y - pad, width: b.width + pad*2, height: b.height + pad*2,
  });
  mask.appendChild(svgEl('rect', { x: b.x - pad, y: b.y - pad, width: b.width + pad*2, height: b.height + pad*2, fill: 'white' }));
  mask.appendChild(svgEl('path', {
    d,
    ...(extraTransform ? { transform: extraTransform } : {}),
    fill: hasFill ? 'black' : 'none',
    stroke: hasStroke ? 'black' : 'none',
    'stroke-width': strokeExtent,
    'stroke-linecap': cap,
    'stroke-linejoin': join,
    'stroke-miterlimit': miter,
    'fill-rule': fillRule,
  }));
  gHoverOutline.appendChild(mask);

  gHoverOutline.appendChild(svgEl('path', {
    d, class: 'hover-outline-path',
    ...(extraTransform ? { transform: extraTransform } : {}),
    'stroke-width': ringWidth,
    'stroke-linecap': cap,
    'stroke-linejoin': join,
    'stroke-miterlimit': miter,
    mask: `url(#${maskId})`,
  }));
}
function wireCanvasHoverOutline(){
  if (!gShapes) return;
  gShapes.addEventListener('pointerover', (e) => {
    const node = e.target.closest ? e.target.closest('.shape-node') : null;
    if (!node) return;
    state.hoveredShapeId = node.dataset.id;
    state.editIndividualHeld = e.ctrlKey || e.metaKey;
    updateHoverOutline(state.hoveredShapeId);
  });
  gShapes.addEventListener('pointerout', (e) => {
    const node = e.target.closest ? e.target.closest('.shape-node') : null;
    if (!node) return;
    if (e.relatedTarget && node.contains && node.contains(e.relatedTarget)) return;
    state.hoveredShapeId = null;
    if (gHoverOutline) gHoverOutline.innerHTML = '';
  });
  DOM.stage.addEventListener('pointerleave', () => {
    state.hoveredShapeId = null;
    if (gHoverOutline) gHoverOutline.innerHTML = '';
  });
  // Pressing/releasing Ctrl or Cmd while already hovering a grouped shape (no mouse
  // movement needed) flips the hover ring between the whole group and just that shape,
  // so it always previews exactly what a click would select right now.
  const syncEditIndividual = (e) => {
    if (!(e.key === 'Control' || e.key === 'Meta')) return;
    const held = e.ctrlKey || e.metaKey;
    if (held === state.editIndividualHeld) return;
    state.editIndividualHeld = held;
    if (state.hoveredShapeId) updateHoverOutline(state.hoveredShapeId);
  };
  window.addEventListener('keydown', syncEditIndividual);
  window.addEventListener('keyup', syncEditIndividual);
  window.addEventListener('blur', () => { state.editIndividualHeld = false; });
}

