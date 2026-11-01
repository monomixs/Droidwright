/* =====================================================================================
   Windows app: the website IS the title bar.

   Inside the native app Windows draws no title bar of its own. The site's top bars (the
   editor bar and the home-screen bar) take that place, and this file adds what a title bar
   needs:

     - minimize / maximize-restore / close buttons, docked top-right
     - drag the top bar to move the window (and drag it off a maximized window to restore it)
     - double-click the top bar to maximize / restore
     - a thin grab strip along the very top edge, so the window can still be resized from there

   In a normal browser (no native bridge) this file does nothing, so the website is unaffected.
   Needs native-bridge.js to be loaded first. Styles live in style.css ("NATIVE WINDOW CHROME").
   ===================================================================================== */
(function () {
  'use strict';

  const nb = window.NativeBridge;
  if (!nb || !nb.isNative) return;

  // Set immediately (this script runs in <head>) so the top bars reserve room for the
  // buttons from the very first paint instead of jumping once the page has loaded.
  const root = document.documentElement;
  root.classList.add('native-app');

  const ICONS = {
    minimize: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10"/></svg>',
    maximize:
      '<svg class="i-max" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9"/></svg>' +
      '<svg class="i-restore" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5V0.5h7v7h-2"/><rect x="0.5" y="2.5" width="7" height="7"/></svg>',
    close: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9"/></svg>',
  };
  const LABELS = { minimize: 'Minimize', maximize: 'Maximize', close: 'Close' };

  const report = (err) => console.error('Window control failed:', err);

  /* ------------------------------------------------------------------ close ---------
     Same rule as "Home": flush autosave first, and if the project still has unsaved
     changes (and "Confirm before closing" is on) ask in the app's own dialog.
     The globals used here (state, settings, flushAutosave, showConfirmModal) belong to
     the rest of the site; every use is guarded so this file can never break closing. */
  function requestClose() {
    try { if (typeof flushAutosave === 'function') flushAutosave(); } catch (e) { /* closing matters more */ }

    const dirty = typeof state !== 'undefined' && state && state.dirty;
    const confirm = typeof settings !== 'undefined' && settings && settings.confirmClose;
    if (dirty && confirm && typeof showConfirmModal === 'function') {
      // The Settings dialog sits above the confirm dialog, so step it aside first.
      try { if (typeof closeSettings === 'function') closeSettings(); } catch (e) { /* ignore */ }
      showConfirmModal({
        title: 'Unsaved changes',
        message: 'This project has unsaved changes. Close Droidwright anyway?',
        confirmLabel: 'Close',
        danger: true,
        onConfirm: () => nb.windowClose().catch(report),
      });
      return;
    }
    nb.windowClose().catch(report);
  }

  const ACTIONS = {
    minimize: () => nb.windowMinimize().catch(report),
    maximize: () => nb.windowToggleMaximize().catch(report),
    close: requestClose,
  };

  /* --------------------------------------------------------------- build the UI ----- */
  function build() {
    // One fixed set of buttons for the whole app (instead of one per top bar), so they stay
    // reachable on the home screen, in the editor, on the first-run setup screen and over dialogs.
    const bar = document.createElement('div');
    bar.className = 'win-controls';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Window controls');
    bar.innerHTML = ['minimize', 'maximize', 'close'].map((k) =>
      `<button type="button" class="win-btn win-${k}" data-win="${k}" aria-label="${LABELS[k]}" title="${LABELS[k]}" tabindex="-1">${ICONS[k]}</button>`
    ).join('');

    // Grab strips for resizing from the top edge / top-left corner. (The left, right and bottom
    // edges are resized by Windows itself.)
    const grips = document.createElement('div');
    grips.innerHTML =
      '<div class="win-resize win-resize-top" data-edge="top"></div>' +
      '<div class="win-resize win-resize-tl" data-edge="topleft"></div>';

    document.body.append(bar, ...grips.children);

    // Don't let a click on the buttons steal keyboard focus from the canvas / inputs.
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-win]');
      if (btn) ACTIONS[btn.dataset.win]();
    });

    document.querySelectorAll('.win-resize').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        nb.windowStartResize(el.dataset.edge).catch(report);
      });
    });

    applyState(root.getAttribute('data-window') || 'normal');
    syncChromeColor();
  }

  /* ------------------------------------------------- keep icons in sync with window -- */
  function applyState(stateName) {
    root.setAttribute('data-window', stateName);
    const max = document.querySelector('.win-maximize');
    if (max) {
      const label = stateName === 'maximized' ? 'Restore' : 'Maximize';
      max.setAttribute('aria-label', label);
      max.title = label;
    }
  }
  nb.onMessage((msg) => {
    if (msg && msg.type === 'window-state') applyState(msg.state);
  });
  nb.windowState().then(applyState).catch(() => applyState('normal'));

  /* --------------------------------------------------- drag / double-click the bar ---
     The top bars are the "title bar": press and drag on any part that isn't a control.
     Dragging only starts after the mouse has moved a few pixels, so plain clicks and
     double-clicks on the bar still behave like normal page events. */
  const NO_DRAG = [
    'button', 'a', 'input', 'textarea', 'select', 'label', 'summary',
    '[role="button"]', '[role="menu"]', '[role="menuitem"]', '[role="dialog"]',
    '[contenteditable=""]', '[contenteditable="true"]',
    '.btn', '.no-drag', '.win-controls', '.win-resize',
    // dialog cards that can reach up into the top strip on short windows
    '.modal', '.settings-dialog', '.ob-card', '.keybind-capture-dialog', '.mobile-block-card',
  ].join(',');

  const DRAG_THRESHOLD = 4; // px

  function barHeight() {
    return parseFloat(getComputedStyle(root).getPropertyValue('--topbar-h')) || 56;
  }
  function inDragZone(e) {
    if (e.clientY > barHeight()) return false;
    const t = e.target;
    return !(t && t.closest && t.closest(NO_DRAG));
  }

  let press = null;
  document.addEventListener('mousedown', (e) => {
    press = (e.button === 0 && inDragZone(e)) ? { x: e.screenX, y: e.screenY } : null;
  }, true);
  document.addEventListener('mousemove', (e) => {
    if (!press) return;
    if (!(e.buttons & 1)) { press = null; return; }
    if (Math.hypot(e.screenX - press.x, e.screenY - press.y) < DRAG_THRESHOLD) return;
    press = null;
    nb.windowStartDrag().catch(report);
  }, true);
  document.addEventListener('mouseup', () => { press = null; }, true);
  window.addEventListener('blur', () => { press = null; });

  document.addEventListener('dblclick', (e) => {
    if (e.button !== 0 || !inDragZone(e)) return;
    e.preventDefault();
    ACTIONS.maximize();
  });

  /* ----------------------------------------- tell the window what colour the page is ---
     Windows paints the window's own background (visible for a split second while resizing
     or loading). Matching it to the page's colour keeps that invisible. */
  let lastColor = '';
  function cssToHex(css) {
    const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(css || '');
    return m ? '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('') : '';
  }
  function syncChromeColor() {
    if (!document.body) return;
    const hex = cssToHex(getComputedStyle(document.body).backgroundColor);
    if (!hex || hex === lastColor) return;
    lastColor = hex;
    nb.setChromeColor(hex).catch(() => { /* cosmetic only */ });
  }
  new MutationObserver(syncChromeColor).observe(root, { attributes: true, attributeFilter: ['data-theme', 'style'] });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
