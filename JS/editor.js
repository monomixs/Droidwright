/* =====================================================================================
   Part 4: history, selection, z-order, duplicate/delete, align
   ===================================================================================== */
let __historySnapshotBeforeEdit = null;
function snapshotState(){ return { doc: deepClone(state.doc), shapes: deepClone(state.shapes), groups: deepClone(state.groups||{}) }; }
function restoreSnapshot(snap){
  state.doc = deepClone(snap.doc);
  state.shapes = deepClone(snap.shapes);
  state.groups = deepClone(snap.groups||{});
  state.selectedIds = state.selectedIds.filter(id => state.shapes.some(s => s.id === id));
}
function beginEdit(){ if (!__historySnapshotBeforeEdit) __historySnapshotBeforeEdit = snapshotState(); }
function commitEdit(){
  if (!__historySnapshotBeforeEdit) return;
  state.history.past.push(__historySnapshotBeforeEdit);
  if (state.history.past.length > state.history.limit) state.history.past.shift();
  state.history.future = [];
  __historySnapshotBeforeEdit = null;
  state.dirty = true;
  scheduleAutosave();
  updateUndoRedoButtons();
}
function doAction(mutateFn){ beginEdit(); mutateFn(); commitEdit(); renderAll(); }
function undo(){
  if (!state.history.past.length) return;
  const cur = snapshotState();
  const prev = state.history.past.pop();
  state.history.future.push(cur);
  restoreSnapshot(prev);
  state.dirty = true;
  scheduleAutosave();
  renderAll();
  updateUndoRedoButtons();
}
function redo(){
  if (!state.history.future.length) return;
  const cur = snapshotState();
  const next = state.history.future.pop();
  state.history.past.push(cur);
  restoreSnapshot(next);
  state.dirty = true;
  scheduleAutosave();
  renderAll();
  updateUndoRedoButtons();
}
function updateUndoRedoButtons(){
  DOM.btnUndo.disabled = state.history.past.length === 0;
  DOM.btnRedo.disabled = state.history.future.length === 0;
}

/* ---------------- selection ---------------- */
function selectOnly(id){
  state.selectedIds = id ? [id] : [];
}
function toggleSelectId(id){
  if (state.selectedIds.includes(id)){
    state.selectedIds = state.selectedIds.filter(tId => tId !== id);
  } else {
    state.selectedIds.push(id);
  }
}
function selectAllShapes(){ state.selectedIds = state.shapes.filter(s => !s.locked).map(s => s.id); }
function clearSelection(){ state.selectedIds = []; }

/* ---------------- shape grouping ---------------- */
function pruneEmptyGroups(){
  if (!state.groups) state.groups = {};
  for (const groupId of Object.keys(state.groups)){
    if (!state.shapes.some(shape => shape.groupId === groupId)) delete state.groups[groupId];
  }
}
function nextGroupId(){
  let id = uid('group');
  while (state.groups && state.groups[id]) id = uid('group');
  return id;
}
function groupSelectedShapes(){
  const sel = selectedShapes().filter(s => !s.locked);
  if (sel.length < 2){ showToast('Select at least 2 vectors to create a group'); return; }
  doAction(() => {
    if (!state.groups) state.groups = {};
    const newGroupId = nextGroupId();
    state.groups[newGroupId] = { id: newGroupId, name: 'Group ' + (Object.keys(state.groups).length + 1), expanded: true };
    for (const s of sel){
      s.groupId = newGroupId;
    }
    pruneEmptyGroups();
  });
  showToast('Grouped ' + sel.length + ' layers');
}

function addSelectionToGroup(groupId){
  const selected = selectedShapes().filter(shape => !shape.locked && shape.groupId !== groupId);
  if (!selected.length){ showToast('Select vectors outside this group to add them'); return; }
  doAction(() => {
    if (!state.groups) state.groups = {};
    if (!state.groups[groupId]) state.groups[groupId] = { id:groupId, name:'Group', expanded:true };
    for (const shape of selected) shape.groupId = groupId;
    pruneEmptyGroups();
  });
  showToast('Added ' + selected.length + ' vector' + (selected.length === 1 ? '' : 's') + ' to group');
}

function removeShapeFromGroup(id){
  const shape = findShapeById(id);
  if (!shape || !shape.groupId) return;
  const groupId = shape.groupId;
  doAction(() => {
    shape.groupId = null;
    pruneEmptyGroups();
  });
  showToast('Removed vector from group');
}

function ungroupSelectedShapes(){
  const sel = selectedShapes();
  const groupIds = new Set(sel.map(s => s.groupId).filter(Boolean));
  if (!groupIds.size) return;
  doAction(() => {
    for (const s of state.shapes){
      if (groupIds.has(s.groupId)){
        s.groupId = null;
      }
    }
    if (state.groups){
      for (const gId of groupIds){
        delete state.groups[gId];
      }
    }
    pruneEmptyGroups();
  });
  showToast('Ungrouped layers');
}

/* ---------------- z-order ---------------- */
function bringToFront(id){ const i=shapeIndex(id); if(i<0) return; const [s]=state.shapes.splice(i,1); state.shapes.push(s); }
function sendToBack(id){ const i=shapeIndex(id); if(i<0) return; const [s]=state.shapes.splice(i,1); state.shapes.unshift(s); }
function bringForward(id){ const i=shapeIndex(id); if(i<0||i>=state.shapes.length-1) return; const t=state.shapes[i]; state.shapes[i]=state.shapes[i+1]; state.shapes[i+1]=t; }
function sendBackward(id){ const i=shapeIndex(id); if(i<=0) return; const t=state.shapes[i]; state.shapes[i]=state.shapes[i-1]; state.shapes[i-1]=t; }
function reorderShapeTo(id, beforeId){
  const i = shapeIndex(id); if (i<0) return;
  const [s] = state.shapes.splice(i,1);
  if (beforeId == null){ state.shapes.push(s); return; }
  let j = shapeIndex(beforeId);
  if (j<0) j = state.shapes.length;
  state.shapes.splice(j,0,s);
}

/* ---------------- duplicate / delete ---------------- */
function duplicateShapesByIds(ids){
  const clones = [];
  const groupMap = {};
  for (const id of ids){
    const s = findShapeById(id);
    if (!s) continue;
    const c = deepClone(s);
    c.id = uid('shape');
    c.name = s.name + ' copy';
    if (s.groupId){
      if (!groupMap[s.groupId]){
        groupMap[s.groupId] = uid('group');
        const origG = state.groups ? state.groups[s.groupId] : null;
        if (!state.groups) state.groups = {};
        state.groups[groupMap[s.groupId]] = { id: groupMap[s.groupId], name: (origG ? origG.name : 'Group') + ' copy', expanded: true };
      }
      c.groupId = groupMap[s.groupId];
    }
    const nudge = Math.max(state.doc.viewportWidth, state.doc.viewportHeight) * 0.04;
    moveShapeBy(c, nudge, nudge);
    const idx = shapeIndex(id);
    state.shapes.splice(idx+1, 0, c);
    clones.push(c);
  }
  return clones;
}
function deleteShapesByIds(ids){
  state.shapes = state.shapes.filter(s => !ids.includes(s.id));
  state.selectedIds = state.selectedIds.filter(id => !ids.includes(id));
  pruneEmptyGroups();
}

/* ---------------- align (uses live-rendered bboxes, call after a render) ---------------- */
function alignSelected(edge){
  const ids = state.selectedIds.filter(id => { const s=findShapeById(id); return s && !s.locked; });
  if (ids.length < 2) return;
  const boxes = ids.map(id => {
    const node = gShapes.querySelector('.shape-node[data-id="'+id+'"]');
    const bb = node ? node.getBBox() : {x:0,y:0,width:0,height:0};
    return { id, bb };
  });
  let target;
  if (edge==='left') target = Math.min.apply(null, boxes.map(b=>b.bb.x));
  else if (edge==='right') target = Math.max.apply(null, boxes.map(b=>b.bb.x+b.bb.width));
  else if (edge==='hcenter') target = (Math.min.apply(null,boxes.map(b=>b.bb.x)) + Math.max.apply(null,boxes.map(b=>b.bb.x+b.bb.width)))/2;
  else if (edge==='top') target = Math.min.apply(null, boxes.map(b=>b.bb.y));
  else if (edge==='bottom') target = Math.max.apply(null, boxes.map(b=>b.bb.y+b.bb.height));
  else if (edge==='vcenter') target = (Math.min.apply(null,boxes.map(b=>b.bb.y)) + Math.max.apply(null,boxes.map(b=>b.bb.y+b.bb.height)))/2;
  doAction(() => {
    for (const {id,bb} of boxes){
      const shape = findShapeById(id);
      let dx=0, dy=0;
      if (edge==='left') dx = target - bb.x;
      else if (edge==='right') dx = target - (bb.x+bb.width);
      else if (edge==='hcenter') dx = target - (bb.x+bb.width/2);
      else if (edge==='top') dy = target - bb.y;
      else if (edge==='bottom') dy = target - (bb.y+bb.height);
      else if (edge==='vcenter') dy = target - (bb.y+bb.height/2);
      moveShapeBy(shape, dx, dy);
    }
  });
}

/* ---------------- distribute (equal spacing between selected objects) ---------------- */
function distributeSelected(axis){
  const ids = state.selectedIds.filter(id => { const s=findShapeById(id); return s && !s.locked; });
  if (ids.length < 2) return;
  const boxes = ids.map(id => {
    const node = gShapes.querySelector('.shape-node[data-id="'+id+'"]');
    const bb = node ? node.getBBox() : {x:0,y:0,width:0,height:0};
    return { id, bb };
  });

  if (axis === 'h'){
    boxes.sort((a, b) => (a.bb.x + a.bb.width/2) - (b.bb.x + b.bb.width/2));
    const minX = boxes[0].bb.x;
    const lastBox = boxes[boxes.length - 1];
    const maxX = lastBox.bb.x + lastBox.bb.width;
    const totalSpan = maxX - minX;
    const totalObjectWidth = boxes.reduce((sum, b) => sum + b.bb.width, 0);
    const gap = boxes.length > 1 ? (totalSpan - totalObjectWidth) / (boxes.length - 1) : 0;

    doAction(() => {
      let currentX = minX;
      for (let i = 0; i < boxes.length; i++){
        const item = boxes[i];
        const shape = findShapeById(item.id);
        const dx = currentX - item.bb.x;
        moveShapeBy(shape, dx, 0);
        currentX += item.bb.width + gap;
      }
    });
    showToast('Distributed horizontally');
  } else {
    boxes.sort((a, b) => (a.bb.y + a.bb.height/2) - (b.bb.y + b.bb.height/2));
    const minY = boxes[0].bb.y;
    const lastBox = boxes[boxes.length - 1];
    const maxY = lastBox.bb.y + lastBox.bb.height;
    const totalSpan = maxY - minY;
    const totalObjectHeight = boxes.reduce((sum, b) => sum + b.bb.height, 0);
    const gap = boxes.length > 1 ? (totalSpan - totalObjectHeight) / (boxes.length - 1) : 0;

    doAction(() => {
      let currentY = minY;
      for (let i = 0; i < boxes.length; i++){
        const item = boxes[i];
        const shape = findShapeById(item.id);
        const dy = currentY - item.bb.y;
        moveShapeBy(shape, 0, dy);
        currentY += item.bb.height + gap;
      }
    });
    showToast('Distributed vertically');
  }
}


/* =====================================================================================
   Part 6: properties panel — templates, field application, event delegation
   ===================================================================================== */
function chevronSvg(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'; }

function normalizeHexColor(raw){
  if (!raw) return null;
  let s = raw.trim();
  if (s[0] !== '#') s = '#' + s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) s = '#' + s[1]+s[1]+s[2]+s[2]+s[3]+s[3];
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  return null;
}

function selectionHeaderHtml(shapes){
  if (shapes.length === 1){
    return `<div class="row" style="padding:12px 16px 0;"><b style="font-family:var(--font-ui);font-size:13px;">${escapeHtml(shapes[0].name)}</b></div>`;
  }
  return `<div class="row" style="padding:12px 16px 0;"><b style="font-family:var(--font-ui);font-size:13px;">${shapes.length} shapes selected</b></div>`;
}

function colorPresetsHtml(field){
  const presets = ['#000000','#FFFFFF','#5EE1A0','#6FA8FF','#FF6B6B','#F5B75E','#B98CFF','#9AA1AF'];
  return presets.map(c => `<span class="preset-dot" data-field="${field}" data-value="${c}" style="background:${c}" title="${c}"></span>`).join('');
}

const FONT_WEIGHT_NAMES = {100:'Thin',200:'Extra Light',300:'Light',400:'Regular',500:'Medium',600:'SemiBold',700:'Bold',800:'Extra Bold',900:'Black'};
function fontWeightLabel(w){ return (FONT_WEIGHT_NAMES[w] || String(w)) + ' (' + w + ')'; }
// Looks up which weights/styles a family actually ships, from the cached Google Fonts
// list, so the weight dropdown only offers combinations that will actually load. Falls
// back to a safe Regular/Bold guess before the list has finished loading.
function getFontVariantsInfo(family){
  const fallback = { weights: [400, 700], hasItalic: true };
  if (!__googleFontsList) return fallback;
  const meta = __googleFontsList.find(f => f.family === family);
  if (!meta || !meta.variants) return fallback;
  const weightsSet = new Set();
  let hasItalic = false;
  meta.variants.forEach(v => {
    if (v === 'regular') weightsSet.add(400);
    else if (v === 'italic'){ weightsSet.add(400); hasItalic = true; }
    else {
      const m = /^(\d+)(italic)?$/.exec(v);
      if (m){ weightsSet.add(parseInt(m[1], 10)); if (m[2]) hasItalic = true; }
    }
  });
  const weights = Array.from(weightsSet).sort((a,b) => a-b);
  return { weights: weights.length ? weights : [400], hasItalic };
}
function textRowsHtml(shape){
  const info = getFontVariantsInfo(shape.fontFamily);
  const weightOptions = info.weights.map(w => `<option value="${w}" ${shape.fontWeight===w?'selected':''}>${fontWeightLabel(w)}</option>`).join('');
  const loadingNote = shape.__textLoading ? '<div class="hint" style="color:var(--text-2);">Loading font…</div>' : '';
  const errorNote = shape.__textError ? `<div class="hint" style="color:var(--warn);">⚠ ${escapeHtml(shape.__textError)}</div>` : '';
  return `
    <div class="field"><label>Content</label><textarea data-field="textContent" rows="2" spellcheck="false">${escapeHtml(shape.text || '')}</textarea></div>
    <div class="field">
      <label>Font</label>
      <button class="btn small" data-action="openFontBrowser" style="width:100%;justify-content:space-between;display:flex;align-items:center;">
        <span style="font-weight:600;">${escapeHtml(shape.fontFamily)}</span>
        <span style="opacity:.6;">Browse…</span>
      </button>
    </div>
    <div class="row">
      <div class="field"><label>Weight</label><select class="select" data-field="fontWeight">${weightOptions}</select></div>
      <div class="field" style="flex:none;min-width:70px;"><label>Italic</label><label class="checkbox-row" style="height:28px;"><input type="checkbox" class="sw" data-field="fontItalic" ${shape.fontItalic?'checked':''} ${info.hasItalic?'':'disabled'}></label></div>
    </div>
    <div class="row">
      <div class="field"><label>Size</label><input type="number" step="0.5" min="0.5" data-field="fontSize" value="${fmt(shape.fontSize)}"></div>
      <div class="field"><label>Letter spacing</label><input type="number" step="0.1" data-field="letterSpacing" value="${fmt(shape.letterSpacing||0)}"></div>
    </div>
    <div class="field"><label>Align</label>
      <div class="segmented">
        <button data-field="textAlign" data-value="left" class="${(shape.textAlign||'left')==='left'?'active':''}">Left</button>
        <button data-field="textAlign" data-value="center" class="${shape.textAlign==='center'?'active':''}">Center</button>
        <button data-field="textAlign" data-value="right" class="${shape.textAlign==='right'?'active':''}">Right</button>
      </div>
    </div>
    ${loadingNote}${errorNote}
    <div class="btn-row" style="margin-top:2px;">
      <button class="btn small" data-action="convertTextToPath" style="width:100%;">Convert to Path (Outline)</button>
    </div>
    <div class="hint">Converting freezes the current letterforms as a plain editable path — you can then drag individual points, but the text content/font stop being editable.</div>`;
}
function geometryRowsHtml(shape){
  const pos = getShapePos(shape);
  let rows = `
    <div class="row">
      <div class="field"><label>X</label><input type="number" step="0.1" data-field="posX" value="${fmt(pos.x)}"></div>
      <div class="field"><label>Y</label><input type="number" step="0.1" data-field="posY" value="${fmt(pos.y)}"></div>
    </div>`;
  if (shape.type !== 'path' && shape.type !== 'curve' && shape.type !== 'text'){
    rows += `
    <div class="row">
      <div class="field"><label>Width</label><input type="number" step="0.1" min="0.05" data-field="width" value="${fmt(shape.width)}"></div>
      <div class="field"><label>Height</label><input type="number" step="0.1" min="0.05" data-field="height" value="${fmt(shape.height)}"></div>
    </div>`;
  }
  if (shape.type === 'rect'){
    const maxR = Math.max(0, Math.min(shape.width, shape.height)/2);
    const hasPerCorner = shape.radiusTL != null || shape.radiusTR != null || shape.radiusBR != null || shape.radiusBL != null;
    if (hasPerCorner){
      const vTL = fmt(shape.radiusTL ?? shape.radius);
      const vTR = fmt(shape.radiusTR ?? shape.radius);
      const vBR = fmt(shape.radiusBR ?? shape.radius);
      const vBL = fmt(shape.radiusBL ?? shape.radius);
      rows += `
    <div class="field">
      <div class="corner-radius-header">
        <label>Corner radius</label>
        <label class="checkbox-row" style="gap:5px;">
          <input type="checkbox" class="sw" data-field="perCornerRadius" checked>
          <span style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.4px;font-weight:600;">Per corner</span>
        </label>
      </div>
      <div class="corner-radius-grid">
        <div class="corner-cell"><span class="corner-label">TL</span><input type="number" step="0.1" min="0" max="${fmt(maxR)}" data-field="radiusTL" value="${vTL}"></div>
        <div class="corner-cell"><span class="corner-label">TR</span><input type="number" step="0.1" min="0" max="${fmt(maxR)}" data-field="radiusTR" value="${vTR}"></div>
        <div class="corner-cell"><span class="corner-label">BL</span><input type="number" step="0.1" min="0" max="${fmt(maxR)}" data-field="radiusBL" value="${vBL}"></div>
        <div class="corner-cell"><span class="corner-label">BR</span><input type="number" step="0.1" min="0" max="${fmt(maxR)}" data-field="radiusBR" value="${vBR}"></div>
      </div>
    </div>`;
    } else {
      rows += `
    <div class="field">
      <div class="corner-radius-header">
        <label>Corner radius</label>
        <label class="checkbox-row" style="gap:5px;">
          <input type="checkbox" class="sw" data-field="perCornerRadius">
          <span style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.4px;font-weight:600;">Per corner</span>
        </label>
      </div>
      <input type="number" step="0.1" min="0" max="${fmt(maxR)}" data-field="radius" value="${fmt(shape.radius)}">
    </div>`;
    }
  }
  if (shape.type === 'polygon'){
    rows += `
    <div class="row">
      <div class="field"><label>Sides</label><input type="number" step="1" min="3" max="24" data-field="sides" value="${shape.sides}"></div>
      <div class="field" style="flex:none;min-width:76px;"><label>Star</label><label class="checkbox-row" style="height:28px;"><input type="checkbox" class="sw" data-field="star" ${shape.star?'checked':''}></label></div>
    </div>`;
    if (shape.star){
      rows += `<div class="field"><label>Inner radius ${Math.round(shape.innerRatio*100)}%</label><input type="range" min="5" max="95" data-field="innerRatio" value="${Math.round(shape.innerRatio*100)}"></div>`;
    }
  }
  if (shape.type === 'arc'){
    const sweep = shape.sweepAngle != null ? shape.sweepAngle : 270;
    const opening = clamp(360 - Math.abs(sweep), 0, 360);
    rows += `
    <div class="row">
      <div class="field"><label>Start angle °</label><input type="number" step="1" data-field="startAngle" value="${fmt(shape.startAngle||0)}"></div>
      <div class="field"><label>Sweep angle °</label><input type="number" step="1" min="-360" max="360" data-field="sweepAngle" value="${fmt(sweep)}"></div>
    </div>
    <div class="field"><label>Opening (gap) ${Math.round((opening/360)*100)}%</label><input type="range" min="0" max="100" step="1" data-field="arcOpening" value="${Math.round((opening/360)*100)}"></div>
    <div class="btn-row" style="flex-wrap:wrap;">
      <button class="btn small" data-action="arcPreset0">Full ring</button>
      <button class="btn small" data-action="arcPreset90">Quarter</button>
      <button class="btn small" data-action="arcPreset180">Half</button>
      <button class="btn small" data-action="arcPreset270">Three-quarter</button>
      <button class="btn small" data-action="arcPreset330">Thin pie</button>
    </div>
    <label class="checkbox-row" style="margin-top:4px;"><input type="checkbox" class="sw" data-field="sector" ${shape.sector?'checked':''}><span>Pie / sector (fill to center)</span></label>
    <div class="field"><label>Inner radius (ring hole) ${Math.round(shape.innerRadiusPercent||0)}%</label><input type="range" min="0" max="95" step="1" data-field="innerRadiusPercent" value="${Math.round(shape.innerRadiusPercent||0)}"></div>
    <div class="hint">Drag the teal/amber angle handles directly on the canvas (Edit points tool) for a live preview, or use the opening slider for a quick pie-chart cut.</div>`;
  }
  if (shape.type === 'curve'){
    const len = Math.hypot((shape.x2-shape.x1), (shape.y2-shape.y1));
    rows += `<div class="hint">Bézier curve, endpoint span ${fmt(len)} px. Drag the two blue diamond handles on canvas to shape the curve, or the round endpoints to move it.</div>
    <div class="btn-row">
      <button class="btn small" data-action="curveSmooth">Smooth S-curve</button>
      <button class="btn small" data-action="curveStraighten">Straighten</button>
    </div>`;
  }
  if (shape.type === 'path'){
    const sub = shape.rawD ? parseSvgPathToSubpaths(shape.rawD) : [];
    const ptCount = sub.reduce((acc, sp) => acc + sp.points.length, 0);
    rows += `<div class="hint">Path with ${ptCount} point${ptCount !== 1 ? 's' : ''} (${fmt(shape.nativeWidth)} × ${fmt(shape.nativeHeight)}). Drag points on canvas to edit vertices.</div>`;
    if (ptCount >= 2){
      rows += `<div class="btn-row" style="margin-top:6px;"><button class="btn small" data-action="disconnectLines" style="width:100%;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;margin-right:4px;"><path d="M4 7l4 4-4 4"/><path d="M20 7l-4 4 4 4"/><line x1="9" y1="12" x2="15" y2="12"/></svg>Disconnect / Split into lines</button></div>`;
    }
  }
  if (shape.type === 'line'){
    const pts = getLineEndpointsStage(shape);
    const len = Math.hypot(pts.p2.x - pts.p1.x, pts.p2.y - pts.p1.y);
    rows += `<div class="hint">Line length: ${fmt(len)} px. Drag endpoints on canvas to edit or snap-connect to other lines.</div>`;
  }
  return rows;
}
function transformRowsHtml(shape){
  return `
    <div class="row">
      <div class="field"><label>Rotation °</label><input type="number" step="1" data-field="rotation" value="${fmt(shape.rotation)}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Scale X</label><input type="number" step="0.05" data-field="scaleX" value="${fmt(shape.scaleX)}"></div>
      <div class="field"><label>Scale Y</label><input type="number" step="0.05" data-field="scaleY" value="${fmt(shape.scaleY)}"></div>
    </div>
    <div class="btn-row">
      <button class="btn small" data-action="flipH">Flip H</button>
      <button class="btn small" data-action="flipV">Flip V</button>
      <button class="btn small" data-action="resetTransform">Reset</button>
    </div>`;
}
/* ---------------- gradient editor ----------------
   `kind` is 'fill' or 'stroke'; every control carries it in the field name so one set of
   markup and one set of handlers drives both channels. */
function gradientEditorHtml(shape, kind){
  const g = normalizeGradient(kind === 'stroke' ? shape.strokeGradient : shape.fillGradient);
  const f = (name) => `${kind}Grad${name}`;
  const isLinear = g.type === 'linear';
  const isRadial = g.type === 'radial';
  const isSweep = g.type === 'sweep';

  const typeRow = `
    <div class="field"><label>Style</label>
      <div class="segmented">
        <button data-field="${f('Type')}" data-value="linear" class="${isLinear?'active':''}">Linear</button>
        <button data-field="${f('Type')}" data-value="radial" class="${isRadial?'active':''}">Radial</button>
        <button data-field="${f('Type')}" data-value="sweep" class="${isSweep?'active':''}">Sweep</button>
      </div>
    </div>`;

  // Linear uses a direction angle; radial a center and radius; sweep both a center and
  // the angle its ramp starts from.
  let geometryRows = '';
  if (isLinear || isSweep){
    geometryRows += `
    <div class="field">
      <label>${isSweep ? 'Start angle' : 'Angle'} <span class="grad-readout">${fmt(g.angle)}°</span></label>
      <input type="range" min="0" max="360" step="1" data-field="${f('Angle')}" value="${fmt(g.angle)}">
    </div>
    <div class="btn-row grad-angle-row">
      <button class="btn small" data-grad-action="angle" data-kind="${kind}" data-value="0">→ 0°</button>
      <button class="btn small" data-grad-action="angle" data-kind="${kind}" data-value="90">↓ 90°</button>
      <button class="btn small" data-grad-action="angle" data-kind="${kind}" data-value="180">← 180°</button>
      <button class="btn small" data-grad-action="angle" data-kind="${kind}" data-value="45">↘ 45°</button>
    </div>`;
  }
  if (isRadial || isSweep){
    geometryRows += `
    <div class="row">
      <div class="field"><label>Center X</label><input type="number" step="0.05" min="-1" max="2" data-field="${f('Cx')}" value="${fmt(g.cx)}"></div>
      <div class="field"><label>Center Y</label><input type="number" step="0.05" min="-1" max="2" data-field="${f('Cy')}" value="${fmt(g.cy)}"></div>
    </div>`;
  }
  if (isRadial){
    geometryRows += `
    <div class="field">
      <label>Radius <span class="grad-readout">${Math.round(g.radius*100)}%</span></label>
      <input type="range" min="5" max="200" step="1" data-field="${f('Radius')}" value="${Math.round(g.radius*100)}">
    </div>`;
  }

  const stopsHtml = g.stops.map((stop, i) => `
    <div class="grad-stop" data-stop-row="${i}" data-kind="${kind}">
      <span class="drag-handle" data-tip="Drag to reorder">⠿</span>
      <span class="swatch grad-stop-swatch"><i style="background:${rgbaCss(stop.color, stop.opacity)}"></i><input type="color" data-field="${f('StopColor')}" data-stop-index="${i}" value="${stop.color}"></span>
      <input type="text" class="hexinput grad-stop-hex" data-field="${f('StopColor')}" data-stop-index="${i}" value="${stop.color}" maxlength="9" spellcheck="false">
      <label class="grad-stop-num" title="Position along the ramp">
        <input type="number" min="0" max="100" step="1" data-field="${f('StopOffset')}" data-stop-index="${i}" value="${Math.round(stop.offset*100)}" data-no-stepper="1"><span>%</span>
      </label>
      <label class="grad-stop-num" title="Stop transparency">
        <input type="number" min="0" max="100" step="1" data-field="${f('StopOpacity')}" data-stop-index="${i}" value="${Math.round(stop.opacity*100)}" data-no-stepper="1"><span>α</span>
      </label>
      <button class="grad-stop-del" data-grad-action="removeStop" data-kind="${kind}" data-stop-index="${i}" title="${g.stops.length <= 2 ? 'A gradient needs at least two stops' : 'Remove this stop'}" ${g.stops.length <= 2 ? 'disabled' : ''} aria-label="Remove stop ${i+1}">✕</button>
    </div>`).join('');

  const presetsHtml = GRADIENT_PRESETS.map((p, i) =>
    `<button class="grad-preset" data-grad-action="preset" data-kind="${kind}" data-preset-index="${i}" title="${escapeHtml(p.name)}" aria-label="${escapeHtml(p.name)}" style="--ramp:${gradientCssPreview(gradientFromPreset(p))}"></button>`
  ).join('');

  return `
    <div class="grad-preview" style="--ramp:${gradientCssPreview(g)}" aria-hidden="true"></div>
    ${typeRow}
    ${geometryRows}
    <div class="field"><label>Repeat beyond the ramp</label>
      <div class="segmented">
        <button data-field="${f('Tile')}" data-value="clamp" class="${g.tileMode==='clamp'?'active':''}">Clamp</button>
        <button data-field="${f('Tile')}" data-value="repeat" class="${g.tileMode==='repeat'?'active':''}">Repeat</button>
        <button data-field="${f('Tile')}" data-value="mirror" class="${g.tileMode==='mirror'?'active':''}">Mirror</button>
      </div>
    </div>
    <div class="grad-stops-head">
      <span>Color stops</span>
      <span class="hint">${g.stops.length} of ${MAX_GRADIENT_STOPS}</span>
    </div>
    <div class="grad-stops">${stopsHtml}</div>
    <div class="btn-row">
      <button class="btn small" data-grad-action="addStop" data-kind="${kind}" ${g.stops.length >= MAX_GRADIENT_STOPS ? 'disabled' : ''}>Add stop</button>
      <button class="btn small" data-grad-action="reverse" data-kind="${kind}">Reverse</button>
      <button class="btn small" data-grad-action="distribute" data-kind="${kind}" title="Space the stops evenly along the ramp">Even out</button>
    </div>
    <div class="grad-presets-head">Presets</div>
    <div class="grad-presets">${presetsHtml}</div>
    <div class="hint">α sets each stop's transparency. Gradients export as an Android <b>&lt;gradient&gt;</b> and need minSdk 24.</div>`;
}
function paintModeSegmentHtml(shape, kind){
  const current = (kind === 'stroke' ? shape.strokePaint : shape.fillPaint) === 'gradient' ? 'gradient' : 'solid';
  const field = kind === 'stroke' ? 'strokePaintMode' : 'fillPaintMode';
  return `
    <div class="field"><label>Paint</label>
      <div class="segmented">
        <button data-field="${field}" data-value="solid" class="${current==='solid'?'active':''}">Solid</button>
        <button data-field="${field}" data-value="gradient" class="${current==='gradient'?'active':''}">Gradient</button>
      </div>
    </div>`;
}
function fillRowsHtml(shape){
  let html = `<label class="checkbox-row"><input type="checkbox" class="sw" data-field="fillEnabled" ${shape.fillEnabled?'checked':''}><span>Filled</span></label>`;
  if (shape.fillEnabled){
    html += paintModeSegmentHtml(shape, 'fill');
    if (shape.fillPaint === 'gradient'){
      html += gradientEditorHtml(shape, 'fill');
    } else {
      html += `
      <div class="color-field">
        <span class="swatch"><i style="background:${shape.fillColor}"></i><input type="color" data-field="fillColor" value="${shape.fillColor}"></span>
        <input type="text" class="hexinput" data-field="fillColor" value="${shape.fillColor}" maxlength="9" spellcheck="false">
      </div>
      <div class="presets">${colorPresetsHtml('fillColor')}</div>`;
    }
    html += `
    <div class="field"><label>Opacity ${Math.round(shape.fillOpacity*100)}%</label><input type="range" min="0" max="100" data-field="fillOpacity" value="${Math.round(shape.fillOpacity*100)}"></div>
    <div class="field"><label>Fill rule</label>
      <div class="segmented">
        <button data-field="fillType" data-value="nonZero" class="${shape.fillType!=='evenOdd'?'active':''}">Non-zero</button>
        <button data-field="fillType" data-value="evenOdd" class="${shape.fillType==='evenOdd'?'active':''}">Even-odd</button>
      </div>
    </div>`;
  }
  return html;
}
function strokeRowsHtml(shape){
  let html = `<label class="checkbox-row"><input type="checkbox" class="sw" data-field="strokeEnabled" ${shape.strokeEnabled?'checked':''}><span>Stroked</span></label>`;
  if (shape.strokeEnabled){
    html += paintModeSegmentHtml(shape, 'stroke');
    if (shape.strokePaint === 'gradient'){
      html += gradientEditorHtml(shape, 'stroke');
    } else {
      html += `
      <div class="color-field">
        <span class="swatch"><i style="background:${shape.strokeColor}"></i><input type="color" data-field="strokeColor" value="${shape.strokeColor}"></span>
        <input type="text" class="hexinput" data-field="strokeColor" value="${shape.strokeColor}" maxlength="9" spellcheck="false">
      </div>
      <div class="presets">${colorPresetsHtml('strokeColor')}</div>`;
    }
    html += `
    <div class="row">
      <div class="field"><label>Center width</label><input type="number" step="0.1" min="0" data-field="strokeWidth" value="${fmt(shape.strokeWidth)}"></div>
      <div class="field"><label>Opacity ${Math.round(shape.strokeOpacity*100)}%</label><input type="range" min="0" max="100" data-field="strokeOpacity" value="${Math.round(shape.strokeOpacity*100)}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Inner width</label><input type="number" step="0.1" min="0" data-field="strokeInnerWidth" value="${fmt(shape.strokeInnerWidth || 0)}"></div>
      <div class="field"><label>Outer width</label><input type="number" step="0.1" min="0" data-field="strokeOuterWidth" value="${fmt(shape.strokeOuterWidth || 0)}"></div>
    </div>
    <div class="hint" style="margin-top:-2px;">Inner and outer strokes layer independently. Inner strokes apply to closed shapes; Android XML exports the centered stroke.</div>
    <div class="field"><label>Cap</label>
      <div class="segmented">
        <button data-field="strokeCap" data-value="butt" class="${shape.strokeLineCap==='butt'?'active':''}">Butt</button>
        <button data-field="strokeCap" data-value="round" class="${shape.strokeLineCap==='round'?'active':''}">Round</button>
        <button data-field="strokeCap" data-value="square" class="${shape.strokeLineCap==='square'?'active':''}">Square</button>
      </div>
    </div>
    <div class="field"><label>Join</label>
      <div class="segmented">
        <button data-field="strokeJoin" data-value="miter" class="${shape.strokeLineJoin==='miter'?'active':''}">Miter</button>
        <button data-field="strokeJoin" data-value="round" class="${shape.strokeLineJoin==='round'?'active':''}">Round</button>
        <button data-field="strokeJoin" data-value="bevel" class="${shape.strokeLineJoin==='bevel'?'active':''}">Bevel</button>
      </div>
    </div>`;
    if (shape.strokeLineJoin === 'miter'){
      html += `<div class="field"><label>Miter limit</label><input type="number" step="0.5" min="1" data-field="strokeMiter" value="${fmt(shape.strokeMiterLimit)}"></div>`;
    }
  }
  return html;
}
function renderSingleShapePanel(shape){
  const warn = !shapeHasFillOrStroke(shape) ? '<div class="hint" style="color:var(--warn);margin-top:2px;">⚠ No fill and no stroke — this shape will be invisible in the exported icon.</div>' : '';
  const textSection = shape.type === 'text' ? `
    <div class="section" id="sec-text">
      <div class="section-head" data-section="sec-text"><span class="title">Text</span>${chevronSvg()}</div>
      <div class="section-body">${textRowsHtml(shape)}</div>
    </div>` : '';
  return `
    ${selectionHeaderHtml([shape])}
    ${textSection}
    <div class="section" id="sec-geo">
      <div class="section-head" data-section="sec-geo"><span class="title">Geometry</span>${chevronSvg()}</div>
      <div class="section-body">${geometryRowsHtml(shape)}</div>
    </div>
    <div class="section" id="sec-xform">
      <div class="section-head" data-section="sec-xform"><span class="title">Transform</span>${chevronSvg()}</div>
      <div class="section-body">${transformRowsHtml(shape)}</div>
    </div>
    <div class="section" id="sec-fill">
      <div class="section-head" data-section="sec-fill"><span class="title">Fill</span>${chevronSvg()}</div>
      <div class="section-body">${fillRowsHtml(shape)}</div>
    </div>
    <div class="section" id="sec-stroke">
      <div class="section-head" data-section="sec-stroke"><span class="title">Stroke</span>${chevronSvg()}</div>
      <div class="section-body">${strokeRowsHtml(shape)}</div>
    </div>
    <div class="section" id="sec-arrange">
      <div class="section-head" data-section="sec-arrange"><span class="title">Arrange</span>${chevronSvg()}</div>
      <div class="section-body">
        <div class="btn-row">
          <button class="btn small icon-only" data-action="bringFront" title="Bring to front">⤒</button>
          <button class="btn small icon-only" data-action="bringForward" title="Bring forward">↑</button>
          <button class="btn small icon-only" data-action="sendBackward" title="Send backward">↓</button>
          <button class="btn small icon-only" data-action="sendBack" title="Send to back">⤓</button>
        </div>
        <div class="btn-row">
          <button class="btn small" data-action="duplicate">Duplicate</button>
          <button class="btn small danger" data-action="delete">Delete</button>
        </div>
        ${shape.groupId ? '<div class="btn-row"><button class="btn small" data-action="ungroup">Ungroup</button></div>' : ''}
        ${warn}
      </div>
    </div>`;
}
function renderMultiShapePanel(shapes){
  const hasGroup = shapes.some(s => s.groupId);
  return `
    ${selectionHeaderHtml(shapes)}
    <div class="section" id="sec-align">
      <div class="section-head" data-section="sec-align"><span class="title">Align</span>${chevronSvg()}</div>
      <div class="section-body">
        <div class="btn-row">
          <button class="btn small" data-action="alignLeft">⟸ Left</button>
          <button class="btn small" data-action="alignHCenter">↔ Center</button>
          <button class="btn small" data-action="alignRight">⟹ Right</button>
        </div>
        <div class="btn-row">
          <button class="btn small" data-action="alignTop">⟰ Top</button>
          <button class="btn small" data-action="alignVCenter">↕ Middle</button>
          <button class="btn small" data-action="alignBottom">⟱ Bottom</button>
        </div>
      </div>
    </div>
    <div class="section" id="sec-distribute">
      <div class="section-head" data-section="sec-distribute"><span class="title">Distribute</span>${chevronSvg()}</div>
      <div class="section-body">
        <div class="btn-row">
          <button class="btn small" data-action="distributeH"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;margin-right:4px;"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>Distribute H</button>
          <button class="btn small" data-action="distributeV"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;margin-right:4px;"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>Distribute V</button>
        </div>
        <div class="hint">Evenly space selected objects horizontally or vertically.</div>
      </div>
    </div>
    <div class="section" id="sec-boolean">
      <div class="section-head" data-section="sec-boolean"><span class="title">Boolean / Cut Operations</span>${chevronSvg()}</div>
      <div class="section-body">
        <div class="btn-row">
          <button class="btn small" data-action="boolUnion" title="Merge shapes together"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;margin-right:4px;"><path d="M4.5 3A1.5 1.5 0 0 0 3 4.5v9A1.5 1.5 0 0 0 4.5 15H9v4.5A1.5 1.5 0 0 0 10.5 21h9a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 19.5 9H15V4.5A1.5 1.5 0 0 0 13.5 3h-9z" fill="currentColor" fill-opacity="0.3"/><rect x="3" y="3" width="12" height="12" rx="1.5"/><rect x="9" y="9" width="12" height="12" rx="1.5"/></svg>Union</button>
          <button class="btn small" data-action="boolSubtract" title="Cut top shape from bottom shape"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;margin-right:4px;"><path d="M4.5 3A1.5 1.5 0 0 0 3 4.5v9A1.5 1.5 0 0 0 4.5 15H9V9h6V4.5A1.5 1.5 0 0 0 13.5 3h-9z" fill="currentColor" fill-opacity="0.3"/><path d="M4.5 3A1.5 1.5 0 0 0 3 4.5v9A1.5 1.5 0 0 0 4.5 15H9V9h6V4.5A1.5 1.5 0 0 0 13.5 3h-9z"/><rect x="9" y="9" width="12" height="12" rx="1.5" stroke-dasharray="2 2" opacity="0.6"/></svg>Subtract</button>
        </div>
        <div class="btn-row">
          <button class="btn small" data-action="boolIntersect" title="Keep only overlapping area"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;margin-right:4px;"><rect x="3" y="3" width="12" height="12" rx="1.5" stroke-dasharray="2 2" opacity="0.6"/><rect x="9" y="9" width="12" height="12" rx="1.5" stroke-dasharray="2 2" opacity="0.6"/><rect x="9" y="9" width="6" height="6" fill="currentColor" fill-opacity="0.8" stroke="currentColor"/></svg>Intersect</button>
          <button class="btn small" data-action="boolExclude" title="Remove overlapping sections (XOR)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;margin-right:4px;"><path d="M4.5 3A1.5 1.5 0 0 0 3 4.5v9A1.5 1.5 0 0 0 4.5 15H9V9h6V4.5A1.5 1.5 0 0 0 13.5 3h-9z" fill="currentColor" fill-opacity="0.3"/><path d="M10.5 21A1.5 1.5 0 0 0 9 19.5V15h6V9h4.5A1.5 1.5 0 0 1 21 10.5v9A1.5 1.5 0 0 1 19.5 21h-9z" fill="currentColor" fill-opacity="0.3"/><rect x="3" y="3" width="12" height="12" rx="1.5"/><rect x="9" y="9" width="12" height="12" rx="1.5"/><rect x="9" y="9" width="6" height="6" stroke-dasharray="2 2" opacity="0.6"/></svg>Exclude</button>
        </div>
      </div>
    </div>
    <div class="section" id="sec-batchfill">
      <div class="section-head" data-section="sec-batchfill"><span class="title">Batch fill color</span>${chevronSvg()}</div>
      <div class="section-body">
        <div class="color-field">
          <span class="swatch"><i style="background:${shapes[0].fillColor}"></i><input type="color" data-field="fillColor" value="${shapes[0].fillColor}"></span>
          <input type="text" class="hexinput" data-field="fillColor" value="${shapes[0].fillColor}" maxlength="9" spellcheck="false">
        </div>
        <div class="presets">${colorPresetsHtml('fillColor')}</div>
      </div>
    </div>
    <div class="section" id="sec-arrange2">
      <div class="section-head" data-section="sec-arrange2"><span class="title">Arrange</span>${chevronSvg()}</div>
      <div class="section-body">
        <div class="btn-row">
          <button class="btn small" data-action="group">Group</button>
          ${hasGroup ? '<button class="btn small" data-action="ungroup">Ungroup</button>' : ''}
        </div>
        <div class="btn-row">
          <button class="btn small" data-action="duplicate">Duplicate all</button>
          <button class="btn small danger" data-action="delete">Delete all</button>
        </div>
      </div>
    </div>`;
}
function renderPropertiesPanel(){
  const shapes = selectedShapes();
  DOM.secNoSelect.style.display = shapes.length ? 'none' : '';
  DOM.selectionPanels.innerHTML = shapes.length === 0 ? '' : (shapes.length === 1 ? renderSingleShapePanel(shapes[0]) : renderMultiShapePanel(shapes));
}

/* ---------------- field application ---------------- */
function setShapePosAxis(shape, axis, val){
  if (isNaN(val)) return;
  const p = getShapePos(shape);
  if (axis === 'x') setShapePos(shape, val, p.y); else setShapePos(shape, p.x, val);
  if (shape.type !== 'path' && shape.type !== 'curve' && shape.type !== 'text'){
    if (axis === 'x') shape.translateX = (shape.scaleX - 1) * shape.width / 2;
    else shape.translateY = (shape.scaleY - 1) * shape.height / 2;
  }
}
/* Splits a gradient field name like 'fillGradType' into its channel and property.
   Returns null for anything that isn't a gradient field. */
function parseGradientField(field){
  const m = /^(fill|stroke)Grad([A-Za-z]+)$/.exec(field || '');
  return m ? { kind: m[1], prop: m[2] } : null;
}
function applySegmentedField(s, field, value){
  if (field === 'strokeCap') s.strokeLineCap = value;
  else if (field === 'strokeJoin') s.strokeLineJoin = value;
  else if (field === 'fillType') s.fillType = value;
  else if (field === 'fillColor'){ s.fillColor = value; state.lastFillColor = value; }
  else if (field === 'strokeColor'){ s.strokeColor = value; state.lastStrokeColor = value; }
  else if (field === 'textAlign' && s.type === 'text') s.textAlign = value;
  else if (field === 'fillPaintMode'){ s.fillPaint = value === 'gradient' ? 'gradient' : 'solid'; if (value === 'gradient') ensureShapeGradient(s, 'fill'); }
  else if (field === 'strokePaintMode'){ s.strokePaint = value === 'gradient' ? 'gradient' : 'solid'; if (value === 'gradient') ensureShapeGradient(s, 'stroke'); }
  else {
    const gf = parseGradientField(field);
    if (!gf) return;
    const g = ensureShapeGradient(s, gf.kind);
    if (gf.prop === 'Type' && GRADIENT_TYPES.indexOf(value) >= 0) g.type = value;
    else if (gf.prop === 'Tile' && TILE_MODES.indexOf(value) >= 0) g.tileMode = value;
  }
}
// Fields whose effect on a text shape requires re-tracing the glyph outline (async: the
// font file has to be fetched/parsed the first time a given family+weight+style is used).
// Edits to these go through beginEdit()/commitTextShapeEdits() instead of the plain
// doAction()/applyFieldChange() path so the undo history only records the fully-regenerated
// result, never a half-updated shape whose rawD hasn't caught up with its new properties yet.
const TEXT_ASYNC_FIELDS = new Set(['textContent', 'fontSize', 'letterSpacing', 'fontWeight', 'fontItalic', 'textAlign', 'fontFamily']);
function commitTextShapeEdits(){
  renderPropertiesPanel();
  renderStage();
  const textShapes = selectedShapes().filter(s => s.type === 'text');
  Promise.all(textShapes.map(s => regenerateTextPath(s).catch(err => showToast('Font error: ' + err.message))))
    .then(() => { commitEdit(); renderAll(); });
}
let __textRegenPreviewTimer = null;
function scheduleTextRegenPreview(){
  clearTimeout(__textRegenPreviewTimer);
  __textRegenPreviewTimer = setTimeout(() => {
    const textShapes = selectedShapes().filter(s => s.type === 'text');
    Promise.all(textShapes.map(s => regenerateTextPath(s).catch(() => {}))).then(() => renderStage());
  }, 120);
}
function applyFieldChange(field, inputEl){
  const shapes = selectedShapes();
  if (!shapes.length) return;
  const isCheckbox = inputEl.type === 'checkbox';
  const raw = isCheckbox ? inputEl.checked : inputEl.value;
  const num = parseFloat(raw);

  switch(field){
    case 'posX': for (const s of shapes) setShapePosAxis(s,'x', num); break;
    case 'posY': for (const s of shapes) setShapePosAxis(s,'y', num); break;
    case 'width': for (const s of shapes) if (s.type!=='path' && s.type!=='curve') s.width = Math.max(MIN_SHAPE_SIZE, num||MIN_SHAPE_SIZE); break;
    case 'height': for (const s of shapes) if (s.type!=='path' && s.type!=='curve') s.height = Math.max(MIN_SHAPE_SIZE, num||MIN_SHAPE_SIZE); break;
    case 'radius': for (const s of shapes) if (s.type==='rect') s.radius = Math.max(0, num||0); break;
    case 'radiusTL': for (const s of shapes) if (s.type==='rect') s.radiusTL = Math.max(0, num||0); break;
    case 'radiusTR': for (const s of shapes) if (s.type==='rect') s.radiusTR = Math.max(0, num||0); break;
    case 'radiusBR': for (const s of shapes) if (s.type==='rect') s.radiusBR = Math.max(0, num||0); break;
    case 'radiusBL': for (const s of shapes) if (s.type==='rect') s.radiusBL = Math.max(0, num||0); break;
    case 'sides': for (const s of shapes) if (s.type==='polygon') s.sides = clamp(Math.round(num||3),3,24); break;
    case 'star': for (const s of shapes) if (s.type==='polygon') s.star = !!raw; break;
    case 'innerRatio': for (const s of shapes) if (s.type==='polygon') s.innerRatio = clamp(num/100,0.05,0.95); break;
    case 'startAngle': for (const s of shapes) if (s.type==='arc') s.startAngle = isNaN(num) ? 0 : ((num % 360) + 360) % 360; break;
    case 'sweepAngle': for (const s of shapes) if (s.type==='arc') s.sweepAngle = clamp(isNaN(num) ? 270 : num, -360, 360); break;
    case 'arcOpening': for (const s of shapes) if (s.type==='arc'){ const pct = clamp(isNaN(num) ? 0 : num, 0, 100); s.sweepAngle = clamp(360 - (pct/100)*360, 0.1, 360); } break;
    case 'sector': for (const s of shapes) if (s.type==='arc'){ s.sector = !!raw; if (s.sector) s.fillEnabled = true; } break;
    case 'innerRadiusPercent': for (const s of shapes) if (s.type==='arc') s.innerRadiusPercent = clamp(num||0, 0, 95); break;
    case 'rotation': for (const s of shapes) s.rotation = isNaN(num) ? 0 : num; break;
    case 'scaleX': for (const s of shapes) s.scaleX = num || 0.01; break;
    case 'scaleY': for (const s of shapes) s.scaleY = num || 0.01; break;
    case 'fillEnabled': for (const s of shapes) s.fillEnabled = !!raw; break;
    case 'fillColor': {
      let val = raw;
      if (inputEl.type === 'text'){ const n = normalizeHexColor(raw); if (!n) return false; val = n; }
      for (const s of shapes) s.fillColor = val;
      state.lastFillColor = val;
      break;
    }
    case 'fillOpacity': for (const s of shapes) s.fillOpacity = clamp(num/100,0,1); break;
    case 'strokeEnabled': for (const s of shapes) s.strokeEnabled = !!raw; break;
    case 'strokeColor': {
      let val = raw;
      if (inputEl.type === 'text'){ const n = normalizeHexColor(raw); if (!n) return false; val = n; }
      for (const s of shapes) s.strokeColor = val;
      state.lastStrokeColor = val;
      break;
    }
    case 'strokeOpacity': for (const s of shapes) s.strokeOpacity = clamp(num/100,0,1); break;
    case 'strokeWidth': for (const s of shapes) s.strokeWidth = Math.max(0, num||0); break;
    case 'strokeInnerWidth': for (const s of shapes) s.strokeInnerWidth = Math.max(0, num||0); break;
    case 'strokeOuterWidth': for (const s of shapes) s.strokeOuterWidth = Math.max(0, num||0); break;
    case 'strokeMiter': for (const s of shapes) s.strokeMiterLimit = Math.max(1, num||4); break;
    case 'textContent': for (const s of shapes) if (s.type==='text') s.text = raw; break;
    case 'fontSize': for (const s of shapes) if (s.type==='text') s.fontSize = Math.max(0.1, num || 10); break;
    case 'letterSpacing': for (const s of shapes) if (s.type==='text') s.letterSpacing = isNaN(num) ? 0 : num; break;
    case 'fontWeight': for (const s of shapes) if (s.type==='text') s.fontWeight = Math.round(num) || 400; break;
    case 'fontItalic': for (const s of shapes) if (s.type==='text') s.fontItalic = !!raw; break;
    default: return applyGradientFieldChange(field, inputEl, shapes, raw, num);
  }
}
/* Gradient controls all funnel through here. Returns false on an unusable value so the
   caller can roll the edit back, matching how the hex inputs already behave. */
function applyGradientFieldChange(field, inputEl, shapes, raw, num){
  const gf = parseGradientField(field);
  if (!gf) return;
  const stopIndex = inputEl.dataset.stopIndex != null ? parseInt(inputEl.dataset.stopIndex, 10) : -1;

  // A hex value that's still being typed shouldn't blow away the stop's current color.
  let hex = null;
  if (gf.prop === 'StopColor'){
    hex = inputEl.type === 'text' ? normalizeHexColor(raw) : normalizeHexColor(String(raw));
    if (!hex) return false;
  }

  for (const s of shapes){
    const g = ensureShapeGradient(s, gf.kind);
    switch (gf.prop){
      case 'Angle': g.angle = isNaN(num) ? 0 : ((num % 360) + 360) % 360; break;
      case 'Cx': g.cx = isNaN(num) ? 0.5 : clamp(num, -1, 2); break;
      case 'Cy': g.cy = isNaN(num) ? 0.5 : clamp(num, -1, 2); break;
      case 'Radius': g.radius = isNaN(num) ? 0.5 : clamp(num / 100, 0.01, 3); break;
      case 'StopColor': if (g.stops[stopIndex]) g.stops[stopIndex].color = hex; break;
      case 'StopOffset': if (g.stops[stopIndex]) g.stops[stopIndex].offset = isNaN(num) ? 0 : clamp(num / 100, 0, 1); break;
      case 'StopOpacity': if (g.stops[stopIndex]) g.stops[stopIndex].opacity = isNaN(num) ? 1 : clamp(num / 100, 0, 1); break;
    }
  }
}
/* Stops are kept sorted by offset so the renderer and exporter can walk them linearly.
   Re-sorting while someone is dragging an offset would yank the row out from under the
   cursor, so it's deferred to commit time. */
function sortGradientStopsForSelection(){
  for (const s of selectedShapes()){
    if (s.fillGradient) sortGradientStops(s.fillGradient);
    if (s.strokeGradient) sortGradientStops(s.strokeGradient);
  }
}
/* Drag-to-reorder for the stop list. This deliberately moves the COLOR to a new slot
   rather than moving the stop's offset — the set of positions along the ramp stays
   exactly where it was, only which color occupies which position changes. That keeps
   the array staying sorted by offset (required for correct SVG/Android rendering)
   without a re-sort, and matches the gesture: "put this color earlier/later," not
   "move this position elsewhere." */
function moveGradientStop(gradient, fromIndex, toIndex){
  if (!gradient) return;
  const n = gradient.stops.length;
  if (fromIndex < 0 || fromIndex >= n || toIndex < 0 || toIndex >= n || fromIndex === toIndex) return;
  const offsets = gradient.stops.map(s => s.offset);
  const contents = gradient.stops.map(s => ({ color: s.color, opacity: s.opacity }));
  const [moved] = contents.splice(fromIndex, 1);
  contents.splice(toIndex, 0, moved);
  gradient.stops = contents.map((c, i) => makeGradientStop(offsets[i], c.color, c.opacity));
}
/* Buttons inside the gradient editor: presets, stop add/remove, and ramp tweaks.
   Each returns after mutating so the caller can re-render the whole panel — these change
   the editor's shape, not just a value. */
function handleGradientAction(btn){
  const action = btn.dataset.gradAction;
  const kind = btn.dataset.kind === 'stroke' ? 'stroke' : 'fill';
  const shapes = selectedShapes();
  if (!shapes.length) return;

  doAction(() => {
    for (const s of shapes){
      const g = ensureShapeGradient(s, kind);
      if (action === 'preset'){
        const preset = GRADIENT_PRESETS[parseInt(btn.dataset.presetIndex, 10)];
        if (!preset) continue;
        const next = gradientFromPreset(preset);
        // Keep where the user has already aimed a radial/sweep gradient.
        next.cx = g.cx; next.cy = g.cy; next.radius = g.radius; next.tileMode = g.tileMode;
        if (kind === 'stroke') s.strokeGradient = next; else s.fillGradient = next;
      } else if (action === 'addStop'){
        if (g.stops.length >= MAX_GRADIENT_STOPS) continue;
        // Drop the new stop into the widest gap so it lands somewhere useful.
        let gapAt = 0.5, widest = -1;
        for (let i = 0; i < g.stops.length - 1; i++){
          const gap = g.stops[i+1].offset - g.stops[i].offset;
          if (gap > widest){ widest = gap; gapAt = g.stops[i].offset + gap / 2; }
        }
        const sample = sampleGradientColor(g, gapAt);
        g.stops.push(makeGradientStop(gapAt, sample.color, sample.opacity));
        sortGradientStops(g);
      } else if (action === 'removeStop'){
        const idx = parseInt(btn.dataset.stopIndex, 10);
        if (g.stops.length > 2 && idx >= 0 && idx < g.stops.length) g.stops.splice(idx, 1);
      } else if (action === 'reverse'){
        g.stops = g.stops.map(st => makeGradientStop(1 - st.offset, st.color, st.opacity));
        sortGradientStops(g);
      } else if (action === 'distribute'){
        const n = g.stops.length;
        g.stops.forEach((st, i) => { st.offset = n <= 1 ? 0 : i / (n - 1); });
      } else if (action === 'angle'){
        g.angle = clamp(parseFloat(btn.dataset.value) || 0, 0, 360);
      }
    }
  });
  renderPropertiesPanel();
}
function handlePropertiesAction(action){
  switch(action){
    case 'cut': cutSelectionToClipboard(); break;
    case 'copy': copySelectionToClipboard(); break;
    case 'paste': pasteClipboard(); break;
    case 'bringFront': doAction(() => { for (const id of state.selectedIds) bringToFront(id); }); break;
    case 'bringForward': doAction(() => { for (const id of state.selectedIds) bringForward(id); }); break;
    case 'sendBackward': doAction(() => { for (const id of state.selectedIds) sendBackward(id); }); break;
    case 'sendBack': doAction(() => { for (const id of state.selectedIds) sendToBack(id); }); break;
    case 'duplicate': duplicateSelectionAction(); break;
    case 'delete': doAction(() => deleteShapesByIds(state.selectedIds)); break;
    case 'group': groupSelectedShapes(); break;
    case 'ungroup': ungroupSelectedShapes(); break;
    case 'flipH': doAction(() => { for (const s of selectedShapes()) s.scaleX = -s.scaleX; }); break;
    case 'flipV': doAction(() => { for (const s of selectedShapes()) s.scaleY = -s.scaleY; }); break;
    case 'resetTransform': doAction(() => { for (const s of selectedShapes()){ s.rotation=0; s.scaleX=1; s.scaleY=1; } }); break;
    case 'alignLeft': alignSelected('left'); break;
    case 'alignHCenter': alignSelected('hcenter'); break;
    case 'alignRight': alignSelected('right'); break;
    case 'alignTop': alignSelected('top'); break;
    case 'alignVCenter': alignSelected('vcenter'); break;
    case 'alignBottom': alignSelected('bottom'); break;
    case 'distributeH': distributeSelected('h'); break;
    case 'distributeV': distributeSelected('v'); break;
    case 'boolUnion': performBooleanOp('union'); break;
    case 'boolSubtract': performBooleanOp('subtract'); break;
    case 'boolIntersect': performBooleanOp('intersect'); break;
    case 'boolExclude': performBooleanOp('exclude'); break;
    case 'mergeShapes': mergeSelectedShapesIntoPath(); break;
    case 'connectLines': case 'joinLines': joinSelectedLinesAction(); break;
    case 'disconnectLines': case 'splitLines': disconnectSelectedLinesAction(); break;
    case 'arcPreset0': doAction(() => { for (const s of selectedShapes()) if (s.type==='arc') s.sweepAngle = 360; }); break;
    case 'arcPreset90': doAction(() => { for (const s of selectedShapes()) if (s.type==='arc') s.sweepAngle = 90; }); break;
    case 'arcPreset180': doAction(() => { for (const s of selectedShapes()) if (s.type==='arc') s.sweepAngle = 180; }); break;
    case 'arcPreset270': doAction(() => { for (const s of selectedShapes()) if (s.type==='arc') s.sweepAngle = 270; }); break;
    case 'arcPreset330': doAction(() => { for (const s of selectedShapes()) if (s.type==='arc') s.sweepAngle = 30; }); break;
    case 'curveSmooth': doAction(() => { for (const s of selectedShapes()) if (s.type==='curve') smoothCurveShape(s); }); break;
    case 'curveStraighten': doAction(() => { for (const s of selectedShapes()) if (s.type==='curve') straightenCurveShape(s); }); break;
    case 'convertTextToPath':
      doAction(() => { for (const s of selectedShapes()) if (s.type==='text') convertShapeToPathShape(s); });
      showToast('Converted to an editable outline path');
      break;
  }
}

/* ---------------- event delegation (focus-safe: no innerHTML rebuild while typing/dragging) ---------------- */
function updateRangeLabelIfNeeded(t){
  if (t.type !== 'range') return;
  const field = t.closest('.field');
  const label = field && field.querySelector('label');
  if (!label) return;
  // Gradient rows keep their value in a dedicated span with its own unit (° or %), so
  // leave those alone — refreshGradientPreviewIfNeeded() updates them without flattening
  // the label's markup the way the textContent rewrite below would.
  if (label.querySelector('.grad-readout')) return;
  const pct = Math.round(parseFloat(t.value));
  const txt = label.textContent;
  const prefix = txt.split(/\d/)[0].trim();
  label.textContent = prefix + ' ' + pct + '%';
}
function updateSwatchPreviewIfNeeded(t){
  if (t.type !== 'color') return;
  const wrap = t.closest('.swatch');
  if (wrap){ const i = wrap.querySelector('i'); if (i) i.style.background = t.value; }
  const colorField = t.closest('.color-field');
  if (colorField){ const hexIn = colorField.querySelector('.hexinput'); if (hexIn && document.activeElement !== hexIn) hexIn.value = t.value; }
  const stopRow = t.closest('.grad-stop');
  if (stopRow){ const hexIn = stopRow.querySelector('.hexinput'); if (hexIn && document.activeElement !== hexIn) hexIn.value = t.value; }
}
/* Repaints the editor's ramp bar and the small per-stop swatches in place. Rebuilding the
   panel here instead would drop focus mid-drag, which is exactly when you least want it. */
function refreshGradientPreviewIfNeeded(field){
  const gf = parseGradientField(field);
  if (!gf && field !== 'fillPaintMode' && field !== 'strokePaintMode') return;
  const shapes = selectedShapes();
  if (shapes.length !== 1) return;
  const kind = gf ? gf.kind : (field === 'strokePaintMode' ? 'stroke' : 'fill');
  const gradient = activeGradient(shapes[0], kind);
  if (!gradient) return;
  const sectionId = kind === 'stroke' ? 'sec-stroke' : 'sec-fill';
  const section = document.getElementById(sectionId);
  if (!section) return;
  const bar = section.querySelector('.grad-preview');
  if (bar) bar.style.setProperty('--ramp', gradientCssPreview(gradient));
  section.querySelectorAll('.grad-stop').forEach((row, i) => {
    const stop = gradient.stops[i];
    const dot = row.querySelector('.grad-stop-swatch i');
    if (stop && dot) dot.style.background = rgbaCss(stop.color, stop.opacity);
  });
  // The angle/radius readouts sit outside .field label handling, so refresh them here.
  const readout = (selector, text) => { const el = section.querySelector(selector); if (el) el.textContent = text; };
  if (gf && gf.prop === 'Angle') readout('.grad-readout', fmt(gradient.angle) + '°');
  if (gf && gf.prop === 'Radius') readout('.grad-readout', Math.round(gradient.radius * 100) + '%');
}
function onSelectionPanelsInput(e){
  const t = e.target;
  const field = t.dataset.field;
  if (!field || t.classList.contains('hexinput')) return;
  beginEdit();
  applyFieldChange(field, t);
  if (TEXT_ASYNC_FIELDS.has(field)){
    scheduleTextRegenPreview();
  } else {
    renderStage();
  }
  updateRangeLabelIfNeeded(t);
  updateSwatchPreviewIfNeeded(t);
  refreshGradientPreviewIfNeeded(field);
}
function onSelectionPanelsChange(e){
  const t = e.target;
  const field = t.dataset.field;
  if (!field) return;
  // perCornerRadius is a UI-only toggle — not a real shape field
  if (field === 'perCornerRadius'){
    beginEdit();
    for (const s of selectedShapes()){
      if (s.type !== 'rect') continue;
      if (t.checked){
        // Expand: copy uniform radius to all four corners
        s.radiusTL = s.radius;
        s.radiusTR = s.radius;
        s.radiusBR = s.radius;
        s.radiusBL = s.radius;
      } else {
        // Collapse: use TL value (or existing uniform) as new uniform radius
        const keep = s.radiusTL != null ? s.radiusTL : s.radius;
        s.radius = keep;
        s.radiusTL = null;
        s.radiusTR = null;
        s.radiusBR = null;
        s.radiusBL = null;
      }
    }
    commitEdit();
    renderAll();
    return;
  }
  if (TEXT_ASYNC_FIELDS.has(field)){
    beginEdit();
    const ok = applyFieldChange(field, t);
    if (ok === false){ __historySnapshotBeforeEdit = null; renderPropertiesPanel(); showToast('Invalid value'); return; }
    commitTextShapeEdits();
    return;
  }
  beginEdit();
  const ok = applyFieldChange(field, t);
  if (ok === false){ __historySnapshotBeforeEdit = null; renderPropertiesPanel(); showToast('Invalid hex color'); return; }
  const gf = parseGradientField(field);
  // Offsets are only re-sorted once the value is committed — doing it on every keystroke
  // would reorder the rows while the pointer is still on one of them.
  if (gf && gf.prop === 'StopOffset') sortGradientStopsForSelection();
  commitEdit();
  renderAll();
  if (gf && gf.prop === 'StopOffset') renderPropertiesPanel();
}
/* Segmented fields that change which controls exist, not just a value — switching paint
   mode or gradient style has to rebuild the panel or the new controls never appear. */
const PANEL_REBUILDING_FIELDS = new Set(['fillPaintMode', 'strokePaintMode', 'fillGradType', 'strokeGradType']);
function onSelectionPanelsClick(e){
  // Gradient buttons carry data-value too, so they're matched before the generic
  // segmented-control branch would swallow them.
  const gradBtn = e.target.closest('[data-grad-action]');
  if (gradBtn){
    if (gradBtn.disabled) return;
    handleGradientAction(gradBtn);
    return;
  }
  const segBtn = e.target.closest('[data-field][data-value]');
  if (segBtn){
    const field = segBtn.dataset.field, value = segBtn.dataset.value;
    if (TEXT_ASYNC_FIELDS.has(field)){
      beginEdit();
      for (const s of selectedShapes()) applySegmentedField(s, field, value);
      commitTextShapeEdits();
      return;
    }
    doAction(() => { for (const s of selectedShapes()) applySegmentedField(s, field, value); });
    if (PANEL_REBUILDING_FIELDS.has(field)) renderPropertiesPanel();
    return;
  }
  const actBtn = e.target.closest('[data-action]');
  if (actBtn){
    if (actBtn.dataset.action === 'openFontBrowser'){ openFontBrowserForSelection(); return; }
    handlePropertiesAction(actBtn.dataset.action);
    return;
  }
}


/* =====================================================================================
   Part 7: layers panel
   ===================================================================================== */
function eyeIcon(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'; }
function eyeOffIcon(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.6 21.6 0 0 1 5.06-6.06M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.6 21.6 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>'; }
function lockIcon(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'; }
function unlockIcon(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>'; }
function shapeTypeIcon(type){
  const icons = {
    rect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/></svg>',
    ellipse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/></svg>',
    polygon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 9l4 12h12l4-12z"/></svg>',
    line: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="19" x2="19" y2="5"/></svg>',
    path: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 19 6-14 4 10 4-6"/></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16"/><path d="M12 6v14"/><path d="M9 20h6"/></svg>',
  };
  return icons[type] || icons.path;
}
function folderIcon(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'; }
function chevronDownIcon(){ return '<svg class="grp-toggle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'; }
function unlinkIcon(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="8" y1="12" x2="16" y2="12"/></svg>'; }
function addToGroupIcon(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18M12 3v18"/><path d="M4 21h16"/></svg>'; }

function buildLayerItemHtml(shape){
  return `
    <span class="drag-handle" data-tip="Drag to reorder">⠿</span>
    <span class="type-ic">${shapeTypeIcon(shape.type)}</span>
    <input class="lname" data-id="${shape.id}" value="${escapeHtml(shape.name)}" spellcheck="false">
    ${!shapeHasFillOrStroke(shape) ? '<svg class="warn-badge" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-tip="No stroke and no fill"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>' : ''}
    ${shape.groupId ? '<button class="micro-btn" data-act="remove" data-tip="Remove from group">' + unlinkIcon() + '</button>' : ''}
    <button class="micro-btn" data-act="vis" data-tip="${shape.visible ? 'Hide layer' : 'Show layer'}">${shape.visible ? eyeIcon() : eyeOffIcon()}</button>
    <button class="micro-btn ${shape.locked ? 'active-flag' : ''}" data-act="lock" data-tip="${shape.locked ? 'Unlock layer' : 'Lock layer'}">${shape.locked ? lockIcon() : unlockIcon()}</button>
  `;
}

function renderLayers(){
  if (!state.groups) state.groups = {};
  const list = DOM.layerList;
  list.innerHTML = '';
  const shapesTopFirst = state.shapes.slice().reverse();
  const processedGroupIds = new Set();

  for (const shape of shapesTopFirst){
    if (shape.groupId){
      if (processedGroupIds.has(shape.groupId)) continue;
      processedGroupIds.add(shape.groupId);
      const gId = shape.groupId;
      if (!state.groups[gId]) state.groups[gId] = { id: gId, name: 'Group', expanded: true };
      const grp = state.groups[gId];
      const groupShapes = state.shapes.filter(s => s.groupId === gId);
      const allSelected = groupShapes.every(s => state.selectedIds.includes(s.id));
      const allVisible = groupShapes.every(s => s.visible);
      const anyLocked = groupShapes.some(s => s.locked);

      const card = document.createElement('div');
      card.className = 'layer-group-card' + (grp.expanded !== false ? '' : ' collapsed');
      card.dataset.gid = gId;

      const head = document.createElement('div');
      head.className = 'layer-group-head' + (allSelected ? ' selected' : '');
      head.dataset.gid = gId;
      head.innerHTML = `
        ${chevronDownIcon()}
        <span class="grp-ic">${folderIcon()}</span>
        <input type="text" class="gname" data-gid="${gId}" value="${escapeHtml(grp.name || 'Group')}" spellcheck="false">
        <button class="micro-btn" data-act="gadd" data-gid="${gId}" data-tip="Add selected vectors to group">${addToGroupIcon()}</button>
        <button class="micro-btn" data-act="gvis" data-gid="${gId}" data-tip="${allVisible ? 'Hide group' : 'Show group'}">${allVisible ? eyeIcon() : eyeOffIcon()}</button>
        <button class="micro-btn ${anyLocked ? 'active-flag' : ''}" data-act="glock" data-gid="${gId}" data-tip="${anyLocked ? 'Unlock group' : 'Lock group'}">${anyLocked ? lockIcon() : unlockIcon()}</button>
        <button class="micro-btn" data-act="gungroup" data-gid="${gId}" data-tip="Ungroup (Ctrl+Shift+G)">${unlinkIcon()}</button>
      `;

      const itemsContainer = document.createElement('div');
      itemsContainer.className = 'layer-group-items';

      const memberShapes = groupShapes.slice().reverse();
      for (const mShape of memberShapes){
        const li = document.createElement('li');
        li.className = 'layer-item' + (state.selectedIds.includes(mShape.id) ? ' selected' : '');
        li.dataset.id = mShape.id;
        li.innerHTML = buildLayerItemHtml(mShape);
        itemsContainer.appendChild(li);
      }

      card.append(head, itemsContainer);
      list.appendChild(card);
    } else {
      const li = document.createElement('li');
      li.className = 'layer-item' + (state.selectedIds.includes(shape.id) ? ' selected' : '');
      li.dataset.id = shape.id;
      li.innerHTML = buildLayerItemHtml(shape);
      list.appendChild(li);
    }
  }

  DOM.layerCount.textContent = state.shapes.length + ' layer' + (state.shapes.length === 1 ? '' : 's');
  DOM.layerTabBadge.textContent = state.shapes.length;
}

let __layerDragActive = false;
/* Pointer-based reorder for the layers list — mirrors onGradStopHandlePointerDown, and
   for the same reason: this page's window-level dragover/drop listener (for importing an
   SVG or JSON file dropped anywhere on the canvas) forces dropEffect to 'copy' on every
   drag it sees, which fights with a reorder drag's effectAllowed of 'move' and can make
   native HTML5 drag-and-drop silently refuse the drop.
   Rows can be nested two levels deep — a plain top-level <li>, or an <li> inside a
   group's own item list — so hit-testing gathers every .layer-item in the whole list
   rather than scoping to one parent the way the gradient stop version does. Dragging
   across group boundaries is intentionally allowed, matching the list's existing
   behavior: this only reorders z-stacking, which is a separate concern from group
   membership (that's what Group/Ungroup are for). Rows inside a collapsed group are
   display:none and filtered out via offsetParent, the same way they were naturally
   unreachable to a real pointer under the old native-drag version. */
function onLayerHandlePointerDown(e){
  if (e.button != null && e.button !== 0) return;
  const handle = e.target.closest('.drag-handle');
  const row = handle && handle.closest('.layer-item');
  if (!row || __layerDragActive) return;
  e.preventDefault();
  __layerDragActive = true;
  const rows = Array.from(DOM.layerList.querySelectorAll('.layer-item')).filter(el => el.offsetParent !== null);
  const fromIndex = rows.indexOf(row);
  const dragSrcId = row.dataset.id;
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
    __layerDragActive = false;
    if (hoverIndex !== fromIndex && fromIndex !== -1){
      const targetId = rows[hoverIndex].dataset.id;
      doAction(() => {
        const idx = shapeIndex(targetId);
        reorderShapeTo(dragSrcId, state.shapes[idx+1] ? state.shapes[idx+1].id : null);
      });
    }
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}
function wireLayerList(){
  DOM.layerList.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('.grp-toggle');
    const groupHead = e.target.closest('.layer-group-head');
    const microBtn = e.target.closest('.micro-btn');
    const li = e.target.closest('.layer-item');

    if (toggleBtn || (groupHead && e.target.classList.contains('grp-toggle'))){
      const card = e.target.closest('.layer-group-card');
      if (card){
        const gId = card.dataset.gid;
        if (state.groups[gId]){
          state.groups[gId].expanded = !state.groups[gId].expanded;
          card.classList.toggle('collapsed', !state.groups[gId].expanded);
          state.dirty = true;
          scheduleAutosave();
        }
      }
      return;
    }

    if (microBtn){
      const act = microBtn.dataset.act;
      const gId = microBtn.dataset.gid;
      if (act === 'gadd'){
        addSelectionToGroup(gId);
        return;
      }
      if (act === 'gvis'){
        doAction(() => {
          const gShapes = state.shapes.filter(s => s.groupId === gId);
          const allVis = gShapes.every(s => s.visible);
          for (const s of gShapes) s.visible = !allVis;
        });
        return;
      }
      if (act === 'glock'){
        doAction(() => {
          const gShapes = state.shapes.filter(s => s.groupId === gId);
          const anyLock = gShapes.some(s => s.locked);
          for (const s of gShapes) s.locked = !anyLock;
        });
        return;
      }
      if (act === 'gungroup'){
        doAction(() => {
          for (const s of state.shapes) if (s.groupId === gId) s.groupId = null;
          delete state.groups[gId];
        });
        return;
      }
    }

    if (groupHead && !e.target.classList.contains('gname')){
      const gId = groupHead.dataset.gid;
      const gShapes = state.shapes.filter(s => s.groupId === gId && !s.locked);
      if (gShapes.length){
        state.selectedIds = gShapes.map(s => s.id);
        renderAll();
      }
      return;
    }

    if (!li) return;
    const id = li.dataset.id;
    if (microBtn){
      const act = microBtn.dataset.act;
      if (act === 'remove'){
        removeShapeFromGroup(id);
        return;
      }
      doAction(() => {
        const s = findShapeById(id);
        if (!s) return;
        if (act === 'vis') s.visible = !s.visible;
        else if (act === 'lock') s.locked = !s.locked;
      });
      return;
    }
    if (e.target.classList.contains('lname')) return;
    if (e.shiftKey) toggleSelectId(id); else selectOnly(id);
    renderAll();
  });

  DOM.layerList.addEventListener('change', (e) => {
    if (e.target.classList.contains('lname')){
      const id = e.target.dataset.id;
      doAction(() => { const s = findShapeById(id); if (s) s.name = e.target.value.trim() || s.name; });
    }
    if (e.target.classList.contains('gname')){
      const gId = e.target.dataset.gid;
      if (state.groups[gId]){
        const nextName = e.target.value.trim() || 'Group';
        if (state.groups[gId].name !== nextName){
          doAction(() => { state.groups[gId].name = nextName; });
        }
      }
    }
  });

  DOM.layerList.addEventListener('pointerdown', onLayerHandlePointerDown);

  const btnGrp = document.getElementById('btnLayerGroup');
  const btnUngrp = document.getElementById('btnLayerUngroup');
  if (btnGrp) btnGrp.addEventListener('click', groupSelectedShapes);
  if (btnUngrp) btnUngrp.addEventListener('click', ungroupSelectedShapes);
  document.getElementById('btnLayerDup').addEventListener('click', duplicateSelectionAction);
  document.getElementById('btnLayerDel').addEventListener('click', () => { if (state.selectedIds.length) doAction(() => deleteShapesByIds(state.selectedIds)); });
}

