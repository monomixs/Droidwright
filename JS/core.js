'use strict';
/* =====================================================================================
   DROIDWRIGHT — Android Vector Icon Editor
   Part 1: constants, math/geometry utils, state, shape factories, path-data generation
   ===================================================================================== */

const NS_SVG = 'http://www.w3.org/2000/svg';
const KAPPA = 0.5522847498307936;         // 4-bezier circle approximation constant
const PX_PER_UNIT = 20;                    // on-screen px per viewport unit at zoom = 1
const CANVAS_BLEED_RATIO = 15;             // extra working room around the artboard (as a fraction of its size) where shapes can be drawn/moved but will be cropped out of the final icon and XML. Kept large so there's effectively open room to park/build shapes far from the artboard — increase further if you still hit the edge while panning.
const MIN_ZOOM = 0.01, MAX_ZOOM = 48;

function clamp(v, min, max){ return Math.min(max, Math.max(min, v)); }
function lerp(a,b,t){ return a+(b-a)*t; }
function fmt(n){
  if (n == null || !isFinite(n)) return '0';
  let r = Math.round(n * 1000) / 1000;
  if (Object.is(r, -0)) r = 0;
  return String(r);
}
function fmtAttr(n){ // for numeric attrs that allow more casual rounding (2 decimals)
  if (n == null || !isFinite(n)) return '0';
  let r = Math.round(n * 100) / 100;
  if (Object.is(r,-0)) r = 0;
  return String(r);
}
let __nextId = 1;
function uid(prefix){ return prefix + (__nextId++); }
function escapeXml(s){
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escapeHtml(s){
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function sanitizeResourceName(s){
  let out = String(s||'').trim().toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'');
  if (!out) out = 'ic_icon';
  if (/^[0-9]/.test(out)) out = 'ic_' + out;
  return out;
}
function deepClone(o){ return JSON.parse(JSON.stringify(o)); }

/* ---------------- SVG element helper ---------------- */
function svgEl(tag, attrs){
  const e = document.createElementNS(NS_SVG, tag);
  if (attrs) for (const k in attrs){ if (attrs[k] != null) e.setAttribute(k, attrs[k]); }
  return e;
}
/* Diamond-shaped handle used for Bézier control points, so they're visually distinct
   from round anchor/endpoint handles at a glance. Built as a plain <polygon> (not a
   rotated <rect>) so there's no SVG-attribute-transform vs CSS-transform conflict —
   mixing those on hover/transition is what causes handles to jump around. */
function svgDiamondHandle(cx, cy, size, attrs){
  const pts = [
    `${fmt(cx)},${fmt(cy - size)}`,
    `${fmt(cx + size)},${fmt(cy)}`,
    `${fmt(cx)},${fmt(cy + size)}`,
    `${fmt(cx - size)},${fmt(cy)}`,
  ].join(' ');
  const merged = Object.assign({
    points: pts,
    fill: '#6FA8FF',
    stroke: '#12141C',
    'stroke-width': 1.5,
  }, attrs || {});
  return svgEl('polygon', merged);
}

/* ---------------- hidden measurement svg (for getBBox of arbitrary path data) ---------------- */
let __hiddenSvg = null, __hiddenPath = null;
function ensureHiddenMeasureSvg(){
  if (__hiddenSvg) return;
  __hiddenSvg = svgEl('svg', {width: 10, height: 10});
  __hiddenSvg.style.cssText = 'position:absolute;left:-99999px;top:-99999px;visibility:hidden;';
  __hiddenPath = svgEl('path');
  __hiddenSvg.appendChild(__hiddenPath);
  document.body.appendChild(__hiddenSvg);
}
function measurePathBBox(d){
  ensureHiddenMeasureSvg();
  try{
    __hiddenPath.setAttribute('d', d || 'M0,0');
    const b = __hiddenPath.getBBox();
    if (!b || !isFinite(b.x) || !isFinite(b.y) || !isFinite(b.width) || !isFinite(b.height)){
      return {x:0,y:0,width:0,height:0};
    }
    return {x:b.x, y:b.y, width:b.width, height:b.height};
  }catch(err){
    return {x:0,y:0,width:0,height:0};
  }
}

/* =====================================================================================
   2x2 affine matrix — used for parsing/composing <transform="..."> during SVG import
   ===================================================================================== */
class Mat2D{
  constructor(a=1,b=0,c=0,d=1,e=0,f=0){ this.a=a;this.b=b;this.c=c;this.d=d;this.e=e;this.f=f; }
  static identity(){ return new Mat2D(); }
  clone(){ return new Mat2D(this.a,this.b,this.c,this.d,this.e,this.f); }
  multiply(m){
    // this = this * m  (apply m first, then this — matches SVG transform-list left-to-right composition)
    return new Mat2D(
      this.a*m.a + this.c*m.b,
      this.b*m.a + this.d*m.b,
      this.a*m.c + this.c*m.d,
      this.b*m.c + this.d*m.d,
      this.a*m.e + this.c*m.f + this.e,
      this.b*m.e + this.d*m.f + this.f
    );
  }
  transformPoint(x,y){
    return { x: this.a*x + this.c*y + this.e, y: this.b*x + this.d*y + this.f };
  }
  static translate(tx,ty){ return new Mat2D(1,0,0,1,tx,ty); }
  static scale(sx,sy){ return new Mat2D(sx,0,0,(sy==null?sx:sy),0,0); }
  static rotateDeg(deg,cx,cy){
    const r = deg*Math.PI/180, cos=Math.cos(r), sin=Math.sin(r);
    let m = new Mat2D(cos,sin,-sin,cos,0,0);
    if (cx || cy){
      m = Mat2D.translate(cx||0,cy||0).multiply(m).multiply(Mat2D.translate(-(cx||0),-(cy||0)));
    }
    return m;
  }
  static skewXDeg(deg){ return new Mat2D(1,0,Math.tan(deg*Math.PI/180),1,0,0); }
  static skewYDeg(deg){ return new Mat2D(1,Math.tan(deg*Math.PI/180),0,1,0,0); }
  // Decompose the LINEAR part (a,b,c,d) into rotation (deg) + scaleX + scaleY via Gram-Schmidt.
  decomposeLinear(){
    let { a,b,c,d } = this;
    let scaleX = Math.hypot(a,b);
    if (scaleX < 1e-12) scaleX = 1e-12;
    let ux = a/scaleX, uy = b/scaleX;               // unit vector for column 1
    let shearDot = c*ux + d*uy;                       // projection of column2 onto column1 dir
    let ox = c - shearDot*ux, oy = d - shearDot*uy;    // orthogonal remainder
    let scaleY = Math.hypot(ox,oy);
    if (scaleY < 1e-12) scaleY = 1e-12;
    const det = a*d - b*c;
    if (det < 0) scaleY = -scaleY;                     // reflection -> encode as negative scaleY
    const rotation = Math.atan2(uy,ux) * 180/Math.PI;
    return { rotation, scaleX, scaleY };
  }
}
function parseTransformAttr(str){
  let m = Mat2D.identity();
  if (!str) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(str))){
    const fn = match[1];
    const nums = match[2].trim().split(/[\s,]+/).filter(s=>s.length).map(Number);
    let part = Mat2D.identity();
    if (fn === 'matrix' && nums.length===6){ part = new Mat2D(nums[0],nums[1],nums[2],nums[3],nums[4],nums[5]); }
    else if (fn === 'translate'){ part = Mat2D.translate(nums[0]||0, nums[1]||0); }
    else if (fn === 'scale'){ part = Mat2D.scale(nums[0]||1, nums.length>1?nums[1]:nums[0]); }
    else if (fn === 'rotate'){ part = Mat2D.rotateDeg(nums[0]||0, nums[1], nums[2]); }
    else if (fn === 'skewX'){ part = Mat2D.skewXDeg(nums[0]||0); }
    else if (fn === 'skewY'){ part = Mat2D.skewYDeg(nums[0]||0); }
    m = m.multiply(part);
  }
  return m;
}


/* =====================================================================================
   Part 2: application state, DOM refs, coordinate conversion, stage layout
   ===================================================================================== */
const state = {
  projectId: null,
  projectName: '',
  dirty: false,
  doc: {
    name: 'ic_custom_icon',
    width: 24, height: 24,
    viewportWidth: 24, viewportHeight: 24,
    linkSize: true,
    tint: '',
    alpha: 1,
    autoMirrored: false,
    backgroundColor: '#1E222B',
    backgroundEnabled: false,
    backgroundOpacity: 1,
    includeBackgroundInExport: true,
  },
  shapes: [],           // bottom -> top (document / paint order)
  groups: {},           // groupId -> { id, name, expanded }
  selectedIds: [],
  tool: 'select',
  nodeEdit: { shapeId: null, selectedNodeIdx: null, activeHandle: null, subpathIdx: 0 },
  arcDraft: null,
  arcHoverPoint: null,
  curveDraft: null,
  curveHoverPoint: null,
  lineDraft: null,
  lineHoverPoint: null,
  cutActive: false,
  cutPoints: [],
  cutPreview: null,
  hoveredShapeId: null,
  // True while Ctrl/Cmd is held, so hovering/clicking/dragging a grouped shape targets
  // just that one shape instead of the whole group (see stagePointerDown and
  // updateHoverOutline). Tracked globally via keydown/keyup rather than read off each
  // event, so the hover ring updates immediately if Ctrl is pressed/released without
  // the mouse moving.
  editIndividualHeld: false,
  reference: {
    visible: false,
    src: null,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    rotation: 0,
    picking: false,
  },
  view: { zoom: 1, panX: 0, panY: 0 },
  grid: { show: true, keyline: true, snap: false, snapSize: 1, guides: true },
  history: { past: [], future: [], limit: 100 },
  drag: null,
  penPoints: [],
  penClosePreview: false,
  spaceHeld: false,
  clipboard: null,
};

const DOM = {};
function cacheDom(){
  DOM.stage = document.getElementById('stage-svg');
  DOM.canvasScroll = document.getElementById('canvas-scroll');
  DOM.canvasArea = document.getElementById('canvas-area');
  DOM.rail = document.getElementById('rail');
  DOM.zoomReadout = document.getElementById('zoomReadout');
  DOM.viewportReadout = document.getElementById('viewportReadout');
  DOM.selectionPanels = document.getElementById('selectionPanels');
  DOM.secNoSelect = document.getElementById('sec-noselect');
  DOM.layerList = document.getElementById('layerlist');
  DOM.layerCount = document.getElementById('layercount');
  DOM.layerTabBadge = document.getElementById('layerTabBadge');
  DOM.xmlout = document.getElementById('xmlout');
  DOM.xmlHighlight = document.getElementById('xml-highlight');
  DOM.xmlLines = document.getElementById('xml-lines');
  DOM.previewStrip = document.getElementById('preview-strip');
  DOM.docNameInput = document.getElementById('docNameInput');
  DOM.btnHome = document.getElementById('btnHome');
  DOM.btnUndo = document.getElementById('btnUndo');
  DOM.btnRedo = document.getElementById('btnRedo');
  DOM.toast = document.getElementById('toast');
  DOM.toastMsg = document.getElementById('toastMsg');
  DOM.modalBackdrop = document.getElementById('modalBackdrop');
  DOM.modalTitle = document.getElementById('modalTitle');
  DOM.modalBody = document.getElementById('modalBody');
  DOM.modalFoot = document.getElementById('modalFoot');
  DOM.homeScreen = document.getElementById('home-screen');
  DOM.projectGrid = document.getElementById('project-grid');
  DOM.homeProjectCount = document.getElementById('homeProjectCount');
  DOM.homeGroupSelected = document.getElementById('homeGroupSelected');
  DOM.homeSelectionCount = document.getElementById('homeSelectionCount');
  DOM.homeImportProject = document.getElementById('homeImportProject');
  DOM.homeNewProject = document.getElementById('homeNewProject');
  DOM.homeInfoBtn = document.getElementById('homeInfoBtn');
  DOM.homeChangelogBtn = document.getElementById('homeChangelogBtn');
  DOM.mobileBlockOverlay = document.getElementById('mobileBlockOverlay');
  DOM.referencePanel = document.getElementById('referencePanel');
  DOM.chkReference = document.getElementById('chkReference');
  DOM.homeSearchInput = document.getElementById('homeSearchInput');
  DOM.homeSort = document.getElementById('homeSort');
  DOM.homeToolbar = document.getElementById('homeToolbar');
  DOM.homeEmpty = document.getElementById('home-empty');
  DOM.homeNoResults = document.getElementById('home-no-results');
  DOM.homeNoResultsQuery = document.getElementById('homeNoResultsQuery');
  DOM.homeClearSearch = document.getElementById('homeClearSearch');
  DOM.emptyNewProject = document.getElementById('emptyNewProject');
  DOM.emptyImportProject = document.getElementById('emptyImportProject');
  DOM.statIcons = document.getElementById('statIcons');
  DOM.statLayers = document.getElementById('statLayers');
  DOM.statStorage = document.getElementById('statStorage');
  DOM.statSaved = document.getElementById('statSaved');
  DOM.rightpanel = document.getElementById('rightpanel');
  DOM.panelResizeHandle = document.getElementById('panel-resize-handle');
}

/* persistent SVG layer groups (built once, contents rebuilt each render) */
let gArtboard, gGrid, gShapes, gHoverOutline, gOverlay;
function buildStageSkeleton(){
  DOM.stage.innerHTML = '';
  const defs = svgEl('defs');
  const pattern = svgEl('pattern', { id:'checkerPattern', width:2, height:2, patternUnits:'userSpaceOnUse' });
  pattern.appendChild(svgEl('rect', { width:2, height:2, fill:'var(--stage-check-a)' }));
  pattern.appendChild(svgEl('rect', { width:1, height:1, fill:'var(--stage-check-b)' }));
  pattern.appendChild(svgEl('rect', { x:1, y:1, width:1, height:1, fill:'var(--stage-check-b)' }));
  defs.appendChild(pattern);
  DOM.stage.appendChild(defs);
  gArtboard = svgEl('g', { id:'artboardLayer' });
  gGrid = svgEl('g', { id:'gridLayer' });
  gShapes = svgEl('g', { id:'shapesLayer' });
  gHoverOutline = svgEl('g', { id:'hoverOutlineLayer', 'pointer-events':'none' });
  gOverlay = svgEl('g', { id:'overlayLayer' });
  DOM.stage.appendChild(gArtboard);
  DOM.stage.appendChild(gGrid);
  DOM.stage.appendChild(gShapes);
  DOM.stage.appendChild(gHoverOutline);
  DOM.stage.appendChild(gOverlay);
}

/* ---------------- coordinate conversion (leans on native SVG matrix math) ---------------- */
function clientToStagePoint(clientX, clientY){
  const pt = DOM.stage.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  const ctm = DOM.stage.getScreenCTM();
  if (!ctm) return { x:0, y:0 };
  const local = pt.matrixTransform(ctm.inverse());
  return { x: local.x, y: local.y };
}
function stageToClientPoint(x, y){
  const pt = DOM.stage.createSVGPoint();
  pt.x = x; pt.y = y;
  const ctm = DOM.stage.getScreenCTM();
  if (!ctm) return { x:0, y:0 };
  const p = pt.matrixTransform(ctm);
  return { x: p.x, y: p.y };
}
function clientToLocalPoint(el, clientX, clientY){
  const pt = DOM.stage.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  const ctm = el.getScreenCTM();
  if (!ctm) return { x:0, y:0 };
  const local = pt.matrixTransform(ctm.inverse());
  return { x: local.x, y: local.y };
}

function layoutStage(){
  const d = state.doc;
  const z = state.view.zoom;
  const bleedX = d.viewportWidth * CANVAS_BLEED_RATIO;
  const bleedY = d.viewportHeight * CANVAS_BLEED_RATIO;
  const totalW = d.viewportWidth + bleedX * 2;
  const totalH = d.viewportHeight + bleedY * 2;
  const w = totalW * PX_PER_UNIT * z;
  const h = totalH * PX_PER_UNIT * z;
  DOM.stage.setAttribute('viewBox', `${fmt(-bleedX)} ${fmt(-bleedY)} ${fmt(totalW)} ${fmt(totalH)}`);
  DOM.stage.setAttribute('width', w);
  DOM.stage.setAttribute('height', h);
  DOM.stage.style.left = state.view.panX + 'px';
  DOM.stage.style.top = state.view.panY + 'px';
  DOM.zoomReadout.textContent = Math.round(z*100) + '%';
  DOM.viewportReadout.textContent = `${fmtAttr(d.viewportWidth)} × ${fmtAttr(d.viewportHeight)} viewport · ${fmtAttr(d.width)} × ${fmtAttr(d.height)} dp`;
}

function centerStage(){
  const rect = DOM.canvasScroll.getBoundingClientRect();
  const d = state.doc;
  const w = d.viewportWidth * PX_PER_UNIT * state.view.zoom;
  const h = d.viewportHeight * PX_PER_UNIT * state.view.zoom;
  const bleedXPx = d.viewportWidth * CANVAS_BLEED_RATIO * PX_PER_UNIT * state.view.zoom;
  const bleedYPx = d.viewportHeight * CANVAS_BLEED_RATIO * PX_PER_UNIT * state.view.zoom;
  // Center the TRUE artboard, not the larger bled stage element around it — the stage's
  // own top-left corner sits `bleed` pixels above/left of the artboard's real origin.
  state.view.panX = Math.round((rect.width - w) / 2) - bleedXPx;
  state.view.panY = Math.round((rect.height - h) / 2) - bleedYPx;
}

function fitZoom(){
  const rect = DOM.canvasScroll.getBoundingClientRect();
  const d = state.doc;
  if (rect.width < 10 || rect.height < 10) return;
  const availW = Math.max(60, rect.width - 90);
  const availH = Math.max(60, rect.height - 90);
  const z = clamp(Math.min(availW/(d.viewportWidth*PX_PER_UNIT), availH/(d.viewportHeight*PX_PER_UNIT)), MIN_ZOOM, MAX_ZOOM);
  state.view.zoom = z;
  centerStage();
  layoutStage();
  if (state.selectedIds.length && gOverlay) renderSelectionOverlay();
  if (state.hoveredShapeId) updateHoverOutline(state.hoveredShapeId);
}

function applyZoomAt(newZoom, clientX, clientY){
  newZoom = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);
  const rect = DOM.canvasScroll.getBoundingClientRect();
  if (clientX == null) clientX = rect.left + rect.width/2;
  if (clientY == null) clientY = rect.top + rect.height/2;
  const before = clientToStagePoint(clientX, clientY);
  state.view.zoom = newZoom;
  layoutStage();
  const after = stageToClientPoint(before.x, before.y);
  state.view.panX += (clientX - after.x);
  state.view.panY += (clientY - after.y);
  layoutStage();
  // Re-render selection overlay so handle sizes update instantly at the new zoom
  if (state.selectedIds.length && gOverlay) renderSelectionOverlay();
  // Same for the hover outline — its margin is computed in on-screen pixels, so it
  // needs to be recalculated at the new zoom too, not just left at its old size.
  if (state.hoveredShapeId) updateHoverOutline(state.hoveredShapeId);
}

function maybeSnap(v){
  if (!state.grid.snap) return v;
  const s = state.grid.snapSize || 1;
  return Math.round(v / s) * s;
}

