/* =====================================================================================
   Right-click behaviour

   The app never shows the browser's own right-click menu (Back / Reload / Inspect...). Instead:

     1. Where the app has its OWN menu (the canvas menu in the editor), that menu is shown.
     2. Where text can be edited, or text is selected, THIS file shows a small text menu:
            Undo  Redo  |  Cut  Copy  Paste  Delete  |  Select all
        (just Copy / Select all when the text can't be edited)
     3. Everywhere else the right-click does nothing.

   The home screen blocks right-click completely (see wireHome in ui.js), so none of this runs there.

   Order matters: this listens in the normal (bubbling) phase, AFTER the canvas menu has had its
   chance. If something already called preventDefault(), the app handled the click, so we step aside.
   Loaded last (after ui.js) because it positions its menu with positionFloatingPanel().
   ===================================================================================== */
(function () {
  'use strict';

  const nb = window.NativeBridge;
  const native = !!(nb && nb.isNative);

  const ICON = {
    undo:   '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/>',
    redo:   '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13"/>',
    cut:    '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
    copy:   '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    paste:  '<path d="M15 2H9a1 1 0 0 0-1 1v2c0 .6.4 1 1 1h6c.6 0 1-.4 1-1V3c0-.6-.4-1-1-1Z"/><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><path d="M16 4h2a2 2 0 0 1 2 2v4"/><path d="M21 14H11"/><path d="m15 10-4 4 4 4"/>',
    del:    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
    all:    '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8h8M7 12h10M7 16h6"/>',
  };
  const svg = (name) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

  /* ----------------------------------------------------------- what was clicked ---- */
  // Inputs that hold normal text (colour pickers, sliders, checkboxes... don't).
  const TEXT_INPUT_TYPES = /^(|text|search|url|tel|email|password|number)$/i;

  function editableFrom(target) {
    const el = target && target.closest ? target.closest('input, textarea, [contenteditable]') : null;
    if (!el) return null;
    if (el.matches('textarea')) return el.disabled ? null : el;
    if (el.matches('input')) return !el.disabled && TEXT_INPUT_TYPES.test(el.getAttribute('type') || '') ? el : null;
    return el.isContentEditable ? el : null;
  }

  function selectedTextIn(el) {
    if (el.matches('input, textarea')) {
      try {
        if (el.selectionStart != null) return el.value.slice(el.selectionStart, el.selectionEnd);
      } catch (e) { /* e.g. number inputs have no selection API */ }
    }
    const sel = window.getSelection();
    return sel ? sel.toString() : '';
  }

  /** Is the point (x, y) over the currently selected page text? */
  function pointInSelection(sel, x, y) {
    try {
      const range = sel.getRangeAt(0);
      if (typeof range.getClientRects !== 'function') return true;
      for (const r of range.getClientRects()) {
        if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return true;
      }
      return false;
    } catch (e) { return true; }
  }

  function describe(e) {
    const el = editableFrom(e.target);
    if (el) {
      const value = el.matches('input, textarea') ? el.value : el.textContent;
      return { kind: 'edit', el, text: selectedTextIn(el), readOnly: !!el.readOnly, empty: !value };
    }
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString() : '';
    if (!text.trim() || !pointInSelection(sel, e.clientX, e.clientY)) return null;
    const node = sel.anchorNode;
    return { kind: 'selection', text, anchor: node && (node.nodeType === 1 ? node : node.parentElement) };
  }

  /* --------------------------------------------------------------- clipboard ------ */
  // In the Windows app the real clipboard is used (no browser permission prompts).
  async function writeClipboard(text) {
    if (native) { try { await nb.setClipboardText(text); return true; } catch (e) { /* fall through */ } }
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    try { return document.execCommand('copy'); } catch (e) { return false; }
  }
  async function readClipboard() {
    if (native) { try { return await nb.getClipboardText(); } catch (e) { /* fall through */ } }
    try { return await navigator.clipboard.readText(); } catch (e) { return ''; }
  }

  function insertText(el, text) {
    el.focus();
    let done = false;
    try { done = document.execCommand('insertText', false, text); } catch (e) { /* fall back below */ }
    if (!done && el.setRangeText) {
      const start = el.selectionStart != null ? el.selectionStart : el.value.length;
      const end = el.selectionEnd != null ? el.selectionEnd : start;
      el.setRangeText(text, start, end, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function selectAll(ctx) {
    if (ctx.kind === 'edit') {
      ctx.el.focus();
      if (typeof ctx.el.select === 'function') ctx.el.select();
      else document.execCommand('selectAll');
      return;
    }
    // Plain page text: select the whole block that was clicked in, not the entire window.
    const root = (ctx.anchor && ctx.anchor.closest && ctx.anchor.closest('pre, code, .modal-body, .setting-row, .panel')) || ctx.anchor;
    const sel = window.getSelection();
    if (root && sel) sel.selectAllChildren(root);
  }

  /* ------------------------------------------------------------------- the menu --- */
  let menu = null;
  let open = false;

  function ensureMenu() {
    if (menu) return menu;
    menu = document.createElement('div');
    menu.className = 'ov-menu tx-menu';          // same look as the Tools menu
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    document.body.appendChild(menu);
    return menu;
  }

  function rowsFor(ctx) {
    const has = ctx.text.length > 0;
    const copy = { label: 'Copy', shortcut: 'Ctrl+C', icon: 'copy', disabled: !has, run: () => writeClipboard(ctx.text) };
    const all = { label: 'Select all', shortcut: 'Ctrl+A', icon: 'all', disabled: ctx.kind === 'edit' && ctx.empty, run: () => selectAll(ctx) };
    if (ctx.kind === 'selection') return [copy, '-', all];
    if (ctx.readOnly) return [copy, '-', all];

    const el = ctx.el;
    return [
      { label: 'Undo', shortcut: 'Ctrl+Z', icon: 'undo', run: () => { el.focus(); document.execCommand('undo'); } },
      { label: 'Redo', shortcut: 'Ctrl+Y', icon: 'redo', run: () => { el.focus(); document.execCommand('redo'); } },
      '-',
      { label: 'Cut', shortcut: 'Ctrl+X', icon: 'cut', disabled: !has, run: async () => { await writeClipboard(ctx.text); el.focus(); document.execCommand('delete'); } },
      copy,
      { label: 'Paste', shortcut: 'Ctrl+V', icon: 'paste', run: async () => { const t = await readClipboard(); if (t) insertText(el, t); } },
      { label: 'Delete', shortcut: 'Del', icon: 'del', disabled: !has, run: () => { el.focus(); document.execCommand('delete'); } },
      '-',
      all,
    ];
  }

  function show(x, y, ctx) {
    const m = ensureMenu();
    m.textContent = '';
    for (const row of rowsFor(ctx)) {
      if (row === '-') {
        const d = document.createElement('div');
        d.className = 'ov-divider';
        d.setAttribute('role', 'separator');
        m.appendChild(d);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ov-item';
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      b.disabled = !!row.disabled;
      b.innerHTML = svg(row.icon) + '<span class="ov-label"></span><span class="ov-shortcut"></span>';
      b.querySelector('.ov-label').textContent = row.label;
      b.querySelector('.ov-shortcut').textContent = row.shortcut;
      // Pressing a row must not move focus out of the text box - the action needs its selection.
      b.addEventListener('mousedown', (ev) => ev.preventDefault());
      b.addEventListener('click', () => { hide(); Promise.resolve(row.run()).catch(() => {}); });
      m.appendChild(b);
    }

    m.style.visibility = 'hidden';
    m.hidden = false;
    // Same placement rule as every other popup: stays on screen and below the title bar.
    if (typeof positionFloatingPanel === 'function') {
      positionFloatingPanel(m, { left: x, right: x, top: y, bottom: y }, { margin: 8, gap: 0 });
    } else {
      m.style.left = x + 'px';
      m.style.top = y + 'px';
    }
    m.style.visibility = '';
    open = true;
  }

  function hide() {
    if (!open) return;
    open = false;
    if (menu) menu.hidden = true;
  }

  /* ------------------------------------------------------------------ wiring ------ */
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;              // the app already showed its own menu (or blocked it) - leave it be
    e.preventDefault();                          // ...otherwise: never the browser's menu

    if (menu && menu.contains(e.target)) return; // right-clicking our own menu does nothing
    const ctx = describe(e);
    if (!ctx) { hide(); return; }

    let x = e.clientX, y = e.clientY;
    if (!x && !y) {                              // opened from the keyboard (menu key / Shift+F10): no mouse position
      const r = (ctx.el || ctx.anchor || document.body).getBoundingClientRect();
      x = r.left + 8; y = r.bottom;
    }
    show(x, y, ctx);
  });

  // Close on anything that means "I'm done with this menu".
  document.addEventListener('pointerdown', (e) => { if (open && !(menu && menu.contains(e.target))) hide(); }, true);
  document.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); }
  }, true);
  document.addEventListener('wheel', hide, { capture: true, passive: true });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
})();
