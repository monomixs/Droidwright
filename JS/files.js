/* ---------------- project quick view ----------------
   One modal with two faces: a zoomable render, and the generated XML with line numbers.
   The two never coexist — switching tears the other one down — so there's only ever one
   copy of the icon on screen and the zoom state can't get out of sync with what's shown. */
const QUICKVIEW_ZOOM_MIN = 0.25;
const QUICKVIEW_ZOOM_MAX = 8;
const QUICKVIEW_ZOOM_STEP = 1.25;

function renameProject(id, nextName){
  const clean = String(nextName || '').trim();
  if (!clean) return false;
  const projects = readProjects();
  const project = projects.find(item => item.id === id);
  if (!project || project.name === clean) return false;
  project.name = clean;
  project.updatedAt = Date.now();
  writeProjects(projects);
  // Keep the open editor in step if this is the project currently loaded.
  if (state.projectId === id) state.projectName = clean;
  renderHome();
  return true;
}

function showProjectQuickView(project, showCode){
  // Always re-read: a rename or an edit may have landed since the card was built.
  const current = readProjects().find(item => item.id === project.id) || project;
  const shapes = current.shapes || [];
  const layerCount = shapes.length;

  DOM.modalTitle.textContent = showCode ? 'XML preview' : 'Icon preview';
  DOM.modalBody.className = 'modal-body project-quickview';
  DOM.modalBody.innerHTML = '';
  DOM.modalFoot.innerHTML = '';
  DOM.modalBackdrop.classList.add('show');
  DOM.modalBackdrop.classList.add('quickview-open');

  /* ---- rename row (shared by both views) ---- */
  const renameRow = document.createElement('div');
  renameRow.className = 'quickview-rename';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'modal-input quickview-name-input';
  nameInput.value = current.name || 'Untitled icon';
  nameInput.maxLength = 80;
  nameInput.spellcheck = false;
  nameInput.setAttribute('aria-label', 'Icon name');
  const saveName = document.createElement('button');
  saveName.type = 'button';
  saveName.className = 'btn small primary';
  saveName.textContent = 'Rename';
  const commitRename = () => {
    const next = nameInput.value.trim();
    if (!next){
      nameInput.value = current.name || 'Untitled icon';
      showToast('An icon needs a name');
      return;
    }
    if (renameProject(current.id, next)){
      current.name = next;
      showToast('Renamed to ' + next);
    }
  };
  saveName.addEventListener('click', commitRename);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter'){ e.preventDefault(); commitRename(); }
    if (e.key === 'Escape'){ nameInput.value = current.name || 'Untitled icon'; nameInput.blur(); }
  });
  renameRow.append(nameInput, saveName);
  DOM.modalBody.appendChild(renameRow);

  if (showCode) buildQuickViewCode(current, layerCount);
  else buildQuickViewRender(current, layerCount);

  /* ---- footer: the view toggle lives here so it reads as a mode switch ---- */
  const swap = document.createElement('button');
  swap.className = 'btn ghost';
  swap.textContent = showCode ? 'View render' : 'View code';
  swap.addEventListener('click', () => showProjectQuickView(current, !showCode));

  const open = document.createElement('button');
  open.className = 'btn primary';
  open.textContent = 'Open project';
  open.addEventListener('click', () => { closeQuickView(); openLocalProject(current.id); });

  const close = document.createElement('button');
  close.className = 'btn ghost';
  close.textContent = 'Close';
  close.addEventListener('click', closeQuickView);

  if (showCode){
    const copy = document.createElement('button');
    copy.className = 'btn ghost';
    copy.textContent = 'Copy XML';
    copy.addEventListener('click', () => copyTextToClipboard(projectXml(current)));
    DOM.modalFoot.appendChild(copy);
  }
  DOM.modalFoot.append(swap, open, close);
}
function closeQuickView(){
  resetModalWidthVariants();
  closeModal();
}

/* Zoomable render view. Zoom is applied as a CSS transform on a wrapper rather than by
   resizing the SVG, so it stays crisp at any scale and panning is a cheap translate. */
function buildQuickViewRender(project, layerCount){
  const stage = document.createElement('div');
  stage.className = 'quickview-preview';
  stage.tabIndex = 0;
  const canvas = document.createElement('div');
  canvas.className = 'quickview-canvas';
  const svg = projectPreviewSvg(project);
  canvas.appendChild(svg);
  stage.appendChild(canvas);

  const view = { zoom: 1, x: 0, y: 0 };
  const label = document.createElement('span');
  label.className = 'quickview-zoom-label';

  const apply = () => {
    // Resize the SVG itself instead of scaling a fixed-size filtered layer. Browsers can
    // rasterize a transformed SVG/filter combination, which makes vector edges look soft
    // as the quick view zooms in.
    const size = 190 * view.zoom;
    svg.style.width = size + 'px';
    svg.style.height = size + 'px';
    canvas.style.transform = `translate(${view.x}px, ${view.y}px)`;
    label.textContent = Math.round(view.zoom * 100) + '%';
    stage.classList.toggle('pannable', view.zoom > 1);
  };
  const setZoom = (next, originX, originY) => {
    const clamped = clamp(next, QUICKVIEW_ZOOM_MIN, QUICKVIEW_ZOOM_MAX);
    if (originX == null){
      view.zoom = clamped;
    } else {
      // Keep the point under the cursor fixed while the scale changes.
      const ratio = clamped / view.zoom;
      view.x = originX - (originX - view.x) * ratio;
      view.y = originY - (originY - view.y) * ratio;
      view.zoom = clamped;
    }
    if (view.zoom <= 1){ view.x = 0; view.y = 0; }
    apply();
  };

  const controls = document.createElement('div');
  controls.className = 'quickview-controls';
  const mkBtn = (label2, title, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'quickview-ctrl';
    b.innerHTML = label2;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  };
  const zoomIcon = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>${inner}</svg>`;
  controls.append(
    mkBtn(zoomIcon('<path d="M8 11h6"/>'), 'Zoom out', () => setZoom(view.zoom / QUICKVIEW_ZOOM_STEP)),
    label,
    mkBtn(zoomIcon('<path d="M11 8v6M8 11h6"/>'), 'Zoom in', () => setZoom(view.zoom * QUICKVIEW_ZOOM_STEP)),
    mkBtn('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v5h5"/></svg>', 'Reset zoom', () => { view.zoom = 1; view.x = 0; view.y = 0; apply(); })
  );

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const ox = e.clientX - rect.left - rect.width / 2;
    const oy = e.clientY - rect.top - rect.height / 2;
    setZoom(view.zoom * (e.deltaY < 0 ? QUICKVIEW_ZOOM_STEP : 1 / QUICKVIEW_ZOOM_STEP), ox, oy);
  }, { passive: false });

  // Double-click toggles between fit and a 2x look, the way image viewers behave.
  stage.addEventListener('dblclick', () => setZoom(view.zoom > 1 ? 1 : 2));

  stage.addEventListener('pointerdown', (e) => {
    if (view.zoom <= 1 || e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX - view.x, startY = e.clientY - view.y;
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('panning');
    const onMove = (ev) => { view.x = ev.clientX - startX; view.y = ev.clientY - startY; apply(); };
    const onUp = () => {
      stage.classList.remove('panning');
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerup', onUp);
      stage.removeEventListener('pointercancel', onUp);
    };
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
  });

  stage.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '='){ e.preventDefault(); setZoom(view.zoom * QUICKVIEW_ZOOM_STEP); }
    else if (e.key === '-'){ e.preventDefault(); setZoom(view.zoom / QUICKVIEW_ZOOM_STEP); }
    else if (e.key === '0'){ e.preventDefault(); view.zoom = 1; view.x = 0; view.y = 0; apply(); }
  });

  apply();
  DOM.modalBody.append(stage, controls);

  const meta = document.createElement('div');
  meta.className = 'quickview-meta';
  meta.textContent = `${layerCount} layer${layerCount === 1 ? '' : 's'} · ${fmtAttr(project.doc.viewportWidth)} × ${fmtAttr(project.doc.viewportHeight)} viewport · scroll or use + / − to zoom`;
  DOM.modalBody.appendChild(meta);
}

/* Code view with a line-number gutter. The gutter is a sibling of the code rather than
   part of it so line numbers never end up in a copied selection. */
function buildQuickViewCode(project, layerCount){
  const xml = projectXml(project);
  const lines = xml.split('\n');

  const wrap = document.createElement('div');
  wrap.className = 'quickview-code';

  const gutter = document.createElement('div');
  gutter.className = 'quickview-gutter';
  gutter.setAttribute('aria-hidden', 'true');
  gutter.textContent = lines.map((_, i) => i + 1).join('\n');

  const pre = document.createElement('pre');
  pre.innerHTML = syntaxHighlightXml(xml);

  // Keep the numbers aligned with the code when the code panel scrolls.
  pre.addEventListener('scroll', () => { gutter.scrollTop = pre.scrollTop; });

  wrap.append(gutter, pre);
  DOM.modalBody.appendChild(wrap);

  const meta = document.createElement('div');
  meta.className = 'quickview-meta';
  const bytes = new Blob([xml]).size;
  meta.textContent = `${lines.length} line${lines.length === 1 ? '' : 's'} · ${layerCount} layer${layerCount === 1 ? '' : 's'} · ${formatBytes(bytes)}`;
  DOM.modalBody.appendChild(meta);
}
function deleteProject(id){
  const project = readProjects().find(item => item.id === id);
  if (!project) return;
  const commitDelete = () => {
    const remaining = readProjects().filter(item => item.id !== id);
    writeProjects(remaining);
    persistNormalizedHomeGroups(readHomeGroups(), remaining);
    homeState.selectedIds = homeState.selectedIds.filter(selectedId => selectedId !== id);
    if (state.projectId === id) state.projectId = null;
    renderHome();
  };
  if (settings.confirmDelete){
    showConfirmModal({
      title: 'Delete icon?',
      message: `Delete "${project.name || 'Untitled icon'}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: commitDelete,
    });
  } else {
    commitDelete();
  }
}

/* ---- home screen: search / sort / live stats ---- */
const homeState = { query:'', sort:'recent', selectedIds:[] };
// Tracks which group's popup is currently open (and its live intro/grid elements) so
// actions taken from inside it — like removing a member — can patch that same DOM in
// place instead of relying on the next full renderHome(), which never touches the
// modal since it only rebuilds #project-grid.
let homeGroupModalState = null;
function homeGroupId(){
  let id = uid('homegroup');
  const groups = readHomeGroups();
  while (groups[id]) id = uid('homegroup');
  return id;
}
function validHomeSelection(projects){
  const validIds = new Set(projects.map(project => project.id));
  homeState.selectedIds = homeState.selectedIds.filter((id, index, list) => validIds.has(id) && list.indexOf(id) === index);
  return homeState.selectedIds;
}
function toggleHomeProjectSelection(id){
  const selected = homeState.selectedIds;
  if (selected.includes(id)) homeState.selectedIds = selected.filter(selectedId => selectedId !== id);
  else selected.push(id);
  // A full renderHome() would tear down and re-append every card, replaying each
  // one's entry animation just for a checkbox toggle. Patch the existing DOM instead
  // so only the selection state changes.
  refreshHomeSelectionUI();
}
function refreshHomeSelectionUI(){
  const projects = readProjects();
  const selected = validHomeSelection(projects);
  DOM.homeSelectionCount.hidden = selected.length === 0;
  DOM.homeSelectionCount.textContent = `${selected.length} selected`;
  DOM.homeGroupSelected.disabled = selected.length < 2;
  DOM.homeGroupSelected.hidden = selected.length < 2;
  DOM.projectGrid.querySelectorAll('.project-card[data-project-id]').forEach((card) => {
    const isSelected = selected.includes(card.dataset.projectId);
    card.classList.toggle('selected', isSelected);
    const btn = card.querySelector('.project-select');
    if (btn){
      const nameEl = card.querySelector('.project-name');
      const name = nameEl ? nameEl.textContent : 'icon';
      btn.setAttribute('aria-label', (isSelected ? 'Deselect ' : 'Select ') + name);
      btn.setAttribute('aria-pressed', String(isSelected));
    }
  });
  DOM.projectGrid.querySelectorAll('.home-group-add-selected').forEach((btn) => {
    btn.disabled = selected.length === 0;
  });
}
function createHomeGroupFromSelection(){
  const projects = readProjects();
  const selected = validHomeSelection(projects);
  if (selected.length < 2){ showToast('Select at least 2 icons to create a group'); return; }
  const groups = homeGroupsForProjects(projects);
  const groupId = homeGroupId();
  for (const group of Object.values(groups)) group.projectIds = group.projectIds.filter(id => !selected.includes(id));
  groups[groupId] = { id:groupId, name:'New group', projectIds:selected.slice(), expanded:true, updatedAt:Date.now() };
  persistNormalizedHomeGroups(groups, projects);
  renderHome();
  showToast('Created group with ' + selected.length + ' icons');
}
function addSelectedProjectsToHomeGroup(groupId){
  const projects = readProjects();
  const selected = validHomeSelection(projects).filter(id => id !== undefined);
  if (!selected.length){ showToast('Select one or more icons to add to this group'); return; }
  const groups = homeGroupsForProjects(projects);
  const target = groups[groupId];
  if (!target) return;
  const idsToAdd = selected.filter(id => !target.projectIds.includes(id));
  if (!idsToAdd.length){ showToast('Those icons are already in this group'); return; }
  for (const group of Object.values(groups)) group.projectIds = group.projectIds.filter(id => !idsToAdd.includes(id));
  target.projectIds.push(...idsToAdd);
  target.updatedAt = Date.now();
  persistNormalizedHomeGroups(groups, projects);
  renderHome();
  showToast('Added ' + idsToAdd.length + ' icon' + (idsToAdd.length === 1 ? '' : 's') + ' to group');
}
function removeProjectFromHomeGroup(projectId, groupId){
  const projects = readProjects();
  const groups = homeGroupsForProjects(projects);
  const group = groups[groupId];
  if (!group) return;
  group.projectIds = group.projectIds.filter(id => id !== projectId);
  group.updatedAt = Date.now();
  persistNormalizedHomeGroups(groups, projects);
  renderHome();
  // renderHome() only rebuilds the home grid behind the popup — if this group's popup
  // is the one open, patch its DOM directly so the card disappears immediately instead
  // of waiting for the popup to be closed and reopened.
  if (homeGroupModalState && homeGroupModalState.groupId === groupId){
    const remaining = group.projectIds.length;
    if (!remaining){
      closeModal();
    } else {
      const card = Array.from(homeGroupModalState.gridEl.children)
        .find((el) => el.dataset && el.dataset.projectId === projectId);
      if (card) card.remove();
      homeGroupModalState.introEl.textContent = `${remaining} icon${remaining === 1 ? '' : 's'} in this group`;
    }
  }
  showToast('Removed icon from group');
}
function renameHomeGroup(groupId, name){
  const projects = readProjects();
  const groups = homeGroupsForProjects(projects);
  const group = groups[groupId];
  if (!group) return;
  const nextName = String(name || '').trim().slice(0, 80) || 'Untitled group';
  if (group.name === nextName) return;
  group.name = nextName;
  group.updatedAt = Date.now();
  persistNormalizedHomeGroups(groups, projects);
  renderHome();
}
function setHomeGroupExpanded(groupId, expanded){
  const projects = readProjects();
  const groups = homeGroupsForProjects(projects);
  const group = groups[groupId];
  if (!group) return;
  group.expanded = expanded;
  group.updatedAt = Date.now();
  persistNormalizedHomeGroups(groups, projects);
  renderHome();
}
function formatRelativeTime(ts){
  if (!ts) return null;
  const diff = Date.now() - ts;
  if (diff < 45000) return 'just now';
  const m = Math.floor(diff / 60000);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 7) return d + 'd ago';
  return new Date(ts).toLocaleDateString(undefined, { month:'short', day:'numeric' });
}
function formatBytes(bytes){
  if (!bytes) return '0 KB';
  if (bytes < 1024) return bytes + ' B';
  return (bytes / 1024).toFixed(1) + ' KB';
}
function getFilteredSortedProjects(all){
  const q = homeState.query.trim().toLowerCase();
  const list = q ? all.filter(p => (p.name || 'Untitled icon').toLowerCase().includes(q)) : all.slice();
  if (homeState.sort === 'name'){
    list.sort((a, b) => (a.name || 'Untitled icon').localeCompare(b.name || 'Untitled icon', undefined, { sensitivity:'base' }));
  } else {
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return list;
}
function renderHomeStats(projects){
  let layers = 0, lastSaved = 0;
  for (const project of projects){
    layers += (project.shapes || []).length;
    if (project.updatedAt && project.updatedAt > lastSaved) lastSaved = project.updatedAt;
  }
  let bytes = 0;
  try { bytes = new Blob([localStorage.getItem(PROJECTS_KEY) || '']).size; }
  catch (err) { bytes = (localStorage.getItem(PROJECTS_KEY) || '').length; }
  DOM.statIcons.textContent = String(projects.length);
  DOM.statLayers.textContent = String(layers);
  DOM.statStorage.textContent = formatBytes(bytes);
  DOM.statSaved.textContent = formatRelativeTime(lastSaved) || '—';
}
function buildProjectCard(project, staggerIndex, groupId, selectable){
  if (selectable === undefined) selectable = true;
  const card = document.createElement('article');
  const selected = selectable && homeState.selectedIds.includes(project.id);
  card.className = 'project-card' + (selected ? ' selected' : '');
  card.style.setProperty('--stagger', String(Math.min(staggerIndex, 12)));
  card.tabIndex = 0;
  card.dataset.projectId = project.id;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', 'Open ' + (project.name || 'Untitled icon'));
  // Inside an open group, cards are just for browsing/opening — selection is a
  // home-grid-only concept, so no checkbox and no persistent "selected" outline;
  // these fall back to the normal card look with only the ordinary hover state.
  let select = null;
  if (selectable){
    select = document.createElement('button');
    select.type = 'button';
    select.className = 'project-select';
    select.setAttribute('aria-label', (selected ? 'Deselect ' : 'Select ') + (project.name || 'Untitled icon'));
    select.setAttribute('aria-pressed', String(selected));
    select.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4.2 4.2L19 6.8"/></svg>';
    select.addEventListener('click', (event) => { event.stopPropagation(); toggleHomeProjectSelection(project.id); });
  }
  const preview = document.createElement('div');
  preview.className = 'project-preview';
  preview.appendChild(projectPreviewSvg(project));
  const info = document.createElement('div');
  info.className = 'project-info';
  const layerCount = (project.shapes || []).length;
  const metaBits = [];
  const rel = formatRelativeTime(project.updatedAt);
  if (rel) metaBits.push(rel);
  metaBits.push(layerCount + ' layer' + (layerCount === 1 ? '' : 's'));
  metaBits.push(fmtAttr(project.doc.viewportWidth) + '×' + fmtAttr(project.doc.viewportHeight));
  info.innerHTML = `<div class="project-info-head"><div class="project-name">${escapeHtml(project.name || 'Untitled icon')}</div></div><div class="project-meta">${escapeHtml(metaBits.join(' · '))}</div>`;
  const actions = document.createElement('div');
  actions.className = 'project-actions';
  const actionTypes = [['open','Open'],['view','Quick view'],['code','Code quick view']];
  if (groupId) actionTypes.push(['removeGroup','Remove from group']);
  actionTypes.push(['delete','Delete']);
  actionTypes.forEach(([type,label]) => {
    const button = document.createElement('button');
    button.className = 'project-action' + (type === 'delete' ? ' danger' : '');
    button.type = 'button';
    button.dataset.tooltip = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = projectActionIcon(type);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (type === 'open'){ closeModal(); openLocalProject(project.id); }
      else if (type === 'view') showProjectQuickView(project, false);
      else if (type === 'code') showProjectQuickView(project, true);
      else if (type === 'removeGroup') removeProjectFromHomeGroup(project.id, groupId);
      else deleteProject(project.id);
    });
    actions.appendChild(button);
  });
  info.appendChild(actions);
  if (select) card.append(select, preview, info);
  else card.append(preview, info);
  // Opening a card (from the home grid or from inside a group's popup) should always
  // take the user straight into the editor — close whatever popup is open first so it
  // doesn't linger behind the editor.
  card.addEventListener('click', () => { closeModal(); openLocalProject(project.id); });
  card.addEventListener('keydown', (e) => {
    if (e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); closeModal(); openLocalProject(project.id); }
  });
  return card;
}
function showHomeGroupModal(group, members){
  resetModalWidthVariants();
  DOM.modalBackdrop.classList.add('home-group-open');
  DOM.modalTitle.textContent = group.name;
  DOM.modalBody.className = 'modal-body home-group-modal-body';
  DOM.modalBody.innerHTML = '';

  const intro = document.createElement('div');
  intro.className = 'home-group-modal-intro';
  intro.textContent = `${members.length} icon${members.length === 1 ? '' : 's'} in this group`;
  DOM.modalBody.appendChild(intro);

  const grid = document.createElement('div');
  grid.className = 'project-grid home-group-modal-grid';
  members.forEach((project, index) => grid.appendChild(buildProjectCard(project, index, group.id, false)));
  DOM.modalBody.appendChild(grid);
  homeGroupModalState = { groupId: group.id, gridEl: grid, introEl: intro };

  DOM.modalFoot.innerHTML = '';
  const close = document.createElement('button');
  close.className = 'btn primary';
  close.textContent = 'Close';
  close.addEventListener('click', closeModal);
  DOM.modalFoot.appendChild(close);
  DOM.modalBackdrop.classList.add('show');
}
function buildHomeGroupCard(group, members, staggerIndex, selectedCount){
  const card = document.createElement('article');
  card.className = 'project-card home-group-card';
  card.style.setProperty('--stagger', String(Math.min(staggerIndex, 12)));
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Open group ${group.name}`);

  const preview = document.createElement('div');
  preview.className = 'project-preview home-group-preview';
  const previewMembers = members.slice(0, 4);
  previewMembers.forEach((project) => {
    const icon = projectPreviewSvg(project);
    icon.classList.add('home-group-preview-icon');
    preview.appendChild(icon);
  });
  if (members.length > previewMembers.length){
    const more = document.createElement('span');
    more.className = 'home-group-more';
    more.textContent = `+${members.length - previewMembers.length}`;
    preview.appendChild(more);
  }

  const info = document.createElement('div');
  info.className = 'project-info';
  const name = document.createElement('input');
  name.type = 'text'; name.className = 'home-group-name'; name.value = group.name; name.maxLength = 80; name.spellcheck = false;
  name.setAttribute('aria-label', 'Group name');
  name.addEventListener('click', (event) => event.stopPropagation());
  name.addEventListener('keydown', (event) => { if (event.key === 'Enter') event.currentTarget.blur(); });
  name.addEventListener('change', () => renameHomeGroup(group.id, name.value));
  const meta = document.createElement('div');
  meta.className = 'project-meta';
  meta.textContent = `${members.length} icon${members.length === 1 ? '' : 's'} · Click to view`;
  const actions = document.createElement('div');
  actions.className = 'project-actions home-group-card-actions';
  const addSelected = document.createElement('button');
  addSelected.type = 'button'; addSelected.className = 'btn small home-group-add-selected'; addSelected.textContent = 'Add selected';
  addSelected.disabled = selectedCount === 0;
  addSelected.addEventListener('click', (event) => { event.stopPropagation(); addSelectedProjectsToHomeGroup(group.id); });
  actions.appendChild(addSelected);
  info.append(name, meta, actions);
  card.append(preview, info);
  const open = () => showHomeGroupModal(group, members);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (event) => {
    if (event.target !== card) return;
    if (event.key === 'Enter' || event.key === ' '){ event.preventDefault(); open(); }
  });
  return card;
}
function renderHome(){
  const all = readProjects();
  const list = getFilteredSortedProjects(all);
  const selected = validHomeSelection(all);
  const groups = homeGroupsForProjects(all);
  renderHomeStats(all);
  DOM.homeProjectCount.textContent = `${all.length} icon${all.length === 1 ? '' : 's'}`;
  DOM.homeSelectionCount.hidden = selected.length === 0;
  DOM.homeSelectionCount.textContent = `${selected.length} selected`;
  DOM.homeGroupSelected.disabled = selected.length < 2;
  DOM.homeGroupSelected.hidden = selected.length < 2;

  const isEmpty = all.length === 0;
  const isNoResults = !isEmpty && list.length === 0;

  DOM.homeEmpty.hidden = !isEmpty;
  DOM.homeToolbar.hidden = isEmpty;
  DOM.homeNoResults.hidden = !isNoResults;
  DOM.projectGrid.hidden = isEmpty || isNoResults;

  if (isNoResults) DOM.homeNoResultsQuery.textContent = homeState.query.trim();

  DOM.projectGrid.innerHTML = '';
  if (isEmpty || isNoResults) return;

  // No in-grid "+ New project" tile once there's at least one icon or group — the
  // compact button in the top-right header is already enough, and dropping the tile
  // keeps the grid entirely about existing icons (and saves a row of space).
  const visibleById = new Map(list.map((project) => [project.id, project]));
  const groupedIds = new Set();
  const orderedGroups = Object.values(groups).sort((a, b) => homeState.sort === 'name'
    ? a.name.localeCompare(b.name, undefined, { sensitivity:'base' })
    : b.updatedAt - a.updatedAt);
  let staggerIndex = 0;
  for (const group of orderedGroups){
    const members = group.projectIds.map((id) => visibleById.get(id)).filter(Boolean);
    if (!members.length) continue;
    members.forEach((project) => groupedIds.add(project.id));
    DOM.projectGrid.appendChild(buildHomeGroupCard(group, members, staggerIndex++, selected.length));
  }
  list.filter((project) => !groupedIds.has(project.id)).forEach((project) => {
    DOM.projectGrid.appendChild(buildProjectCard(project, staggerIndex++));
  });
}
