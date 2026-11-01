/* =====================================================================================
   First-run setup ("onboarding") — shown once, the first time the Windows app opens.

   Steps: import a backup from the web version (optional) -> theme -> accent color ->
   default save folder (Windows app only).

   Everything here reuses what already exists instead of keeping a second copy:
     - theme / accent go through setSetting(), so they persist and apply live exactly like
       they do from the Settings dialog;
     - the accent "Custom" swatch opens the same custom color picker (no alpha);
     - backup import reuses the existing "Import data" file input, so it runs the exact
       same importDroidwrightDataFile() the Settings dialog does;
     - the save folder talks to the native bridge (window.NativeBridge, see
       native-bridge.js), which only exists inside the Windows app.

   Open it in a normal browser for testing with  index.html?onboarding=1  (the save-folder
   step is skipped there, since there's no native app to ask).
   ===================================================================================== */
const ONBOARDING_DONE_KEY = 'dw_onboarding_done_v1';
const ONBOARDING_RESUME_KEY = 'dw_onboarding_resume_v1';

(function () {
  let root = null;
  let steps = [];
  let index = 0;
  let importStarted = false;
  let saveRoot = '';
  let importListener = null;

  const isNative = () => !!(window.NativeBridge && window.NativeBridge.isNative);
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage disabled */ } };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) { /* storage disabled */ } };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function needed() {
    if (/[?&]onboarding=1\b/.test(location.search)) return true;
    return isNative() && lsGet(ONBOARDING_DONE_KEY) !== '1';
  }

  /* ---------------- step bodies ---------------- */
  const LIGHT_MOCK = { bg: '#e8ebf1', panel: '#f8f9fc', line: '#cfd4de' };
  const DARK_MOCK = { bg: '#111319', panel: '#181b23', line: '#2a2f3c' };
  const THEMES = [
    { value: 'dark', label: 'Dark', mocks: [{ ...DARK_MOCK }] },
    { value: 'light', label: 'Light', mocks: [{ ...LIGHT_MOCK }] },
    // "System": the same mini window split down the middle, dark on the left, light on the right.
    { value: 'system', label: 'System', mocks: [{ ...DARK_MOCK, cls: 'half-l' }, { ...LIGHT_MOCK, cls: 'half-r' }] },
  ];
  const mockHtml = (m) => `
    <span class="ob-mock ${m.cls || ''}" style="--p-bg:${m.bg};--p-panel:${m.panel};--p-line:${m.line}">
      <i class="ob-p-bar"></i><i class="ob-p-side"></i><i class="ob-p-main"></i>
    </span>`;

  function bodyFor(stepId) {
    if (stepId === 'backup') {
      const canImport = typeof importDroidwrightDataFile === 'function' && !!document.getElementById('dataImportInput');
      return `
        <h2 class="ob-title" id="obTitle">Bring your icons with you</h2>
        <p class="ob-sub">Used Droidwright on the web? In the web version open <b>Settings → Files &amp; Projects → Export all data</b>, then import that file here to carry over every project and preference.</p>
        <div class="ob-actions-center">
          <button type="button" class="btn primary" data-action="choose-backup" ${canImport ? '' : 'disabled'}>Choose backup file…</button>
        </div>
        <p class="ob-status" id="obStatus" role="status" aria-live="polite">${
          canImport
            ? (importStarted ? 'Importing… follow any prompts that appear, then continue.' : 'Starting fresh? Just skip this step.')
            : 'Importing isn’t available in this build.'}</p>`;
    }
    if (stepId === 'theme') {
      return `
        <h2 class="ob-title" id="obTitle">Pick your theme</h2>
        <p class="ob-sub">You can change this any time in Settings → Appearance.</p>
        <div class="ob-themes" role="radiogroup" aria-label="Theme">
          ${THEMES.map((t) => `
            <button type="button" class="ob-theme" role="radio" data-theme="${t.value}">
              <span class="ob-theme-preview">${t.mocks.map(mockHtml).join('')}</span>
              <span class="ob-theme-name">${t.label}</span>
            </button>`).join('')}
        </div>`;
    }
    if (stepId === 'accent') {
      return `
        <h2 class="ob-title" id="obTitle">Choose an accent color</h2>
        <p class="ob-sub">Used for selection, buttons and highlights across the editor.</p>
        <div class="ob-accents" role="radiogroup" aria-label="Accent color">
          ${ACCENT_PRESETS.map((p) => `
            <button type="button" class="ob-accent" role="radio" data-accent="${p.value}" title="${esc(p.name)}" style="--c:${p.value}">
              <span class="ob-accent-dot"></span><span class="ob-accent-name">${esc(p.name)}</span>
            </button>`).join('')}
          <button type="button" class="ob-accent ob-accent-custom" role="radio" data-action="custom-accent" title="Pick any color">
            <span class="ob-accent-dot"></span><span class="ob-accent-name">Custom</span>
          </button>
        </div>`;
    }
    // location
    return `
      <h2 class="ob-title" id="obTitle">Where should exports go?</h2>
      <p class="ob-sub">Files you export (SVG, XML, PNG) are saved to an <b>Exports</b> folder inside this location. It’s created for you.</p>
      <div class="ob-path">
        <code class="ob-path-value" id="obPath">${esc(saveRoot || 'Loading…')}</code>
        <button type="button" class="btn" data-action="pick-folder">Change…</button>
      </div>`;
  }

  /* ---------------- rendering ---------------- */
  function render(animate) {
    const stepId = steps[index];
    const last = index === steps.length - 1;
    const dots = steps.map((s, i) =>
      `<span class="ob-dot${i < index ? ' done' : ''}${i === index ? ' on' : ''}"></span>`).join('');
    const logo = document.querySelector('#topbar .brand .mark svg, .home-brand .mark svg');
    const nextLabel = last ? 'Finish' : (stepId === 'backup' && !importStarted ? 'Skip for now' : 'Continue');
    const nextClass = (stepId === 'backup' && !importStarted) ? 'btn ghost' : 'btn primary';

    root.innerHTML = `
      <div class="ob-card${animate ? ' ob-enter' : ''}" role="dialog" aria-modal="true" aria-labelledby="obTitle">
        <div class="ob-logo" aria-hidden="true">${logo ? logo.outerHTML : ''}</div>
        <div class="ob-progress" aria-label="Step ${index + 1} of ${steps.length}">${dots}</div>
        <div class="ob-body">${bodyFor(stepId)}</div>
        <div class="ob-foot">
          ${index > 0 ? '<button type="button" class="btn ghost" data-action="back">Back</button>' : '<span></span>'}
          <button type="button" class="${nextClass}" data-action="next">${nextLabel}</button>
        </div>
      </div>`;
    syncSelection();
    if (stepId === 'location') loadSaveRoot();
    const first = root.querySelector('.ob-theme.on, .ob-accent.on, .ob-body .btn:not([disabled]), [data-action="next"]');
    if (first) first.focus({ preventScroll: true });
  }

  // Updates which theme / accent looks selected without rebuilding the step — rebuilding
  // while the color picker is open would pull its anchor button out from under it.
  function syncSelection() {
    if (!root) return;
    root.querySelectorAll('.ob-theme').forEach((b) => {
      const on = b.dataset.theme === settings.theme;
      b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
    });
    const accent = String(settings.accentColor || '').toLowerCase();
    let matched = false;
    root.querySelectorAll('.ob-accent[data-accent]').forEach((b) => {
      const on = b.dataset.accent.toLowerCase() === accent;
      matched = matched || on;
      b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
    });
    const custom = root.querySelector('.ob-accent-custom');
    if (custom) {
      custom.classList.toggle('on', !matched);
      custom.setAttribute('aria-checked', String(!matched));
      custom.style.setProperty('--c', matched ? '' : accent);
      custom.classList.toggle('has-color', !matched);
    }
  }

  async function loadSaveRoot() {
    try {
      const paths = await window.NativeBridge.getPaths();
      saveRoot = paths.root || '';
    } catch (e) {
      saveRoot = '';
      toast('Couldn’t read the save folder: ' + e.message);
    }
    const el = root && root.querySelector('#obPath');
    if (el) el.textContent = saveRoot || 'Unknown';
  }

  async function pickFolder() {
    try {
      const picked = await window.NativeBridge.pickFolder();
      if (!picked) return; // dialog cancelled
      saveRoot = await window.NativeBridge.setRootFolder(picked);
      const el = root && root.querySelector('#obPath');
      if (el) el.textContent = saveRoot;
    } catch (e) {
      toast('Couldn’t use that folder: ' + e.message);
    }
  }

  function toast(msg) { if (typeof showToast === 'function') showToast(msg); }

  /* ---------------- flow ---------------- */
  function go(delta) {
    const next = index + delta;
    if (next < 0) return;
    if (next >= steps.length) { finish(); return; }
    index = next;
    render(true);
  }

  function finish() {
    lsSet(ONBOARDING_DONE_KEY, '1');
    lsDel(ONBOARDING_RESUME_KEY);
    if (typeof closeActiveColorPicker === 'function') closeActiveColorPicker(true);
    const input = document.getElementById('dataImportInput');
    if (input && importListener) input.removeEventListener('change', importListener, true);
    importListener = null;
    const el = root;
    root = null;
    el.classList.add('closing');
    setTimeout(() => {
      el.remove();
      if (typeof maybeShowWelcomeModal === 'function') maybeShowWelcomeModal();
    }, 220);
  }

  function onClick(e) {
    const t = e.target.closest('[data-action], .ob-theme, .ob-accent[data-accent]');
    if (!t || !root.contains(t)) return;
    if (t.classList.contains('ob-theme')) { setSetting('theme', t.dataset.theme); syncSelection(); return; }
    if (t.dataset.accent) { setSetting('accentColor', t.dataset.accent); syncSelection(); return; }
    switch (t.dataset.action) {
      case 'next': go(1); break;
      case 'back': go(-1); break;
      case 'choose-backup': document.getElementById('dataImportInput').click(); break;
      case 'pick-folder': pickFolder(); break;
      case 'custom-accent':
        openColorPicker(t, {
          hex: settings.accentColor, showAlpha: false,
          onInput: (hex) => { setSetting('accentColor', hex); syncSelection(); },
          onCommit: (hex) => { setSetting('accentColor', hex); syncSelection(); },
        });
        break;
    }
  }

  function show(force) {
    if (root) return;
    steps = ['backup', 'theme', 'accent'].concat(isNative() ? ['location'] : []);
    index = 0;
    importStarted = false;
    const resume = lsGet(ONBOARDING_RESUME_KEY);
    lsDel(ONBOARDING_RESUME_KEY);
    // A backup import can reload the page; come back to the step after it, not step one.
    if (resume && !force && steps.includes(resume)) index = steps.indexOf(resume);

    root = document.createElement('div');
    root.id = 'onboarding';
    root.addEventListener('click', onClick);
    document.body.appendChild(root);

    // Remember where to resume the moment a backup file is picked — before the existing
    // import handler gets a chance to reload the page.
    const input = document.getElementById('dataImportInput');
    if (input) {
      importListener = (e) => {
        if (!e.target.files || !e.target.files[0]) return;
        lsSet(ONBOARDING_RESUME_KEY, 'theme');
        importStarted = true;
        const status = root && root.querySelector('#obStatus');
        if (status) status.textContent = 'Importing… follow any prompts that appear, then continue.';
        const next = root && root.querySelector('[data-action="next"]');
        if (next) { next.textContent = 'Continue'; next.className = 'btn primary'; }
      };
      input.addEventListener('change', importListener, true);
    }
    render(false);
  }

  // Called once at startup. Returns true when it took over, so the caller can hold back
  // the welcome popup until setup is finished.
  window.maybeShowOnboarding = function () {
    if (!needed()) return false;
    show(false);
    return true;
  };
  // For the Developer settings tab.
  window.showOnboarding = function () { show(true); };
})();
