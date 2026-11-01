/* =====================================================================================
   Toolbar overflow  ->  one "Tools" button with a custom menu

   When a top bar gets too narrow, its buttons are collapsed ONE AT A TIME, in a fixed
   priority order, and only as many as it takes to stop overflowing. The collapsed
   buttons move into a "Tools" menu that opens under the Tools button. Widen the window
   again and they come back, in reverse order.

   The original buttons are never moved or rebuilt - they are only hidden - and the menu
   rows simply click them. So every existing handler, disabled state and shortcut keeps
   working exactly as before.

   Used for two bars:   the editor bar (#topbar)    and    the home header (.home-header).
   Loaded after bootstrap.js, so all the buttons already exist and are wired.
   ===================================================================================== */
(function () {
  'use strict';

  /* Icons for buttons that have no <svg> of their own (24x24, drawn with currentColor). */
  const ICONS = {
    tools:  '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    caret:  '<path d="m6 9 6 6 6-6"/>',
    home:   '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/>',
    file:   '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 12v6M9 15h6"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    save:   '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    saved:  '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  };
  const svg = (inner, cls) =>
    `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

  const NARROW_PHONE_LAYOUT = '(max-width:680px)'; // the home header wraps on its own below this width

  /* ---------------------------------------------------------------- helpers ---- */
  const $ = (id) => document.getElementById(id);
  const isHidden = (el) => el.classList.contains('ov-hidden');
  const px = (v) => parseFloat(v) || 0;

  /** Button -> menu text. "Undo (Ctrl+Z)" in a tooltip gives label "Undo" + shortcut "Ctrl+Z". */
  function describe(el) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const hint = el.getAttribute('title') || el.getAttribute('data-tip') || '';
    const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(hint);
    return {
      label: text || el.getAttribute('aria-label') || (m ? m[1] : hint),
      shortcut: m ? m[2] : '',
    };
  }

  /* ---------------------------------------------------------------- the engine -- */
  /**
   * cfg.container  flex bar whose right edge is the limit
   * cfg.before     element the Tools button is inserted in front of
   * cfg.items      [{ el, group, icon?, info?, text? }] in COLLAPSE order (first collapses first)
   *                info:true = a status note (shown as plain text in the menu, never needs the button)
   */
  function createOverflow(cfg) {
    const { container, before } = cfg;
    const items = cfg.items.filter((it) => it.el);
    if (!container || !before || !items.length) return;

    // --- the Tools button -------------------------------------------------------------
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ov-tools ov-hidden';
    btn.title = 'More tools';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = svg(ICONS.tools) + 'Tools' + svg(ICONS.caret, 'ov-caret');
    before.parentNode.insertBefore(btn, before);

    // --- the menu -----------------------------------------------------------------------
    const menu = document.createElement('div');
    menu.className = 'ov-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    document.body.appendChild(menu);

    let collapsed = [];
    let open = false;

    /* ---- measuring ---- */
    function limitRight() {
      const r = container.getBoundingClientRect();
      const cs = getComputedStyle(container);
      return r.right - px(cs.paddingRight) - px(cs.borderRightWidth);
    }
    function contentRight() {
      let max = -Infinity;
      for (const c of container.children) {
        if (isHidden(c)) continue;
        const r = c.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > max) max = r.right;
      }
      return max;
    }
    const overflows = () => contentRight() > limitRight() + 1;

    /* Empty button groups and the thin separators between them disappear with their buttons. */
    function syncStructure() {
      const kids = [...container.children];
      const isGroup = (k) => k && k.classList.contains('topbar-group');
      for (const k of kids) {
        if (isGroup(k)) k.classList.toggle('ov-hidden', ![...k.querySelectorAll('.btn')].some((b) => !isHidden(b)));
      }
      for (const k of kids) {
        if (!k.classList.contains('vsep')) continue;
        const visible = (dir) => { let n = k[dir]; while (n && isHidden(n)) n = n[dir]; return n; };
        k.classList.toggle('ov-hidden', !(isGroup(visible('previousElementSibling')) && isGroup(visible('nextElementSibling'))));
      }
    }

    /* ---- the progressive collapse ---- */
    function update() {
      closeMenu();

      // start from "everything visible", then take buttons away only while the bar overflows
      items.forEach((it) => it.el.classList.remove('ov-hidden'));
      container.querySelectorAll(':scope > .topbar-group, :scope > .vsep').forEach((k) => k.classList.remove('ov-hidden'));
      btn.classList.add('ov-hidden');
      collapsed = [];

      const hiddenBar = container.getClientRects().length === 0;       // e.g. editor bar while on the home screen
      // On the website, phones get their own wrapped layout. The Windows app always collapses instead.
      const phoneLayout = !document.documentElement.classList.contains('native-app') &&
                          window.matchMedia(NARROW_PHONE_LAYOUT).matches;
      if (hiddenBar || phoneLayout) return;

      for (const it of items) {
        if (!overflows()) break;
        if (!it.info) btn.classList.remove('ov-hidden');                // the button needs room too
        it.el.classList.add('ov-hidden');
        collapsed.push(it);
        syncStructure();
      }
      if (!collapsed.some((it) => !it.info)) btn.classList.add('ov-hidden'); // only a status note went: no menu needed
      syncStructure();
    }

    let queued = false;
    function schedule() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; update(); });
    }

    /* ---- the menu ---- */
    const byPageOrder = (a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

    function buildMenu() {
      menu.textContent = '';
      let lastGroup = null;
      for (const it of collapsed.slice().sort(byPageOrder)) {
        if (lastGroup !== null && it.group !== lastGroup) {
          const d = document.createElement('div');
          d.className = 'ov-divider';
          d.setAttribute('role', 'separator');
          menu.appendChild(d);
        }
        lastGroup = it.group;

        if (it.info) {
          const note = document.createElement('div');
          note.className = 'ov-note';
          note.innerHTML = svg(ICONS.saved) + '<span></span>';
          note.lastChild.textContent = it.text || describe(it.el).label;
          menu.appendChild(note);
          continue;
        }

        const { label, shortcut } = describe(it.el);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'ov-item';
        row.setAttribute('role', 'menuitem');
        row.tabIndex = -1;
        row.disabled = !!it.el.disabled;

        const own = it.el.querySelector('svg');
        row.innerHTML = (it.icon ? svg(ICONS[it.icon]) : own ? own.outerHTML : svg('')) + '<span class="ov-label"></span>';
        row.querySelector('.ov-label').textContent = label;
        if (shortcut) {
          const k = document.createElement('span');
          k.className = 'ov-shortcut';
          k.textContent = shortcut;
          row.appendChild(k);
        }
        row.addEventListener('click', () => {
          closeMenu();
          it.el.click();                                              // the real button does the real work
        });
        menu.appendChild(row);
      }
    }

    function position() {
      const r = btn.getBoundingClientRect();
      const w = menu.offsetWidth, h = menu.offsetHeight;
      const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
      const minTop = typeof popupTop === 'function' ? popupTop(8) : 8;   // stay below the title bar
      const top = Math.max(minTop, Math.min(r.bottom + 6, window.innerHeight - h - 8));
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
    }

    const rows = () => [...menu.querySelectorAll('.ov-item:not(:disabled)')];

    function openMenu() {
      if (open || !collapsed.length) return;
      buildMenu();
      menu.style.visibility = 'hidden';
      menu.hidden = false;
      position();
      menu.style.visibility = '';
      open = true;
      btn.setAttribute('aria-expanded', 'true');
      const first = rows()[0];
      if (first) first.focus({ preventScroll: true });
    }
    function closeMenu(restoreFocus) {
      if (!open) return;
      open = false;
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      if (restoreFocus) btn.focus({ preventScroll: true });
    }

    btn.addEventListener('click', () => (open ? closeMenu() : openMenu()));

    // Keyboard: arrows / Home / End move, Esc closes, Tab leaves. Handled in the capture phase so
    // the editor's own shortcuts (Esc to deselect, arrows to nudge...) never see these keys.
    document.addEventListener('keydown', (e) => {
      if (!open) return;
      const list = rows();
      const i = list.indexOf(document.activeElement);
      let handled = true;
      switch (e.key) {
        case 'ArrowDown': list[(i + 1) % list.length].focus(); break;
        case 'ArrowUp':   list[(i - 1 + list.length) % list.length].focus(); break;
        case 'Home':      list[0].focus(); break;
        case 'End':       list[list.length - 1].focus(); break;
        case 'Escape':    closeMenu(true); break;
        case 'Tab':       closeMenu(false); handled = false; break;
        default:          handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    // Click anywhere else (or leave the window) -> close.
    document.addEventListener('pointerdown', (e) => {
      if (open && !menu.contains(e.target) && !btn.contains(e.target)) closeMenu();
    }, true);
    window.addEventListener('blur', () => closeMenu());

    // --- re-fit whenever the bar's width changes -----------------------------------------
    // The observer runs just before the browser paints, so re-fitting right here means a half-collapsed
    // bar is never visible, even while dragging the window edge.
    if (window.ResizeObserver) new ResizeObserver(() => update()).observe(container);
    window.addEventListener('resize', schedule);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
    schedule();
  }

  /* --------------------------------------------------------------- the two bars -- */
  function init() {
    /* EDITOR BAR.  Collapse order: the file buttons first, then Copy XML, Settings, Redo, Undo, Home.
       Export is the main action, so it never collapses. */
    createOverflow({
      container: $('topbar'),
      before: $('btnExportMenu'),
      items: [
        { el: $('btnLoadProject'), group: 'file',    icon: 'folder' },   // Open
        { el: $('btnSaveProject'), group: 'file',    icon: 'save' },     // Save
        { el: $('btnImportSvg'),   group: 'file',    icon: 'upload' },   // Import SVG
        { el: $('btnNew'),         group: 'file',    icon: 'file' },     // New
        { el: $('btnCopyXml'),     group: 'actions' },                   // Copy XML
        { el: $('btnSettings'),    group: 'actions' },                   // Settings
        { el: $('btnRedo'),        group: 'history' },
        { el: $('btnUndo'),        group: 'history' },
        { el: $('btnHome'),        group: 'nav',     icon: 'home' },
      ],
    });

    /* HOME HEADER.  The "Saved on this device" note goes first (it only needs a line in the
       menu), then Import SVG, Changelog, About, Settings. "New project" never collapses. */
    const badge = document.querySelector('.home-header .local-badge');
    createOverflow({
      container: document.querySelector('.home-header'),
      before: $('homeNewProject'),
      items: [
        { el: badge,                 group: 'status', info: true, text: 'Saved on this device' },
        { el: $('homeImportProject'),group: 'file',   icon: 'upload' },
        { el: $('homeChangelogBtn'), group: 'about' },
        { el: $('homeInfoBtn'),      group: 'about' },
        { el: $('homeSettingsBtn'),  group: 'app' },
      ],
    });
  }

  /* "512 x 512 viewport · 512 x 512 dp" in the canvas bar: shown while it fits, hidden (not squeezed or
     wrapped) as soon as the window / panels leave it too little room. */
  function initViewportReadout() {
    const bar = $('canvas-topbar');
    const readout = $('viewportReadout');
    if (!bar || !readout) return;

    function fit() {
      readout.classList.remove('ov-hidden');
      if (bar.getClientRects().length === 0) return;                  // the editor isn't on screen
      const cs = getComputedStyle(bar);
      const limit = bar.getBoundingClientRect().right - px(cs.paddingRight);
      if (readout.getBoundingClientRect().right > limit + 1) readout.classList.add('ov-hidden');
    }
    if (window.ResizeObserver) new ResizeObserver(fit).observe(bar);
    window.addEventListener('resize', fit);
    // the text changes with the document size ("24 x 24" is shorter than "1024 x 1024")
    new MutationObserver(fit).observe(readout, { childList: true, characterData: true, subtree: true });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
    fit();
  }

  function initAll() {
    init();
    initViewportReadout();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
})();
