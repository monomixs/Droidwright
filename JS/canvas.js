/* =====================================================================================
   Part 3: rendering — artboard/grid, shapes, selection overlay
   ===================================================================================== */
function findShapeById(id){ return state.shapes.find(s => s.id === id) || null; }
function selectedShapes(){ return state.selectedIds.map(findShapeById).filter(Boolean); }
function shapeIndex(id){ return state.shapes.findIndex(s => s.id === id); }

/* ---------------- gradient paint servers ----------------
   IDs have to be unique across every SVG on the page at once: the stage, the preview
   strip's ten swatches, the export popover and every home-screen card can all be showing
   the same shape simultaneously, and duplicate IDs would make them all resolve to
   whichever definition happened to render last. */
let __paintServerSeq = 0;
function nextPaintServerId(prefix){ return `${prefix}-${(__paintServerSeq++).toString(36)}-${Math.random().toString(36).slice(2,7)}`; }

function appendGradientStops(el, gradient){
  for (const stop of gradient.stops){
    el.appendChild(svgEl('stop', {
      offset: fmt(clamp(stop.offset, 0, 1)),
      'stop-color': stop.color,
      'stop-opacity': fmt(clamp(stop.opacity == null ? 1 : stop.opacity, 0, 1)),
    }));
  }
}
/* SVG has no conic paint server, so a sweep is drawn as a fan of wedges inside a
   <pattern> whose tile is exactly the shape's bounding box. Wrapping it in a pattern
   (rather than painting wedges into the shape group) keeps the caller's contract simple:
   every gradient type still resolves to a plain `url(#id)` paint string, so fills,
   strokes, clipping and PNG export all keep working unchanged. */
function buildSweepPattern(gradient, bbox, id){
  const pad = Math.max(bbox.width, bbox.height) * 0.02 + 0.01;
  const x = bbox.x - pad, y = bbox.y - pad;
  const w = bbox.width + pad*2, h = bbox.height + pad*2;
  const pattern = svgEl('pattern', { id, patternUnits:'userSpaceOnUse', x:fmt(x), y:fmt(y), width:fmt(w), height:fmt(h) });
  const cx = bbox.x + gradient.cx * bbox.width;
  const cy = bbox.y + gradient.cy * bbox.height;
  // Reach past the farthest corner so no part of the tile is left unpainted.
  const reach = Math.hypot(w, h) * 1.1;
  const group = svgEl('g');
  group.appendChild(svgEl('rect', { x:fmt(x), y:fmt(y), width:fmt(w), height:fmt(h), fill:gradient.stops[0].color, 'fill-opacity':fmt(gradient.stops[0].opacity) }));
  const SEGMENTS = 96;
  const start = (Number(gradient.angle) || 0) * Math.PI / 180;
  for (let i = 0; i < SEGMENTS; i++){
    const t0 = i / SEGMENTS, t1 = (i + 1) / SEGMENTS;
    const a0 = start + t0 * Math.PI * 2;
    // Overlap neighbours very slightly; without it, antialiasing leaves hairline seams.
    const a1 = start + t1 * Math.PI * 2 + 0.004;
    const sample = sampleGradientColor(gradient, (t0 + t1) / 2);
    const p1x = cx + Math.cos(a0) * reach, p1y = cy + Math.sin(a0) * reach;
    const p2x = cx + Math.cos(a1) * reach, p2y = cy + Math.sin(a1) * reach;
    group.appendChild(svgEl('path', {
      d: `M${fmt(cx)},${fmt(cy)} L${fmt(p1x)},${fmt(p1y)} L${fmt(p2x)},${fmt(p2y)} Z`,
      fill: sample.color,
      'fill-opacity': fmt(sample.opacity),
      'shape-rendering': 'crispEdges',
    }));
  }
  pattern.appendChild(group);
  return pattern;
}
function buildGradientPaintServer(gradient, bbox, id){
  const geo = gradientUserGeometry(gradient, bbox);
  const spread = TILE_TO_SPREAD[gradient.tileMode] || 'pad';
  if (gradient.type === 'sweep') return buildSweepPattern(gradient, bbox, id);
  if (gradient.type === 'radial'){
    const el = svgEl('radialGradient', {
      id, gradientUnits:'userSpaceOnUse', spreadMethod:spread,
      cx: fmt(geo.centerX), cy: fmt(geo.centerY), r: fmt(geo.radius),
    });
    appendGradientStops(el, gradient);
    return el;
  }
  const el = svgEl('linearGradient', {
    id, gradientUnits:'userSpaceOnUse', spreadMethod:spread,
    x1: fmt(geo.startX), y1: fmt(geo.startY), x2: fmt(geo.endX), y2: fmt(geo.endY),
  });
  appendGradientStops(el, gradient);
  return el;
}
/* Returns the paint string for one channel, registering a paint server in `defsEl` when
   the shape is on a gradient. Without a defs element to write into there's nowhere to put
   the server, so it falls back to the shape's solid color. */
function resolveShapePaint(shape, kind, defsEl){
  const gradient = activeGradient(shape, kind);
  const solid = kind === 'stroke' ? shape.strokeColor : shape.fillColor;
  if (!gradient || !defsEl) return solid;
  const bbox = paintBBoxForShape(shape);
  const id = nextPaintServerId(kind === 'stroke' ? 'dwgs' : 'dwgf');
  defsEl.appendChild(buildGradientPaintServer(gradient, bbox, id));
  return `url(#${id})`;
}
/* Gradient geometry is anchored to the shape's untransformed bounds — the same box the
   exported pathData lives in — so a group rotation carries the gradient with the shape
   instead of sliding it across. Degenerate axes (a horizontal line) get a floor so the
   paint server still has an area to fill. */
function paintBBoxForShape(shape){
  const b = localBBoxForShape(shape);
  return { x: b.x, y: b.y, width: Math.max(b.width, 1e-3), height: Math.max(b.height, 1e-3) };
}
/* Boolean ops, merges and cuts build a brand-new path and copy the source shape's look
   onto it. Those sites already carry the solid color across; this carries the gradient
   too, so a gradient-filled shape doesn't quietly flatten the moment it's combined.
   When the source was stroke-only its stroke gradient becomes the result's fill, which
   mirrors how the existing solid fallback picks up strokeColor. */
function inheritPaintFrom(target, source){
  if (!target || !source) return target;
  const fromStroke = !source.fillEnabled && source.strokeEnabled;
  const paint = fromStroke ? source.strokePaint : source.fillPaint;
  const gradient = fromStroke ? source.strokeGradient : source.fillGradient;
  const usable = paint === 'gradient' && gradient;
  target.fillPaint = usable ? 'gradient' : 'solid';
  target.fillGradient = usable ? cloneGradient(gradient) : null;
  if (target.strokeEnabled && source.strokePaint === 'gradient' && source.strokeGradient){
    target.strokePaint = 'gradient';
    target.strokeGradient = cloneGradient(source.strokeGradient);
  }
  return target;
}
function shapeUsesGradient(shape){
  return (shape.fillEnabled && shape.fillPaint === 'gradient' && !!shape.fillGradient)
      || (shape.strokeEnabled && shape.strokePaint === 'gradient' && !!shape.strokeGradient);
}

function buildShapeFillStrokeAttrs(shape, defsEl){
  return {
    fill: shape.fillEnabled ? resolveShapePaint(shape, 'fill', defsEl) : 'none',
    'fill-opacity': shape.fillEnabled ? shape.fillOpacity : null,
    'fill-rule': shape.fillType === 'evenOdd' ? 'evenodd' : 'nonzero',
    stroke: shape.strokeEnabled ? resolveShapePaint(shape, 'stroke', defsEl) : 'none',
    'stroke-opacity': shape.strokeEnabled ? shape.strokeOpacity : null,
    'stroke-width': shape.strokeEnabled ? shape.strokeWidth : null,
    'stroke-linecap': shape.strokeLineCap,
    'stroke-linejoin': shape.strokeLineJoin,
    'stroke-miterlimit': shape.strokeLineJoin === 'miter' ? shape.strokeMiterLimit : null,
  };
}
/* Build the transform + path visual for a shape. Reused by main stage & mini previews. */
function buildShapeVisualGroup(shape){
  const g = svgEl('g', { class:'shape-xform', 'data-id': shape.id });
  g.setAttribute('transform', shapeGroupTransformStr(shape));
  const defs = svgEl('defs');
  const attrs = buildShapeFillStrokeAttrs(shape, defs);
  if (defs.childNodes.length) g.appendChild(defs);
  const path = svgEl('path', Object.assign({ d: shapePathData(shape) }, attrs));
  g.appendChild(path);
  return g;
}

function renderArtboardAndGrid(){
  gArtboard.innerHTML = '';
  gGrid.innerHTML = '';
  const d = state.doc;
  const w = d.viewportWidth, h = d.viewportHeight;
  // The "bleed" area around the artboard (sized via CANVAS_BLEED_RATIO, used by
  // layoutStage() for the stage's actual pannable/drawable extent) is just open working
  // room — shapes can be drawn/moved out here for convenience (overflow, staging, temporary
  // parking) but anything left here gets cropped away in the final icon and XML, same as
  // the real artboard boundary below. It intentionally has no background fill of its own:
  // painting a dark rect here made it look like a hard-edged box you couldn't create shapes
  // outside of. Leaving it transparent lets the canvas panel's own backdrop show through,
  // so the area reads as open canvas instead of a walled boundary.
  gArtboard.appendChild(svgEl('rect', { x:0, y:0, width:w, height:h, fill:'url(#checkerPattern)' }));

  if (d.backgroundEnabled){
    const bgOpacity = d.backgroundOpacity != null ? d.backgroundOpacity : 1;
    gArtboard.appendChild(svgEl('rect', {
      x: 0,
      y: 0,
      width: w,
      height: h,
      fill: d.backgroundColor || '#1E222B',
      opacity: bgOpacity,
      'pointer-events': 'none',
      id: 'artboardBgLayer'
    }));
  }

  if (state.grid.show){
    let step = state.grid.snapSize > 0 ? state.grid.snapSize : 1;
    while ((w/step) > 60 || (h/step) > 60) step *= 2;
    const minor = svgEl('g', { stroke:'var(--stage-grid)', 'stroke-width':1, 'vector-effect':'non-scaling-stroke', opacity:0.55 });
    for (let x = step; x < w; x += step){
      minor.appendChild(svgEl('line', { x1:x, y1:0, x2:x, y2:h }));
    }
    for (let y = step; y < h; y += step){
      minor.appendChild(svgEl('line', { x1:0, y1:y, x2:w, y2:y }));
    }
    gGrid.appendChild(minor);

    const mid = svgEl('g', { stroke:'var(--stage-grid-mid)', 'stroke-width':1, 'vector-effect':'non-scaling-stroke', opacity:0.8 });
    mid.appendChild(svgEl('line', { x1:w/2, y1:0, x2:w/2, y2:h }));
    mid.appendChild(svgEl('line', { x1:0, y1:h/2, x2:w, y2:h/2 }));
    gGrid.appendChild(mid);
  }

  if (state.grid.keyline){
    const kg = svgEl('g', { fill:'none', stroke:'var(--accent)', 'stroke-width':1, 'vector-effect':'non-scaling-stroke', opacity:0.35, 'stroke-dasharray':'3 2' });
    const cx = w/2, cy = h/2;
    kg.appendChild(svgEl('circle', { cx, cy, r: Math.min(w,h) * (10/24) }));
    const sq = w * (18/24), sqh = h * (18/24);
    kg.appendChild(svgEl('rect', { x: cx - sq/2, y: cy - sqh/2, width: sq, height: sqh }));
    gGrid.appendChild(kg);
  }

  gGrid.appendChild(svgEl('rect', { x:0, y:0, width:w, height:h, fill:'none', stroke:'var(--stage-frame)', 'stroke-width':1.25, 'vector-effect':'non-scaling-stroke' }));
}

function renderShapesLayer(){
  gShapes.innerHTML = '';
  for (const shape of state.shapes){
    if (!shape.visible) continue;
    const node = svgEl('g', { class:'shape-node', 'data-id': shape.id });
    if (shape.locked) node.style.cursor = 'not-allowed';
    const xform = svgEl('g', { class:'shape-xform', transform: shapeGroupTransformStr(shape) });
    const d = shapePathData(shape);
    // generous invisible hit target so empty fill / thin stroke shapes stay clickable
    const strokeExtent = Math.max(shape.strokeWidth || 0, shape.strokeInnerWidth || 0, shape.strokeOuterWidth || 0);
    const hitStroke = (shape.strokeEnabled || strokeExtent > 0) ? Math.max(strokeExtent, 1.5) : 1.5;
    const hit = svgEl('path', { d, fill:'rgba(0,0,0,0.001)', stroke:'rgba(0,0,0,0.001)', 'stroke-width': hitStroke, 'pointer-events':'all' });
    const outerWidth = Math.max(0, Number(shape.strokeOuterWidth) || 0);
    const innerWidth = Math.max(0, Number(shape.strokeInnerWidth) || 0);
    // One defs per shape node holds every paint server this shape needs. The centered,
    // inner and outer strokes each get their own instance of the stroke gradient —
    // a paint server can't be shared by reference across elements without them fighting
    // over the same id, and the cost of a few extra <linearGradient> nodes is trivial.
    const shapeDefs = svgEl('defs');
    // An outer stroke is painted under the fill; the fill hides its inner half.
    // The inner stroke is clipped to the path interior, so both widths can coexist.
    if (outerWidth > 0){
      const outer = svgEl('path', { d, fill:'none', stroke:resolveShapePaint(shape, 'stroke', shapeDefs), 'stroke-opacity':shape.strokeOpacity, 'stroke-width':outerWidth * 2, 'stroke-linecap':shape.strokeLineCap, 'stroke-linejoin':shape.strokeLineJoin, 'stroke-miterlimit':shape.strokeMiterLimit });
      outer.setAttribute('pointer-events', 'none');
      xform.appendChild(shapeDefs);
      xform.appendChild(outer);
    }
    const visible = svgEl('path', Object.assign({ d }, buildShapeFillStrokeAttrs(visibleAttrsSafe(shape), shapeDefs)));
    visible.setAttribute('pointer-events', 'none');
    if (!shapeDefs.parentNode && shapeDefs.childNodes.length) xform.appendChild(shapeDefs);
    xform.appendChild(hit);
    xform.appendChild(visible);
    if (innerWidth > 0){
      const clipId = 'stroke-inner-' + shape.id;
      const defs = svgEl('defs');
      const clip = svgEl('clipPath', { id:clipId });
      clip.appendChild(svgEl('path', { d, 'clip-rule':shape.fillType === 'evenOdd' ? 'evenodd' : 'nonzero' }));
      defs.appendChild(clip);
      xform.appendChild(defs);
      const inner = svgEl('path', { d, fill:'none', stroke:resolveShapePaint(shape, 'stroke', defs), 'stroke-opacity':shape.strokeOpacity, 'stroke-width':innerWidth * 2, 'stroke-linecap':shape.strokeLineCap, 'stroke-linejoin':shape.strokeLineJoin, 'stroke-miterlimit':shape.strokeMiterLimit, 'clip-path':'url(#' + clipId + ')' });
      inner.setAttribute('pointer-events', 'none');
      xform.appendChild(inner);
    }
    node.appendChild(xform);
    gShapes.appendChild(node);
  }
}
function visibleAttrsSafe(shape){ return shape; }

/* ---------------- selection overlay ---------------- */
function localBBoxForShape(shape){
  if (shape.type === 'line'){
    if (shape.x1 != null && shape.y1 != null && shape.x2 != null && shape.y2 != null){
      const minX = Math.min(shape.x1, shape.x2), maxX = Math.max(shape.x1, shape.x2);
      const minY = Math.min(shape.y1, shape.y2), maxY = Math.max(shape.y1, shape.y2);
      return { x: minX, y: minY, width: Math.max(0.0001, maxX - minX), height: Math.max(0.0001, maxY - minY) };
    }
  }
  if (shape.type === 'path' || shape.type === 'curve' || shape.type === 'text'){
    return { x: shape.pivotX - shape.nativeWidth/2, y: shape.pivotY - shape.nativeHeight/2, width: shape.nativeWidth, height: shape.nativeHeight };
  }
  return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
}
/* Same box as localBBoxForShape, but padded out to the shape's visible stroked edge.
   Used only for drawing the selection outline / handle positions so handles sit ON the
   outline you actually see instead of floating inside a thick stroke. Resize math itself
   still uses the true geometric bbox from localBBoxForShape. */
function visualHandleBBox(shape){
  const lb = localBBoxForShape(shape);
  const strokeExtent = Math.max(
    Number(shape.strokeWidth) || 0,
    Number(shape.strokeInnerWidth) || 0,
    Number(shape.strokeOuterWidth) || 0
  );
  if (!shape.strokeEnabled && !(shape.strokeInnerWidth > 0) && !(shape.strokeOuterWidth > 0)) return lb;
  if (strokeExtent <= 0) return lb;
  const pad = strokeExtent / 2;
  return { x: lb.x - pad, y: lb.y - pad, width: lb.width + pad*2, height: lb.height + pad*2 };
}
function getShapePivotStage(shape){
  const pivot = shapeLocalPivot(shape);
  return { x:pivot.x + (shape.translateX||0), y:pivot.y + (shape.translateY||0) };
}
function getShapeStageBounds(shape){
  if (!shape) return { x:0, y:0, width:0, height:0, right:0, bottom:0, cx:0, cy:0 };
  if (isLineShape(shape)){
    const pts = getLineEndpointsStage(shape);
    const minX = Math.min(pts.p1.x, pts.p2.x), maxX = Math.max(pts.p1.x, pts.p2.x);
    const minY = Math.min(pts.p1.y, pts.p2.y), maxY = Math.max(pts.p1.y, pts.p2.y);
    const w = Math.max(0.001, maxX - minX), h = Math.max(0.001, maxY - minY);
    return { x: minX, y: minY, width: w, height: h, right: maxX, bottom: maxY, cx: (minX + maxX)/2, cy: (minY + maxY)/2 };
  }
  if (shape.type === 'path' || shape.type === 'curve' || shape.type === 'text'){
    const w = Math.max(0.001, (shape.nativeWidth || 0.001) * Math.abs(shape.scaleX || 1));
    const h = Math.max(0.001, (shape.nativeHeight || 0.001) * Math.abs(shape.scaleY || 1));
    const px = (shape.pivotX || 0) + (shape.translateX || 0);
    const py = (shape.pivotY || 0) + (shape.translateY || 0);
    const x = px - w/2;
    const y = py - h/2;
    return { x, y, width: w, height: h, right: x + w, bottom: y + h, cx: px, cy: py };
  }
  const w = Math.max(0.001, (shape.width || 0.001) * Math.abs(shape.scaleX || 1));
  const h = Math.max(0.001, (shape.height || 0.001) * Math.abs(shape.scaleY || 1));
  const cx = shape.x + shape.width/2 + (shape.translateX || 0);
  const cy = shape.y + shape.height/2 + (shape.translateY || 0);
  const x = cx - w/2;
  const y = cy - h/2;
  return { x, y, width: w, height: h, right: x + w, bottom: y + h, cx, cy };
}

/* Same box as getShapeStageBounds, but padded out to the shape's visible stroked edge —
   used for smart/alignment guides so they snap to what you actually see on canvas
   instead of the underlying fill geometry when a shape has a thick stroke. */
function getShapeVisualStageBounds(shape){
  const b = getShapeStageBounds(shape);
  if (!shape) return b;
  const hasStroke = shape.strokeEnabled || (shape.strokeInnerWidth||0) > 0 || (shape.strokeOuterWidth||0) > 0;
  if (!hasStroke) return b;
  const strokeExtent = Math.max(
    Number(shape.strokeWidth) || 0,
    Number(shape.strokeInnerWidth) || 0,
    Number(shape.strokeOuterWidth) || 0
  );
  if (strokeExtent <= 0) return b;
  const scaleFactor = (Math.abs(shape.scaleX || 1) + Math.abs(shape.scaleY || 1)) / 2;
  const pad = (strokeExtent / 2) * scaleFactor;
  return {
    x: b.x - pad, y: b.y - pad,
    width: b.width + pad*2, height: b.height + pad*2,
    right: b.right + pad, bottom: b.bottom + pad,
    cx: b.cx, cy: b.cy,
  };
}

function getSelectionStageBounds(shapes){
  if (!shapes || !shapes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes){
    const b = getShapeStageBounds(s);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.right);
    maxY = Math.max(maxY, b.bottom);
  }
  if (!isFinite(minX)) return null;
  const w = maxX - minX, h = maxY - minY;
  return { x: minX, y: minY, width: w, height: h, right: maxX, bottom: maxY, cx: minX + w/2, cy: minY + h/2 };
}
/* Stroke-aware counterpart of getSelectionStageBounds — used for the multi-select
   visual outline and for smart-guide snapping, never for resize math (which needs
   the true geometric bounds so shapes scale by exactly the ratio you drag). */
function getSelectionVisualStageBounds(shapes){
  if (!shapes || !shapes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes){
    const b = getShapeVisualStageBounds(s);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.right);
    maxY = Math.max(maxY, b.bottom);
  }
  if (!isFinite(minX)) return null;
  const w = maxX - minX, h = maxY - minY;
  return { x: minX, y: minY, width: w, height: h, right: maxX, bottom: maxY, cx: minX + w/2, cy: minY + h/2 };
}

/* ----------- alignment guides ----------- */
function renderActiveAlignGuides(){
  if (!state.activeGuideLines || !state.activeGuideLines.length) return;
  const g = svgEl('g', { id:'alignGuides' });
  for (const line of state.activeGuideLines){
    g.appendChild(svgEl('line', {
      x1: fmt(line.x1), y1: fmt(line.y1), x2: fmt(line.x2), y2: fmt(line.y2),
      stroke: 'var(--accent)',
      'stroke-width': 1.25,
      'vector-effect': 'non-scaling-stroke',
      'stroke-dasharray': '4 3',
      opacity: 0.95
    }));
  }
  gOverlay.appendChild(g);
}

function computeAlignGuideSnap(movingShapes, proposedBbox){
  if (!state.grid.guides || !proposedBbox) return { dx: 0, dy: 0, lines: [] };
  const d = state.doc;
  const vpW = d.viewportWidth, vpH = d.viewportHeight;
  const movingIds = new Set(movingShapes.map(s => s.id));

  // Dynamic snap threshold (~12 screen px at current zoom level)
  const threshold = Math.max(0.4, 12 / (PX_PER_UNIT * (state.view.zoom || 1)));

  // Candidate alignment X and Y coordinates
  const xCandidates = [0, vpW / 2, vpW];
  const yCandidates = [0, vpH / 2, vpH];

  for (const shape of state.shapes){
    if (!shape.visible || movingIds.has(shape.id)) continue;
    const sb = getShapeVisualStageBounds(shape);
    xCandidates.push(sb.x, sb.cx, sb.right);
    yCandidates.push(sb.y, sb.cy, sb.bottom);
  }

  const { x: bx, y: by, width: bw, height: bh, cx: bCX, cy: bCY, right: bRight, bottom: bBottom } = proposedBbox;

  let snapDx = 0, snapDy = 0;
  let bestXDist = threshold, bestYDist = threshold;
  let activeX = null, activeY = null;

  const xPoints = [bx, bCX, bRight];
  for (const cx of xCandidates){
    for (const px of xPoints){
      const dist = Math.abs(px - cx);
      if (dist < bestXDist){
        bestXDist = dist;
        snapDx = cx - px;
        activeX = cx;
      }
    }
  }

  const yPoints = [by, bCY, bBottom];
  for (const cy of yCandidates){
    for (const py of yPoints){
      const dist = Math.abs(py - cy);
      if (dist < bestYDist){
        bestYDist = dist;
        snapDy = cy - py;
        activeY = cy;
      }
    }
  }

  const guideLines = [];
  if (activeX != null){
    guideLines.push({ x1: activeX, y1: 0, x2: activeX, y2: vpH });
  }
  if (activeY != null){
    guideLines.push({ x1: 0, y1: activeY, x2: vpW, y2: activeY });
  }

  return { dx: snapDx, dy: snapDy, lines: guideLines };
}



function renderDraftPreviews(){
  const z = state.view.zoom || 1;
  const hs = 6 / (PX_PER_UNIT * z);

  if (state.tool === 'arc' && state.arcDraft && state.arcHoverPoint){
    const start = state.arcDraft, cur = state.arcHoverPoint;
    const dx = cur.x - start.x, dy = cur.y - start.y;
    const chord = Math.hypot(dx, dy);
    if (chord > MIN_SHAPE_SIZE * 0.1){
      const radius = chord / 2;
      const cx = (start.x + cur.x) / 2, cy = (start.y + cur.y) / 2;
      const startAngle = Math.atan2(start.y - cy, start.x - cx) * 180 / Math.PI;
      const d = arcPathData(cx, cy, radius, radius, startAngle, 180, false, 0);
      gOverlay.appendChild(svgEl('path', { d, class: 'curve-preview-path' }));
      gOverlay.appendChild(svgEl('circle', { cx, cy, r: hs*0.35, fill: 'var(--text-2)', 'pointer-events':'none' }));
    }
    gOverlay.appendChild(svgEl('line', {
      x1: start.x, y1: start.y, x2: cur.x, y2: cur.y,
      stroke: 'var(--accent-2)', 'stroke-width': 1, 'stroke-dasharray': '2 2',
      'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none',
    }));
    gOverlay.appendChild(svgEl('circle', { cx: start.x, cy: start.y, r: hs*0.6, fill: 'var(--accent-2)', stroke:'#12141C', 'stroke-width':1, 'pointer-events': 'none' }));
    gOverlay.appendChild(svgEl('circle', { cx: cur.x, cy: cur.y, r: hs*0.6, fill: 'var(--accent-2)', stroke:'#12141C', 'stroke-width':1, opacity: 0.65, 'pointer-events': 'none' }));
  }

  if (state.tool === 'curve' && state.curveDraft && state.curveHoverPoint){
    const p1 = state.curveDraft, p2 = state.curveHoverPoint;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const cp1x = p1.x + dx*0.25 - dy*0.3, cp1y = p1.y + dy*0.25 + dx*0.3;
    const cp2x = p1.x + dx*0.75 - dy*0.3, cp2y = p1.y + dy*0.75 + dx*0.3;
    const d = `M${fmt(p1.x)},${fmt(p1.y)} C${fmt(cp1x)},${fmt(cp1y)} ${fmt(cp2x)},${fmt(cp2y)} ${fmt(p2.x)},${fmt(p2.y)}`;
    gOverlay.appendChild(svgEl('path', { d, class: 'curve-preview-path' }));
    gOverlay.appendChild(svgEl('circle', { cx: p1.x, cy: p1.y, r: hs*0.6, fill: '#6FA8FF', stroke:'#12141C', 'stroke-width':1, 'pointer-events': 'none' }));
    gOverlay.appendChild(svgEl('circle', { cx: p2.x, cy: p2.y, r: hs*0.6, fill: '#6FA8FF', stroke:'#12141C', 'stroke-width':1, opacity: 0.65, 'pointer-events': 'none' }));
  }

  if (state.tool === 'line' && state.lineDraft && state.lineHoverPoint){
    const p1 = state.lineDraft, p2 = state.lineHoverPoint;
    gOverlay.appendChild(svgEl('line', {
      x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
      stroke: 'var(--accent)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3',
      'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none',
    }));
    gOverlay.appendChild(svgEl('circle', { cx: p1.x, cy: p1.y, r: hs*0.6, fill: 'var(--accent)', stroke:'#12141C', 'stroke-width':1, 'pointer-events': 'none' }));
    gOverlay.appendChild(svgEl('circle', { cx: p2.x, cy: p2.y, r: hs*0.6, fill: 'var(--accent)', stroke:'#12141C', 'stroke-width':1, opacity: 0.65, 'pointer-events': 'none' }));
  }
}

function renderSelectionOverlay(){
  gOverlay.innerHTML = '';
  renderActiveAlignGuides();
  renderDraftPreviews();

  if (state.activeEndpointSnap){
    const z = state.view.zoom || 1;
    const hs = 7.5 / (PX_PER_UNIT * z);
    const snapG = svgEl('g', { class:'snap-indicator-group', 'pointer-events':'none' });
    snapG.appendChild(svgEl('circle', {
      class:'snap-target-ring',
      cx: state.activeEndpointSnap.x,
      cy: state.activeEndpointSnap.y,
      r: hs,
    }));
    snapG.appendChild(svgEl('circle', {
      cx: state.activeEndpointSnap.x,
      cy: state.activeEndpointSnap.y,
      r: hs * 0.4,
      fill: 'var(--accent)',
    }));
    const badge = svgEl('text', {
      x: state.activeEndpointSnap.x + hs * 1.6,
      y: state.activeEndpointSnap.y + 3.5 / (PX_PER_UNIT * z),
      class: 'snap-badge',
    });
    badge.textContent = '';
    snapG.appendChild(badge);
    gOverlay.appendChild(snapG);
  }

  const sel = selectedShapes().filter(s => s.visible);
  if (!sel.length) return;
  const z = state.view.zoom;

  if (sel.length === 1 && !sel[0].locked){
    const shape = sel[0];
    if (state.tool === 'node' && shape.type === 'curve'){
      const hs = 6 / (PX_PER_UNIT * z);
      const cpR = hs * 0.95;

      // Curve selection guide
      gOverlay.appendChild(svgEl('path', {
        d: `M ${fmt(shape.x1)} ${fmt(shape.y1)} C ${fmt(shape.cp1x)} ${fmt(shape.cp1y)}, ${fmt(shape.cp2x)} ${fmt(shape.cp2y)}, ${fmt(shape.x2)} ${fmt(shape.y2)}`,
        class: 'sel-outline curve-sel-guide',
      }));

      // Control tangent 1
      gOverlay.appendChild(svgEl('line', {
        x1: shape.x1, y1: shape.y1,
        x2: shape.cp1x, y2: shape.cp1y,
        stroke: 'var(--accent-2)',
        'stroke-width': 1.2,
        'stroke-dasharray': '2 2',
        'vector-effect': 'non-scaling-stroke',
        'pointer-events': 'none',
      }));
      // Control tangent 2
      gOverlay.appendChild(svgEl('line', {
        x1: shape.x2, y1: shape.y2,
        x2: shape.cp2x, y2: shape.cp2y,
        stroke: 'var(--accent-2)',
        'stroke-width': 1.2,
        'stroke-dasharray': '2 2',
        'vector-effect': 'non-scaling-stroke',
        'pointer-events': 'none',
      }));

      // Control Point 1 handle (diamond = "this is a direction handle, not an anchor")
      const hCp1 = svgDiamondHandle(shape.cp1x, shape.cp1y, cpR, {
        class: 'sel-handle curve-cp-handle',
        'data-handle': 'curve-cp1',
        'data-id': shape.id,
        title: 'Bézier Handle 1 (drag to adjust curvature)',
      });
      gOverlay.appendChild(hCp1);

      // Control Point 2 handle
      const hCp2 = svgDiamondHandle(shape.cp2x, shape.cp2y, cpR, {
        class: 'sel-handle curve-cp-handle',
        'data-handle': 'curve-cp2',
        'data-id': shape.id,
        title: 'Bézier Handle 2 (drag to adjust curvature)',
      });
      gOverlay.appendChild(hCp2);

      // Start point P1
      const h1 = svgEl('circle', {
        class: 'sel-handle line-point-handle',
        'data-handle': 'curve-p1',
        'data-id': shape.id,
        cx: shape.x1, cy: shape.y1,
        r: hs,
        title: 'Start point (drag to reposition curve end)',
      });
      const h1Dot = svgEl('circle', {
        cx: shape.x1, cy: shape.y1,
        r: hs * 0.45,
        fill: 'var(--accent-2)',
        'pointer-events': 'none',
      });
      gOverlay.appendChild(h1);
      gOverlay.appendChild(h1Dot);

      // End point P2
      const h2 = svgEl('circle', {
        class: 'sel-handle line-point-handle',
        'data-handle': 'curve-p2',
        'data-id': shape.id,
        cx: shape.x2, cy: shape.y2,
        r: hs,
        title: 'End point (drag to reposition curve end)',
      });
      const h2Dot = svgEl('circle', {
        cx: shape.x2, cy: shape.y2,
        r: hs * 0.45,
        fill: 'var(--accent-2)',
        'pointer-events': 'none',
      });
      gOverlay.appendChild(h2);
      gOverlay.appendChild(h2Dot);
    } else if (state.tool === 'node' && shape.type === 'arc'){
      const hs = 6.5 / (PX_PER_UNIT * z);
      const rx = Math.max(0.001, shape.width/2), ry = Math.max(0.001, shape.height/2);
      const cx = shape.x + rx, cy = shape.y + ry;
      const startDeg = shape.startAngle || 0;
      const sweep = shape.sweepAngle != null ? shape.sweepAngle : 270;
      const startA = startDeg * Math.PI/180;
      const endA = (startDeg + sweep) * Math.PI/180;
      const sx = cx + rx*Math.cos(startA), sy = cy + ry*Math.sin(startA);
      const ex = cx + rx*Math.cos(endA), ey = cy + ry*Math.sin(endA);
      const isSector = !!shape.sector;
      const innerRatio = (shape.innerRadiusPercent||0)/100;

      // Live outline of the exact arc/pie/ring shape
      const guideD = arcPathData(cx, cy, rx, ry, startDeg, sweep, isSector, innerRatio);
      gOverlay.appendChild(svgEl('path', { d: guideD, class: 'sel-outline curve-sel-guide' }));

      // Spokes from center to start (teal) and end (amber) so the sweep direction is obvious
      gOverlay.appendChild(svgEl('line', { x1:cx, y1:cy, x2:sx, y2:sy, class:'curve-arm-line' }));
      const endSpoke = svgEl('line', { x1:cx, y1:cy, x2:ex, y2:ey, class:'curve-arm-line' });
      endSpoke.style.stroke = '#F5B75E';
      gOverlay.appendChild(endSpoke);
      gOverlay.appendChild(svgEl('circle', { cx, cy, r:hs*0.4, fill:'var(--text-2)', 'pointer-events':'none' }));

      // Start-angle handle — dragging rotates the whole arc
      gOverlay.appendChild(svgEl('circle', {
        class: 'sel-handle arc-angle-handle',
        'data-handle': 'arc-start', 'data-id': shape.id,
        cx: sx, cy: sy, r: hs,
        title: 'Start angle (drag to rotate the whole arc)',
      }));
      // End/sweep handle — dragging changes how much of the pie is filled ("the opening")
      gOverlay.appendChild(svgEl('circle', {
        class: 'sel-handle arc-angle-handle arc-end-handle',
        'data-handle': 'arc-end', 'data-id': shape.id,
        cx: ex, cy: ey, r: hs,
        title: 'Sweep / opening (drag to change how much of the pie is filled)',
      }));
      // Inner-radius (donut hole) handle — only meaningful once it's a filled sector or ring
      if (isSector || innerRatio > 0){
        const midA = startA + (endA - startA) / 2;
        const ratio = Math.max(innerRatio, 0.12);
        const ix = cx + rx*ratio*Math.cos(midA), iy = cy + ry*ratio*Math.sin(midA);
        gOverlay.appendChild(svgEl('circle', {
          class: 'sel-handle arc-inner-handle',
          'data-handle': 'arc-inner', 'data-id': shape.id,
          cx: ix, cy: iy, r: hs*0.85,
          title: 'Inner radius (drag toward/away from center for a donut hole)',
        }));
      }
    } else if (state.tool === 'node' && shape.type === 'path' && shape.rawD){
      renderNodeEditorOverlay(shape, z);
    } else if (isLineShape(shape)){
      const pts = getLineEndpointsStage(shape);
      const hs = 6 / (PX_PER_UNIT * z);

      // Line selection outline guide
      gOverlay.appendChild(svgEl('line', {
        x1: pts.p1.x, y1: pts.p1.y,
        x2: pts.p2.x, y2: pts.p2.y,
        class: 'sel-outline line-sel-guide',
      }));

      // Endpoint 1 handle (P1)
      const h1 = svgEl('circle', {
        class: 'sel-handle line-point-handle',
        'data-handle': 'line-p1',
        'data-id': shape.id,
        cx: pts.p1.x,
        cy: pts.p1.y,
        r: hs,
        title: 'Start point (drag to stretch or connect to another line)',
      });
      const h1Dot = svgEl('circle', {
        cx: pts.p1.x,
        cy: pts.p1.y,
        r: hs * 0.45,
        fill: 'var(--accent-2)',
        'pointer-events': 'none',
      });
      gOverlay.appendChild(h1);
      gOverlay.appendChild(h1Dot);

      // Endpoint 2 handle (P2)
      const h2 = svgEl('circle', {
        class: 'sel-handle line-point-handle',
        'data-handle': 'line-p2',
        'data-id': shape.id,
        cx: pts.p2.x,
        cy: pts.p2.y,
        r: hs,
        title: 'End point (drag to stretch or connect to another line)',
      });
      const h2Dot = svgEl('circle', {
        cx: pts.p2.x,
        cy: pts.p2.y,
        r: hs * 0.45,
        fill: 'var(--accent-2)',
        'pointer-events': 'none',
      });
      gOverlay.appendChild(h2);
      gOverlay.appendChild(h2Dot);
    } else {
      const lb = visualHandleBBox(shape);
      const g = svgEl('g', { class:'sel-node', transform: shapeGroupTransformStr(shape) });
      g.appendChild(svgEl('rect', { class:'sel-outline', x: lb.x, y: lb.y, width: lb.width, height: lb.height }));

      const hs = 5.5 / (PX_PER_UNIT * z);
      const scaleX = Math.max(0.0001, Math.abs(shape.scaleX || 1));
      const scaleY = Math.max(0.0001, Math.abs(shape.scaleY || 1));
      const handleWidth = hs * 2 / scaleX;
      const handleHeight = hs * 2 / scaleY;

      const points = {
        nw: [lb.x, lb.y], n: [lb.x+lb.width/2, lb.y], ne: [lb.x+lb.width, lb.y],
        w:  [lb.x, lb.y+lb.height/2],                  e:  [lb.x+lb.width, lb.y+lb.height/2],
        sw: [lb.x, lb.y+lb.height], s: [lb.x+lb.width/2, lb.y+lb.height], se: [lb.x+lb.width, lb.y+lb.height],
      };
      for (const name in points){
        const [px,py] = points[name];
        g.appendChild(svgEl('rect', {
          class:'sel-handle', 'data-handle':name, 'data-id':shape.id,
          x: px-handleWidth/2, y: py-handleHeight/2, width: handleWidth, height: handleHeight,
        }));
      }
      // rotate handle
      const rOffset = 22 / (PX_PER_UNIT * z * scaleY);
      const rx = lb.x + lb.width/2, ry = lb.y - rOffset;
      g.appendChild(svgEl('line', { x1: lb.x+lb.width/2, y1: lb.y, x2: rx, y2: ry, stroke:'var(--accent)', 'stroke-width':1, 'vector-effect':'non-scaling-stroke' }));
      const rotateHandle = svgEl('g', {
        transform: `translate(${fmt(rx)} ${fmt(ry)}) scale(${fmt(1/scaleX)} ${fmt(1/scaleY)}) translate(${fmt(-rx)} ${fmt(-ry)})`
      });
      rotateHandle.appendChild(svgEl('circle', { class:'sel-handle rot', 'data-handle':'rotate', 'data-id':shape.id, cx:rx, cy:ry, r:hs*1.15 }));
      g.appendChild(rotateHandle);

      gOverlay.appendChild(g);

      // If this is a path, also render interactive vertex handles for direct point editing
      if (state.tool === 'node' && shape.type === 'path' && shape.rawD){
        const sub = parseSvgPathToSubpaths(shape.rawD);
        if (sub.length && sub[0].points.length >= 2){
          const stagePts = sub[0].points.map(p => shapePointToStage(shape, p));
          const vhs = 5.5 / (PX_PER_UNIT * z);
          stagePts.forEach((pt, idx) => {
            const vh = svgEl('circle', {
              class: 'sel-handle line-point-handle vertex-handle',
              'data-handle': 'vertex-' + idx,
              'data-vertex-idx': String(idx),
              'data-id': shape.id,
              cx: pt.x,
              cy: pt.y,
              r: vhs * 1.1,
              title: `Point ${idx + 1} (drag to reshape point or connect)`
            });
            const vhDot = svgEl('circle', {
              cx: pt.x,
              cy: pt.y,
              r: vhs * 0.45,
              fill: 'var(--accent-2)',
              'pointer-events': 'none'
            });
            gOverlay.appendChild(vh);
            gOverlay.appendChild(vhDot);
          });
        }
      }
    }
  } else {
    // multi-select: individual thin outlines + union bbox drag handle
    const unlockedSel = sel.filter(s => !s.locked);
    for (const shape of unlockedSel){
      if (isLineShape(shape)){
        const pts = getLineEndpointsStage(shape);
        const l = svgEl('line', {
          x1: pts.p1.x, y1: pts.p1.y,
          x2: pts.p2.x, y2: pts.p2.y,
          class: 'sel-outline line-sel-guide',
        });
        l.style.opacity = 0.55;
        gOverlay.appendChild(l);
      } else {
        const lb = visualHandleBBox(shape);
        const g = svgEl('g', { transform: shapeGroupTransformStr(shape) });
        const outline = svgEl('rect', { class:'sel-outline', x: lb.x, y: lb.y, width: lb.width, height: lb.height });
        outline.style.opacity = 0.55;
        g.appendChild(outline);
        gOverlay.appendChild(g);
      }
    }
    const bounds = getSelectionVisualStageBounds(unlockedSel);
    if (bounds && bounds.width > 0 && bounds.height > 0){
      const minX = bounds.x, minY = bounds.y, maxX = bounds.right, maxY = bounds.bottom;
      const box = svgEl('rect', {
        class:'sel-outline', x:minX, y:minY, width:bounds.width, height:bounds.height,
        'stroke-dasharray':'4 3', 'data-multibox':'1',
      });
      gOverlay.appendChild(box);
      const hs = 5.5 / (PX_PER_UNIT * z);
      const points = {
        nw:[minX,minY], n:[(minX+maxX)/2,minY], ne:[maxX,minY],
        w:[minX,(minY+maxY)/2], e:[maxX,(minY+maxY)/2],
        sw:[minX,maxY], s:[(minX+maxX)/2,maxY], se:[maxX,maxY],
      };
      for (const name in points){
        const [px,py] = points[name];
        gOverlay.appendChild(svgEl('rect', {
          class:'sel-handle', 'data-handle':name, 'data-multi-handle':'1',
          x:px-hs, y:py-hs, width:hs*2, height:hs*2,
        }));
      }
    }
  }
}

function renderNodeEditorOverlay(shape, z){
  const nodes = parseSvgPathToNodes(shape.rawD);
  if (!nodes.length) return;
  const hs = 5.5 / (PX_PER_UNIT * z);
  const cpR = hs * 0.8;

  // Draw node anchor points and Bézier control handles
  nodes.forEach((n, idx) => {
    const isSelected = (state.nodeEdit.selectedNodeIndex === idx);

    // Tangents / control handles for smooth curve nodes or curve segments
    if (n.cp1){
      gOverlay.appendChild(svgEl('line', {
        x1: n.x, y1: n.y,
        x2: n.cp1.x, y2: n.cp1.y,
        stroke: 'var(--accent-2)',
        'stroke-width': 1.2,
        'stroke-dasharray': '2 2',
        'vector-effect': 'non-scaling-stroke',
        'pointer-events': 'none',
      }));
      const hCp1 = svgEl('circle', {
        class: 'sel-handle node-cp-handle',
        'data-handle': 'node-cp1',
        'data-id': shape.id,
        'data-node-idx': String(idx),
        cx: n.cp1.x, cy: n.cp1.y,
        r: cpR,
        fill: 'var(--accent)',
        stroke: '#12141C',
        'stroke-width': 1.5,
        title: `Node ${idx + 1} Control Handle 1`,
      });
      gOverlay.appendChild(hCp1);
    }
    if (n.cp2){
      gOverlay.appendChild(svgEl('line', {
        x1: n.x, y1: n.y,
        x2: n.cp2.x, y2: n.cp2.y,
        stroke: 'var(--accent-2)',
        'stroke-width': 1.2,
        'stroke-dasharray': '2 2',
        'vector-effect': 'non-scaling-stroke',
        'pointer-events': 'none',
      }));
      const hCp2 = svgEl('circle', {
        class: 'sel-handle node-cp-handle',
        'data-handle': 'node-cp2',
        'data-id': shape.id,
        'data-node-idx': String(idx),
        cx: n.cp2.x, cy: n.cp2.y,
        r: cpR,
        fill: 'var(--accent)',
        stroke: '#12141C',
        'stroke-width': 1.5,
        title: `Node ${idx + 1} Control Handle 2`,
      });
      gOverlay.appendChild(hCp2);
    }

    // Anchor node handle
    const isSmooth = (n.type === 'smooth' || (n.cp1 && n.cp2));
    const anchor = svgEl(isSmooth ? 'circle' : 'rect', {
      class: `sel-handle node-anchor-handle ${isSelected ? 'selected' : ''}`,
      'data-handle': 'node-anchor',
      'data-id': shape.id,
      'data-node-idx': String(idx),
      cx: isSmooth ? n.x : null,
      cy: isSmooth ? n.y : null,
      x: isSmooth ? null : n.x - hs,
      y: isSmooth ? null : n.y - hs,
      width: isSmooth ? null : hs * 2,
      height: isSmooth ? null : hs * 2,
      r: isSmooth ? hs * 1.1 : null,
      fill: isSelected ? 'var(--accent)' : '#FFFFFF',
      stroke: '#12141C',
      'stroke-width': 1.5,
      title: `Node ${idx + 1} (${isSmooth ? 'Smooth Curve' : 'Corner/Straight'}) — Drag to move, double-click to toggle curve`,
    });
    gOverlay.appendChild(anchor);
  });
}

function renderStage(){
  layoutStage();
  renderArtboardAndGrid();
  renderShapesLayer();
  renderSelectionOverlay();
  updateHoverOutline(state.hoveredShapeId);
}


/* =====================================================================================
   Part 5: canvas interaction — select/move/resize/rotate, draw tools, pen tool, pan/zoom
   ===================================================================================== */
const MIN_SHAPE_SIZE = 0.05;

function renderDuringDrag(){ renderStage(); renderPropertiesPanel(); }
function renderAll(){
  renderStage();
  renderPropertiesPanel();
  renderLayers();
  renderXmlPreview();
  renderPreviewStrip();
  updateUndoRedoButtons();
  updateTopbarMisc();
}
function updateTopbarMisc(){
  if (DOM.docNameInput && document.activeElement !== DOM.docNameInput) DOM.docNameInput.value = state.doc.name;
  updateSaveStatus();
}

function setTool(tool){
  if (state.tool !== 'pen' && tool !== 'pen' && state.penActive) cancelPen();
  if (state.tool === 'pen' && tool !== 'pen' && state.penActive) cancelPen();
  if (state.tool === 'arc' && tool !== 'arc'){ state.arcDraft = null; state.arcHoverPoint = null; }
  if (state.tool === 'curve' && tool !== 'curve'){ state.curveDraft = null; state.curveHoverPoint = null; }
  if (state.tool === 'line' && tool !== 'line'){ state.lineDraft = null; state.lineHoverPoint = null; state.activeEndpointSnap = null; }
  if (state.tool === 'cut' && tool !== 'cut' && state.cutActive){ cancelCut(); }
  state.tool = tool;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  DOM.canvasScroll.classList.toggle('pan-tool', tool === 'pan');
  DOM.canvasScroll.style.cursor = (tool === 'select') ? 'default' : (tool === 'pan' ? '' : 'crosshair');
  rememberLastTool(tool);
  renderStage();
}

function stagePointerDown(e){
  if (e.button === 1){ e.preventDefault(); startPan(e); return; }
  if (state.spaceHeld || state.tool === 'pan'){ startPan(e); return; }
  if (e.button !== 0) return;

  const target = e.target;
  const handleEl = target.closest ? target.closest('.sel-handle') : null;
  if (handleEl){
    const handle = handleEl.dataset.handle, id = handleEl.dataset.id;
    if (handle === 'node-anchor' || handle === 'node-cp1' || handle === 'node-cp2'){
      const nodeIdx = parseInt(handleEl.dataset.nodeIdx, 10);
      if (handle === 'node-anchor'){
        if (e.altKey){
          e.preventDefault();
          deleteNodeFromPath(id, nodeIdx);
          return;
        }
        if (e.detail === 2){
          e.preventDefault();
          toggleNodeCornerSmooth(id, nodeIdx);
          return;
        }
      }
      startNodeDrag(e, id, nodeIdx, handle.replace('node-', ''));
      return;
    }
    if (handle === 'curve-cp1' || handle === 'curve-cp2'){
      startCurveControlPointResize(e, id, handle);
      return;
    }
    if (handle === 'curve-p1' || handle === 'curve-p2'){
      startCurveEndpointResize(e, id, handle);
      return;
    }
    if (handle === 'arc-start' || handle === 'arc-end'){
      startArcAngleDrag(e, id, handle === 'arc-start' ? 'start' : 'end');
      return;
    }
    if (handle === 'arc-inner'){
      startArcInnerRadiusDrag(e, id);
      return;
    }
    if (handleEl.dataset.multiHandle) startMultiResize(e, handle);
    else if (handle === 'rotate') startRotate(e, id);
    else if (handle === 'line-p1' || handle === 'line-p2') startLinePointResize(e, id, handle);
    else if (handle && handle.startsWith('vertex-')){
      const vIdx = parseInt(handleEl.dataset.vertexIdx ?? handle.replace('vertex-', ''), 10);
      startPathVertexResize(e, id, vIdx);
    }
    else startResize(e, id, handle);
    return;
  }

  if (state.tool === 'node'){
    const shapeNode = target.closest ? target.closest('.shape-node') : null;
    if (shapeNode){
      const id = shapeNode.dataset.id;
      const shape = findShapeById(id);
      if (shape && !shape.locked){
        // Arcs and curves get their own dedicated on-canvas handles (angle/inner-radius
        // for arcs, Bézier diamonds for curves) — don't flatten them into a generic path.
        const isSpecialEditable = (shape.type === 'curve' || shape.type === 'arc');
        if (shape.type !== 'path' && !isSpecialEditable){
          convertShapeToPathShape(shape);
        }
        const isAlreadyActive = (state.nodeEdit.shapeId === shape.id && state.selectedIds.includes(shape.id));
        selectOnly(shape.id);
        state.nodeEdit.shapeId = shape.id;
        if (isAlreadyActive && shape.type === 'path'){
          const pt = clientToStagePoint(e.clientX, e.clientY);
          addNodeToPath(shape.id, pt.x, pt.y);
        } else {
          state.nodeEdit.selectedNodeIndex = 0;
          renderAll();
        }
      }
    } else {
      clearSelection();
      state.nodeEdit.shapeId = null;
      renderAll();
    }
    return;
  }

  if (state.tool === 'select'){
    const shapeNode = target.closest ? target.closest('.shape-node') : null;
    if (shapeNode){
      const id = shapeNode.dataset.id;
      const shape = findShapeById(id);
      if (shape && shape.locked) return;
      // Clicking any member of a group targets the whole group — selects, outlines and
      // drags every shape in it together — matching what the layer panel's group header
      // already does. Hold Ctrl/Cmd to reach in and work on just this one shape instead.
      state.editIndividualHeld = e.ctrlKey || e.metaKey;
      const targetIds = (!state.editIndividualHeld && shape && shape.groupId)
        ? state.shapes.filter((s) => s.groupId === shape.groupId && !s.locked).map((s) => s.id)
        : [id];
      if (e.shiftKey){
        const allIn = targetIds.every((tid) => state.selectedIds.includes(tid));
        state.selectedIds = allIn
          ? state.selectedIds.filter((sid) => !targetIds.includes(sid))
          : Array.from(new Set([...state.selectedIds, ...targetIds]));
      } else if (!state.selectedIds.includes(id)){
        state.selectedIds = targetIds;
      }
      renderAll();
      if (state.selectedIds.includes(id)) startMove(e);
    } else {
      if (!e.shiftKey) clearSelection();
      renderAll();
      startMarquee(e);
    }
    return;
  }
  if (state.tool === 'rect' || state.tool === 'ellipse' || state.tool === 'polygon'){ startDraw(e, state.tool); return; }
  if (state.tool === 'arc'){ startDrawArc(e); return; }
  if (state.tool === 'curve'){ startDrawCurve(e); return; }
  if (state.tool === 'line'){ startDrawLine(e); return; }
  if (state.tool === 'cut'){ cutToolClick(e); return; }
  if (state.tool === 'pen'){ penClick(e); return; }
  if (state.tool === 'text'){ textToolClick(e); return; }
}

function startPan(e){
  e.preventDefault();
  DOM.canvasScroll.classList.add('panning');
  const startClient = { x:e.clientX, y:e.clientY };
  const startPanXY = { x: state.view.panX, y: state.view.panY };
  function onMove(ev){
    state.view.panX = startPanXY.x + (ev.clientX - startClient.x);
    state.view.panY = startPanXY.y + (ev.clientY - startClient.y);
    layoutStage();
  }
  function onUp(){
    DOM.canvasScroll.classList.remove('panning');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// pointerover/pointerout on .shape-node are what normally keep state.hoveredShapeId in
// sync, but during a drag the shape's DOM node gets destroyed and recreated on every
// render frame (renderShapesLayer rebuilds gShapes from scratch) — a well-known class of
// browser flakiness where pointerover doesn't reliably keep re-firing for an element being
// replaced out from under a pointer that isn't actually moving relative to the page in
// between frames. Rather than trust whatever pointerover/pointerout happened to fire
// mid-drag, this explicitly asks the browser "what's actually under the pointer right now"
// once the drag settles, so the hover ring can never end up stuck on a stale shape (or
// missing/misplaced) after a move, resize, or rotate.
function resyncHoverFromClientPoint(clientX, clientY){
  if (clientX == null || clientY == null) return;
  const el = document.elementFromPoint(clientX, clientY);
  const node = el && el.closest ? el.closest('.shape-node') : null;
  state.hoveredShapeId = node ? node.dataset.id : null;
}
function startMove(e){
  beginEdit();
  const startStage = clientToStagePoint(e.clientX, e.clientY);
  let lastClientX = e.clientX, lastClientY = e.clientY;
  const origins = state.selectedIds.map(id => {
    const s = findShapeById(id);
    if (!s) return null;
    if (isLineShape(s)){
      const pts = getLineEndpointsStage(s);
      return { id, isLine: true, p1: pts.p1, p2: pts.p2, shape: s };
    }
    const p = getShapePos(s);
    return { id, isLine: false, x: p.x, y: p.y, shape: s };
  }).filter(Boolean);
  let moved = false;

  function onMove(ev){
    lastClientX = ev.clientX; lastClientY = ev.clientY;
    const cur = clientToStagePoint(ev.clientX, ev.clientY);
    const rawDx = cur.x - startStage.x;
    const rawDy = cur.y - startStage.y;
    if (Math.abs(rawDx) + Math.abs(rawDy) > 0.001) moved = true;

    for (const o of origins){
      if (!o.shape || o.shape.locked) continue;
      if (o.isLine){
        setLineEndpointsStage(o.shape,
          { x: maybeSnap(o.p1.x + rawDx), y: maybeSnap(o.p1.y + rawDy) },
          { x: maybeSnap(o.p2.x + rawDx), y: maybeSnap(o.p2.y + rawDy) }
        );
      } else {
        setShapePos(o.shape, maybeSnap(o.x + rawDx), maybeSnap(o.y + rawDy));
      }
    }

    const sel = selectedShapes();
    if (sel.length && state.grid.guides){
      const b = getSelectionVisualStageBounds(sel);
      if (b){
        const snap = computeAlignGuideSnap(sel, b);
        if (snap.dx || snap.dy){
          for (const o of origins){
            if (!o.shape || o.shape.locked) continue;
            if (o.isLine){
              const curPts = getLineEndpointsStage(o.shape);
              setLineEndpointsStage(o.shape,
                { x: curPts.p1.x + snap.dx, y: curPts.p1.y + snap.dy },
                { x: curPts.p2.x + snap.dx, y: curPts.p2.y + snap.dy }
              );
            } else {
              const p = getShapePos(o.shape);
              setShapePos(o.shape, p.x + snap.dx, p.y + snap.dy);
            }
          }
        }
        state.activeGuideLines = snap.lines;
      }
    } else {
      state.activeGuideLines = null;
    }

    renderDuringDrag();
  }

  function onUp(){
    state.activeGuideLines = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (moved) commitEdit(); else __historySnapshotBeforeEdit = null;
    resyncHoverFromClientPoint(lastClientX, lastClientY);
    renderAll();
  }

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function startLinePointResize(e, id, handle){
  e.preventDefault();
  e.stopPropagation();
  const shape = findShapeById(id);
  if (!shape || shape.locked) return;
  if (e.pointerId != null && DOM.stage.setPointerCapture) DOM.stage.setPointerCapture(e.pointerId);
  beginEdit();

  const isP1 = (handle === 'line-p1');
  const initialEndpoints = getLineEndpointsStage(shape);
  const fixedPt = isP1 ? initialEndpoints.p2 : initialEndpoints.p1;
  let activeSnap = null;

  function onMove(ev){
    const curRaw = clientToStagePoint(ev.clientX, ev.clientY);
    let curX = maybeSnap(curRaw.x);
    let curY = maybeSnap(curRaw.y);

    if (ev.shiftKey){
      const dx = curX - fixedPt.x, dy = curY - fixedPt.y;
      const dist = Math.hypot(dx, dy);
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      curX = fixedPt.x + dist * Math.cos(angle);
      curY = fixedPt.y + dist * Math.sin(angle);
    }

    // Check for magnetic endpoint snapping to other line/path endpoints
    const snapResult = getClosestEndpointSnap({ x: curX, y: curY }, shape.id, 16);
    if (snapResult){
      curX = snapResult.snappedPoint.x;
      curY = snapResult.snappedPoint.y;
      activeSnap = snapResult;
      state.activeEndpointSnap = {
        x: curX,
        y: curY,
        targetShape: snapResult.targetShape
      };
    } else {
      activeSnap = null;
      state.activeEndpointSnap = null;
    }

    if (state.grid.guides && !activeSnap){
      const tempP1 = isP1 ? { x: curX, y: curY } : fixedPt;
      const tempP2 = isP1 ? fixedPt : { x: curX, y: curY };
      const minX = Math.min(tempP1.x, tempP2.x), maxX = Math.max(tempP1.x, tempP2.x);
      const minY = Math.min(tempP1.y, tempP2.y), maxY = Math.max(tempP1.y, tempP2.y);
      const b = { x: minX, y: minY, width: maxX - minX, height: maxY - minY, right: maxX, bottom: maxY, cx: (minX + maxX)/2, cy: (minY + maxY)/2 };
      const guideSnap = computeAlignGuideSnap([shape], b);
      state.activeGuideLines = guideSnap.lines;
    } else {
      state.activeGuideLines = null;
    }

    const newP1 = isP1 ? { x: curX, y: curY } : fixedPt;
    const newP2 = isP1 ? fixedPt : { x: curX, y: curY };
    setLineEndpointsStage(shape, newP1, newP2);

    renderDuringDrag();
  }

  function onUp(){
    state.activeGuideLines = null;
    state.activeEndpointSnap = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (e.pointerId != null && DOM.stage.releasePointerCapture) DOM.stage.releasePointerCapture(e.pointerId);

    if (activeSnap && activeSnap.targetShape){
      const joined = joinTwoShapes(shape, activeSnap.targetShape);
      if (joined){
        showToast('Connected line to ' + (joined.name || 'path'));
      }
    }

    commitEdit();
    renderAll();
  }

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function startPathVertexResize(e, id, vertexIdx){
  e.preventDefault();
  e.stopPropagation();
  const shape = findShapeById(id);
  if (!shape || shape.locked || shape.type !== 'path' || !shape.rawD) return;
  if (e.pointerId != null && DOM.stage.setPointerCapture) DOM.stage.setPointerCapture(e.pointerId);
  beginEdit();

  const sub = parseSvgPathToSubpaths(shape.rawD);
  if (!sub.length || !sub[0].points.length) return;
  const isClosed = sub[0].closed;
  const initialStagePts = sub[0].points.map(p => shapePointToStage(shape, p));
  if (vertexIdx < 0 || vertexIdx >= initialStagePts.length) return;
  let activeSnap = null;

  function onMove(ev){
    const curRaw = clientToStagePoint(ev.clientX, ev.clientY);
    let curX = maybeSnap(curRaw.x);
    let curY = maybeSnap(curRaw.y);

    // Magnetic endpoint snap if dragging first or last vertex of an open path
    const isEndpoint = (vertexIdx === 0 || vertexIdx === initialStagePts.length - 1) && !isClosed;
    if (isEndpoint){
      const snapResult = getClosestEndpointSnap({ x: curX, y: curY }, shape.id, 16);
      if (snapResult){
        curX = snapResult.snappedPoint.x;
        curY = snapResult.snappedPoint.y;
        activeSnap = snapResult;
        state.activeEndpointSnap = {
          x: curX,
          y: curY,
          targetShape: snapResult.targetShape
        };
      } else {
        activeSnap = null;
        state.activeEndpointSnap = null;
      }
    } else {
      activeSnap = null;
      state.activeEndpointSnap = null;
    }

    const currentPts = initialStagePts.slice();
    currentPts[vertexIdx] = { x: curX, y: curY };

    let dStr = 'M' + fmt(currentPts[0].x) + ',' + fmt(currentPts[0].y);
    for (let i = 1; i < currentPts.length; i++){
      dStr += ' L' + fmt(currentPts[i].x) + ',' + fmt(currentPts[i].y);
    }
    if (isClosed) dStr += ' Z';

    shape.rotation = 0;
    shape.scaleX = 1;
    shape.scaleY = 1;
    shape.translateX = 0;
    shape.translateY = 0;
    shape.rawD = dStr;
    const bbox = measurePathBBox(dStr);
    shape.pivotX = bbox.x + bbox.width / 2;
    shape.pivotY = bbox.y + bbox.height / 2;
    shape.nativeWidth = Math.max(0.0001, bbox.width);
    shape.nativeHeight = Math.max(0.0001, bbox.height);

    renderDuringDrag();
  }

  function onUp(){
    state.activeGuideLines = null;
    state.activeEndpointSnap = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (e.pointerId != null && DOM.stage.releasePointerCapture) DOM.stage.releasePointerCapture(e.pointerId);

    if (activeSnap && activeSnap.targetShape){
      const joined = joinTwoShapes(shape, activeSnap.targetShape);
      if (joined){
        showToast('Connected path to ' + (joined.name || 'shape'));
      }
    }

    commitEdit();
    renderAll();
  }

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function startArcAngleDrag(e, id, which){
  e.preventDefault();
  e.stopPropagation();
  const shape = findShapeById(id);
  if (!shape || shape.locked || shape.type !== 'arc') return;
  if (e.pointerId != null && DOM.stage.setPointerCapture) DOM.stage.setPointerCapture(e.pointerId);
  beginEdit();

  function onMove(ev){
    const raw = clientToStagePoint(ev.clientX, ev.clientY);
    const rx = Math.max(0.001, shape.width/2), ry = Math.max(0.001, shape.height/2);
    const cx = shape.x + rx, cy = shape.y + ry;
    const dx = raw.x - cx, dy = raw.y - cy;
    let angleDeg = Math.atan2(dy/ry, dx/rx) * 180 / Math.PI;
    angleDeg = ((angleDeg % 360) + 360) % 360;
    if (ev.shiftKey) angleDeg = Math.round(angleDeg / 15) * 15;

    if (which === 'start'){
      shape.startAngle = angleDeg;
    } else {
      let delta = angleDeg - (shape.startAngle || 0);
      delta = ((delta % 360) + 360) % 360;
      if (delta < 0.1) delta = 360;
      shape.sweepAngle = clamp(delta, 0.1, 360);
    }
    shape.fillEnabled = shape.sector || (shape.innerRadiusPercent||0) > 0 || shape.fillEnabled;
    renderDuringDrag();
  }
  function onUp(){
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (e.pointerId != null && DOM.stage.releasePointerCapture) DOM.stage.releasePointerCapture(e.pointerId);
    commitEdit();
    renderAll();
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function startArcInnerRadiusDrag(e, id){
  e.preventDefault();
  e.stopPropagation();
  const shape = findShapeById(id);
  if (!shape || shape.locked || shape.type !== 'arc') return;
  if (e.pointerId != null && DOM.stage.setPointerCapture) DOM.stage.setPointerCapture(e.pointerId);
  beginEdit();

  function onMove(ev){
    const raw = clientToStagePoint(ev.clientX, ev.clientY);
    const rx = Math.max(0.001, shape.width/2), ry = Math.max(0.001, shape.height/2);
    const cx = shape.x + rx, cy = shape.y + ry;
    const nx = (raw.x - cx) / rx, ny = (raw.y - cy) / ry;
    const ratio = Math.hypot(nx, ny);
    shape.innerRadiusPercent = clamp(ratio * 100, 0, 95);
    renderDuringDrag();
  }
  function onUp(){
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (e.pointerId != null && DOM.stage.releasePointerCapture) DOM.stage.releasePointerCapture(e.pointerId);
    commitEdit();
    renderAll();
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function startCurveControlPointResize(e, id, handle){
  e.preventDefault();
  e.stopPropagation();
  const shape = findShapeById(id);
  if (!shape || shape.locked || shape.type !== 'curve') return;
  if (e.pointerId != null && DOM.stage.setPointerCapture) DOM.stage.setPointerCapture(e.pointerId);
  beginEdit();

  const isCp1 = (handle === 'curve-cp1');
  function onMove(ev){
    const curRaw = clientToStagePoint(ev.clientX, ev.clientY);
    let curX = maybeSnap(curRaw.x);
    let curY = maybeSnap(curRaw.y);
    if (isCp1){
      shape.cp1x = curX;
      shape.cp1y = curY;
    } else {
      shape.cp2x = curX;
      shape.cp2y = curY;
    }
    recomputeCurveBounds(shape);
    renderDuringDrag();
  }
  function onUp(){
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (e.pointerId != null && DOM.stage.releasePointerCapture) DOM.stage.releasePointerCapture(e.pointerId);
    commitEdit();
    renderAll();
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function startCurveEndpointResize(e, id, handle){
  e.preventDefault();
  e.stopPropagation();
  const shape = findShapeById(id);
  if (!shape || shape.locked || shape.type !== 'curve') return;
  if (e.pointerId != null && DOM.stage.setPointerCapture) DOM.stage.setPointerCapture(e.pointerId);
  beginEdit();

  const isP1 = (handle === 'curve-p1');
  // Capture the ORIGINAL point + its control handle once, at drag start. Every subsequent
  // move recomputes from these fixed originals — never from the shape's already-mutated
  // current values, or the offset would compound every pointermove tick and the curve
  // would balloon outward the longer you drag.
  const origP = isP1 ? { x: shape.x1, y: shape.y1 } : { x: shape.x2, y: shape.y2 };
  const origCp = isP1 ? { x: shape.cp1x, y: shape.cp1y } : { x: shape.cp2x, y: shape.cp2y };

  function onMove(ev){
    const curRaw = clientToStagePoint(ev.clientX, ev.clientY);
    let curX = maybeSnap(curRaw.x);
    let curY = maybeSnap(curRaw.y);
    const dx = curX - origP.x, dy = curY - origP.y;

    if (isP1){
      shape.x1 = curX;
      shape.y1 = curY;
      shape.cp1x = (origCp.x != null ? origCp.x : curX) + dx * 0.5;
      shape.cp1y = (origCp.y != null ? origCp.y : curY) + dy * 0.5;
    } else {
      shape.x2 = curX;
      shape.y2 = curY;
      shape.cp2x = (origCp.x != null ? origCp.x : curX) + dx * 0.5;
      shape.cp2y = (origCp.y != null ? origCp.y : curY) + dy * 0.5;
    }
    recomputeCurveBounds(shape);
    renderDuringDrag();
  }
  function onUp(){
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (e.pointerId != null && DOM.stage.releasePointerCapture) DOM.stage.releasePointerCapture(e.pointerId);
    commitEdit();
    renderAll();
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function startNodeDrag(e, shapeId, nodeIdx, handleType){
  e.preventDefault();
  e.stopPropagation();
  const shape = findShapeById(shapeId);
  if (!shape || shape.locked || shape.type !== 'path' || !shape.rawD) return;
  if (e.pointerId != null && DOM.stage.setPointerCapture) DOM.stage.setPointerCapture(e.pointerId);
  beginEdit();

  const nodes = parseSvgPathToNodes(shape.rawD);
  if (nodeIdx < 0 || nodeIdx >= nodes.length) return;
  const targetNode = nodes[nodeIdx];
  state.nodeEdit.shapeId = shape.id;
  state.nodeEdit.selectedNodeIndex = nodeIdx;

  const origAnchor = { x: targetNode.x, y: targetNode.y };
  const origCp1 = targetNode.cp1 ? { x: targetNode.cp1.x, y: targetNode.cp1.y } : null;
  const origCp2 = targetNode.cp2 ? { x: targetNode.cp2.x, y: targetNode.cp2.y } : null;

  function onMove(ev){
    const curRaw = clientToStagePoint(ev.clientX, ev.clientY);
    let curX = maybeSnap(curRaw.x);
    let curY = maybeSnap(curRaw.y);

    if (handleType === 'anchor'){
      const dx = curX - origAnchor.x, dy = curY - origAnchor.y;
      targetNode.x = curX;
      targetNode.y = curY;
      if (origCp1){ targetNode.cp1.x = origCp1.x + dx; targetNode.cp1.y = origCp1.y + dy; }
      if (origCp2){ targetNode.cp2.x = origCp2.x + dx; targetNode.cp2.y = origCp2.y + dy; }
    } else if (handleType === 'cp1'){
      targetNode.cp1 = { x: curX, y: curY };
      if (targetNode.type === 'smooth' && origCp2){
        const dx = targetNode.x - curX, dy = targetNode.y - curY;
        const len2 = Math.hypot(origCp2.x - targetNode.x, origCp2.y - targetNode.y) || 2;
        const len1 = Math.hypot(dx, dy) || 1;
        targetNode.cp2 = {
          x: targetNode.x + (dx / len1) * len2,
          y: targetNode.y + (dy / len1) * len2
        };
      }
    } else if (handleType === 'cp2'){
      targetNode.cp2 = { x: curX, y: curY };
      if (targetNode.type === 'smooth' && origCp1){
        const dx = targetNode.x - curX, dy = targetNode.y - curY;
        const len1 = Math.hypot(origCp1.x - targetNode.x, origCp1.y - targetNode.y) || 2;
        const len2 = Math.hypot(dx, dy) || 1;
        targetNode.cp1 = {
          x: targetNode.x + (dx / len2) * len1,
          y: targetNode.y + (dy / len2) * len1
        };
      }
    }

    const updatedD = nodesToPathData(nodes);
    shape.rawD = updatedD;
    const bbox = measurePathBBox(updatedD);
    shape.pivotX = bbox.x + bbox.width / 2;
    shape.pivotY = bbox.y + bbox.height / 2;
    shape.nativeWidth = Math.max(0.0001, bbox.width);
    shape.nativeHeight = Math.max(0.0001, bbox.height);

    renderDuringDrag();
  }

  function onUp(){
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (e.pointerId != null && DOM.stage.releasePointerCapture) DOM.stage.releasePointerCapture(e.pointerId);
    commitEdit();
    renderAll();
  }

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function toggleNodeCornerSmooth(shapeId, nodeIdx){
  const shape = findShapeById(shapeId);
  if (!shape || shape.type !== 'path' || !shape.rawD) return;
  const nodes = parseSvgPathToNodes(shape.rawD);
  if (nodeIdx < 0 || nodeIdx >= nodes.length) return;
  doAction(() => {
    const node = nodes[nodeIdx];
    if (node.type === 'smooth' || node.cp1 || node.cp2){
      node.type = 'corner';
      node.cp1 = null;
      node.cp2 = null;
    } else {
      node.type = 'smooth';
      const prev = nodes[(nodeIdx - 1 + nodes.length) % nodes.length];
      const next = nodes[(nodeIdx + 1) % nodes.length];
      const dx = next.x - prev.x, dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 4;
      const hx = (dx / len) * (len * 0.25);
      const hy = (dy / len) * (len * 0.25);
      node.cp1 = { x: node.x - hx, y: node.y - hy };
      node.cp2 = { x: node.x + hx, y: node.y + hy };
    }
    shape.rawD = nodesToPathData(nodes);
    showToast(`Converted node to ${node.type === 'smooth' ? 'Smooth Curve' : 'Corner / Straight'}`);
  });
  renderAll();
}

function deleteNodeFromPath(shapeId, nodeIdx){
  const shape = findShapeById(shapeId);
  if (!shape || shape.type !== 'path' || !shape.rawD) return;
  const nodes = parseSvgPathToNodes(shape.rawD);
  if (nodes.length <= 2){
    showToast('A path must have at least 2 points');
    return;
  }
  if (nodeIdx < 0 || nodeIdx >= nodes.length) return;
  doAction(() => {
    nodes.splice(nodeIdx, 1);
    shape.rawD = nodesToPathData(nodes);
    const bbox = measurePathBBox(shape.rawD);
    shape.pivotX = bbox.x + bbox.width / 2;
    shape.pivotY = bbox.y + bbox.height / 2;
    shape.nativeWidth = Math.max(0.0001, bbox.width);
    shape.nativeHeight = Math.max(0.0001, bbox.height);
    state.nodeEdit.selectedNodeIndex = Math.min(nodeIdx, nodes.length - 1);
    showToast('Deleted point from path');
  });
  renderAll();
}

function addNodeToPath(shapeId, x, y){
  const shape = findShapeById(shapeId);
  if (!shape || shape.type !== 'path' || !shape.rawD) return;
  const nodes = parseSvgPathToNodes(shape.rawD);
  if (nodes.length < 2) return;

  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < nodes.length; i++){
    const n1 = nodes[i];
    const n2 = nodes[(i + 1) % nodes.length];
    const dist = distToSegment({ x, y }, n1, n2);
    if (dist < bestDist){
      bestDist = dist;
      bestIdx = i + 1;
    }
  }

  doAction(() => {
    const newNode = {
      type: 'corner',
      x: maybeSnap(x),
      y: maybeSnap(y),
      cp1: null,
      cp2: null
    };
    nodes.splice(bestIdx, 0, newNode);
    shape.rawD = nodesToPathData(nodes);
    const bbox = measurePathBBox(shape.rawD);
    shape.pivotX = bbox.x + bbox.width / 2;
    shape.pivotY = bbox.y + bbox.height / 2;
    shape.nativeWidth = Math.max(0.0001, bbox.width);
    shape.nativeHeight = Math.max(0.0001, bbox.height);
    state.nodeEdit.shapeId = shape.id;
    state.nodeEdit.selectedNodeIndex = bestIdx;
    showToast('Added point to path');
  });
  renderAll();
}

function distToSegment(p, v, w){
  const l2 = (w.x - v.x)*(w.x - v.x) + (w.y - v.y)*(w.y - v.y);
  if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
  let t = ((p.x - v.x)*(w.x - v.x) + (p.y - v.y)*(w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
}

function convertShapeToPathShape(shape){
  if (shape.type === 'path') return shape;
  const d = shapePathData(shape);
  // Remember that this path started life as text: it's typically many small subpaths
  // (one or more per glyph, often with hole/counter contours like the inside of an "o" or
  // "e"). The normal hover ring traces every subpath by stroking it, which reads fine for
  // a single simple silhouette but turns into a mess of extra rings around every letter's
  // counters for compound glyph outlines — so these keep using the plain-rectangle hover
  // outline (see updateHoverOutline) even after conversion, same as while still live text.
  if (shape.type === 'text') shape.__fromText = true;
  shape.type = 'path';
  shape.rawD = d;
  const bbox = measurePathBBox(d);
  shape.pivotX = bbox.x + bbox.width / 2;
  shape.pivotY = bbox.y + bbox.height / 2;
  shape.nativeWidth = Math.max(0.0001, bbox.width);
  shape.nativeHeight = Math.max(0.0001, bbox.height);
  return shape;
}

function smoothCurveShape(shape){
  if (shape.type !== 'curve') return;
  const dx = shape.x2 - shape.x1, dy = shape.y2 - shape.y1;
  const dist = Math.hypot(dx, dy);
  const nx = -dy / (dist || 1), ny = dx / (dist || 1);
  const curvature = dist * 0.35;
  shape.cp1x = shape.x1 + dx * 0.25 + nx * curvature;
  shape.cp1y = shape.y1 + dy * 0.25 + ny * curvature;
  shape.cp2x = shape.x1 + dx * 0.75 + nx * curvature;
  shape.cp2y = shape.y1 + dy * 0.75 + ny * curvature;
  recomputeCurveBounds(shape);
}

function straightenCurveShape(shape){
  if (shape.type !== 'curve') return;
  shape.cp1x = shape.x1 + (shape.x2 - shape.x1) / 3;
  shape.cp1y = shape.y1 + (shape.y2 - shape.y1) / 3;
  shape.cp2x = shape.x1 + (shape.x2 - shape.x1) * 2 / 3;
  shape.cp2y = shape.y1 + (shape.y2 - shape.y1) * 2 / 3;
  recomputeCurveBounds(shape);
}

function convertLineToCurveShape(lineShape){
  const pts = getLineEndpointsStage(lineShape);
  const curve = createCurveShape(pts.p1.x, pts.p1.y, pts.p2.x, pts.p2.y);
  curve.strokeEnabled = lineShape.strokeEnabled;
  curve.strokeColor = lineShape.strokeColor;
  curve.strokeWidth = lineShape.strokeWidth;
  curve.strokeOpacity = lineShape.strokeOpacity;
  curve.strokeLineCap = lineShape.strokeLineCap;
  curve.strokeLineJoin = lineShape.strokeLineJoin;
  curve.groupId = lineShape.groupId;
  const idx = state.shapes.indexOf(lineShape);
  if (idx >= 0) state.shapes.splice(idx, 1, curve);
  else state.shapes.push(curve);
  state.selectedIds = [curve.id];
  return curve;
}

function startDrawArc(e){
  const raw = clientToStagePoint(e.clientX, e.clientY);
  const point = { x: maybeSnap(raw.x), y: maybeSnap(raw.y) };
  if (!state.arcDraft){
    state.arcDraft = point;
    state.arcHoverPoint = point;
    showToast('Arc start set — move to preview, click the second endpoint');
    renderStage();
    return;
  }

  const start = state.arcDraft;
  const dx = point.x - start.x, dy = point.y - start.y;
  const chord = Math.hypot(dx, dy);
  if (chord < MIN_SHAPE_SIZE * 0.25){
    showToast('Choose a second point farther from the first');
    return;
  }
  // Two endpoints form the diameter of a clean semicircular arc. The usual arc
  // controls in Geometry can then change the sweep, sector, or ring settings.
  const radius = chord / 2;
  const cx = (start.x + point.x) / 2, cy = (start.y + point.y) / 2;
  const startAngle = Math.atan2(start.y - cy, start.x - cx) * 180 / Math.PI;
  const shape = createArcShape(cx-radius, cy-radius, chord, chord, startAngle, 180, false, 0);
  doAction(() => {
    state.shapes.push(shape);
    state.selectedIds = [shape.id];
    state.arcDraft = null;
    state.arcHoverPoint = null;
  });
  setTool('node');
  switchTab('design');
  renderAll();
  showToast('Arc created — drag the teal/amber handles on canvas to adjust it');
}

function startDrawCurve(e){
  const raw = clientToStagePoint(e.clientX, e.clientY);
  const point = { x: maybeSnap(raw.x), y: maybeSnap(raw.y) };

  // Snap to existing endpoints just like the line tool, so curves can connect cleanly.
  const snap = getClosestEndpointSnap(point, null, 16);
  if (snap){ point.x = snap.snappedPoint.x; point.y = snap.snappedPoint.y; }

  if (!state.curveDraft){
    state.curveDraft = point;
    state.curveHoverPoint = point;
    showToast('Curve start point set — move to preview, click the second point');
    renderStage();
    return;
  }

  const p1 = state.curveDraft;
  const p2 = point;
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (dist < MIN_SHAPE_SIZE * 0.25){
    showToast('Choose a second point farther from the first');
    return;
  }

  const shape = createCurveShape(p1.x, p1.y, p2.x, p2.y);
  if (state.lastStrokeColor) shape.strokeColor = state.lastStrokeColor;
  if (state.lastStrokeWidth) shape.strokeWidth = state.lastStrokeWidth;
  doAction(() => {
    state.shapes.push(shape);
    state.selectedIds = [shape.id];
    state.curveDraft = null;
    state.curveHoverPoint = null;
  });
  setTool('node');
  switchTab('design');
  renderAll();
  showToast('Curve created — drag the blue diamond handles to shape it');
}

/* ---------------- Cut tool: drag a shape over existing artwork to slice a piece out ---------------- */
/* ---------------- Cut tool: click points to trace a cutting shape (just like the Pen
   tool), close the loop, and it slices that area out of whatever's underneath. ---------------- */
function cutToolClick(e){
  const stagePt = clientToStagePoint(e.clientX, e.clientY);
  const pt = { x: maybeSnap(stagePt.x), y: maybeSnap(stagePt.y) };
  if (!state.cutActive){
    state.cutActive = true;
    state.cutPoints = [pt];
    renderCutOverlay();
    showToast('Cut path started — click to add points, click the first point (or double-click) to cut');
    return;
  }
  const first = state.cutPoints[0];
  const screenFirst = stageToClientPoint(first.x, first.y);
  const distScreen = Math.hypot(e.clientX-screenFirst.x, e.clientY-screenFirst.y);
  if (state.cutPoints.length >= 2 && distScreen < 9){ finalizeCut(); return; }
  state.cutPoints.push(pt);
  renderCutOverlay();
}

function finalizeCut(){
  if (state.cutPoints.length < 3){
    showToast('Add at least 3 points to trace a cutting area');
    cancelCut();
    return;
  }
  const pts = state.cutPoints;
  let d = 'M'+fmt(pts[0].x)+','+fmt(pts[0].y);
  for (let i=1;i<pts.length;i++) d += ' L'+fmt(pts[i].x)+','+fmt(pts[i].y);
  d += ' Z';
  state.cutActive = false; state.cutPoints = []; state.cutPreview = null;
  renderCutOverlay();

  const cutShape = createPathShape(d, { fillEnabled: true, strokeEnabled: false });
  performCutOperation(cutShape);
  setTool('select');
  switchTab('design');
  renderAll();
}

function cancelCut(){
  state.cutActive = false; state.cutPoints = []; state.cutPreview = null;
  renderCutOverlay();
}

function renderCutOverlay(){
  const existing = gOverlay.querySelector('#cutPreviewGroup');
  if (existing) existing.remove();
  if (!state.cutActive || !state.cutPoints.length) return;
  const g = svgEl('g', { id:'cutPreviewGroup' });
  let d = 'M'+fmt(state.cutPoints[0].x)+','+fmt(state.cutPoints[0].y);
  for (let i=1;i<state.cutPoints.length;i++) d += ' L'+fmt(state.cutPoints[i].x)+','+fmt(state.cutPoints[i].y);
  if (state.cutPreview) d += ' L'+fmt(state.cutPreview.x)+','+fmt(state.cutPreview.y);
  g.appendChild(svgEl('path', { d, fill:'#FF6B6B', 'fill-opacity':0.18, stroke:'#FF6B6B', 'stroke-width':1.3, 'vector-effect':'non-scaling-stroke', 'stroke-dasharray':'4 3' }));
  const r = 4.2/(PX_PER_UNIT*state.view.zoom);
  for (const p of state.cutPoints){
    g.appendChild(svgEl('circle', { cx:p.x, cy:p.y, r, fill:'#151824', stroke:'#FF6B6B', 'stroke-width':1.4, 'vector-effect':'non-scaling-stroke' }));
  }
  gOverlay.appendChild(g);
}

function rectsOverlap(a, b){
  return a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
}

/* Cuts `cutShape` out of every unlocked, visible shape underneath it, reusing the
   same polygon-clipping engine that powers the Boolean panel's Subtract op. */
function performCutOperation(cutShape){
  const cutBounds = getShapeStageBounds(cutShape);
  const targets = state.shapes.filter(s =>
    s.id !== cutShape.id && s.visible && !s.locked && rectsOverlap(getShapeStageBounds(s), cutBounds)
  );

  if (!targets.length){
    doAction(() => { deleteShapesByIds([cutShape.id]); });
    showToast('Nothing under the cut area — draw the cut over a shape');
    return;
  }

  const cutRings = getShapeVisualRings(cutShape);
  let cutCount = 0;

  doAction(() => {
    for (const target of targets){
      try {
        const targetRings = getShapeVisualRings(target);
        let resultRings = [];
        for (const rA of targetRings){
          for (const rB of cutRings){
            resultRings.push(...clipTwoPolygonRings(rA, rB, 'subtract'));
          }
        }
        if (!resultRings.length) continue; // fully cut away — leave as-is rather than delete silently
        const finalD = polygonRingsToPath(resultRings);
        if (!finalD || finalD === 'M0,0') continue;

        const idx = shapeIndex(target.id);
        const fillCol = target.fillEnabled ? target.fillColor : (target.strokeEnabled ? target.strokeColor : '#5EE1A0');
        const fillOp = target.fillEnabled ? target.fillOpacity : (target.strokeEnabled ? target.strokeOpacity : 1);
        const newShape = createPathShape(finalD, {
          name: target.name ? target.name + ' (cut)' : 'Shape (cut)',
          fillEnabled: true,
          fillColor: fillCol,
          fillOpacity: fillOp,
          fillType: 'evenOdd',
          strokeEnabled: false,
          groupId: target.groupId,
        });
        inheritPaintFrom(newShape, target);
        state.shapes.splice(idx, 1, newShape);
        const selIdx = state.selectedIds.indexOf(target.id);
        if (selIdx >= 0) state.selectedIds.splice(selIdx, 1, newShape.id);
        cutCount++;
      } catch (err){
        console.error('Cut operation failed for shape', target.id, err);
      }
    }
    deleteShapesByIds([cutShape.id]);
  });

  showToast(cutCount ? `Cut through ${cutCount} shape${cutCount!==1?'s':''}` : 'Cut area didn\u2019t remove any visible fill');
}

function startResize(e, id, handle){
  e.preventDefault();
  e.stopPropagation();
  const shape = findShapeById(id);
  if (!shape || shape.locked) return;
  if (isLineShape(shape)){
    // If somehow triggered on line, delegate to endpoint resize
    startLinePointResize(e, id, 'line-p2');
    return;
  }
  if (e.pointerId != null && DOM.stage.setPointerCapture) DOM.stage.setPointerCapture(e.pointerId);
  beginEdit();
  const liveXform = gShapes.querySelector('.shape-node[data-id="'+id+'"] .shape-xform');
  if (!liveXform) return;
  const pivot = shapeLocalPivot(shape);
  const localBounds = localBBoxForShape(shape);
  const orig = {
    scaleX: shape.scaleX,
    scaleY: shape.scaleY,
    translateX: shape.translateX||0,
    translateY: shape.translateY||0,
    width: localBounds.width,
    height: localBounds.height,
  };
  function toLocal(clientX, clientY){
    const stagePoint = clientToStagePoint(clientX, clientY);
    const dx = stagePoint.x - (pivot.x + orig.translateX);
    const dy = stagePoint.y - (pivot.y + orig.translateY);
    const angle = -(shape.rotation||0) * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    return { x: pivot.x + dx*cos - dy*sin, y: pivot.y + dx*sin + dy*cos };
  }

  function onMove(ev){
    const local = toLocal(ev.clientX, ev.clientY);
    if (shape.type === 'rect' && orig.scaleX === 1 && orig.scaleY === 1){
      let left = localBounds.x, right = localBounds.x + localBounds.width;
      let top = localBounds.y, bottom = localBounds.y + localBounds.height;
      if (handle.indexOf('e') >= 0) right = local.x;
      if (handle.indexOf('w') >= 0) left = local.x;
      if (handle.indexOf('s') >= 0) bottom = local.y;
      if (handle.indexOf('n') >= 0) top = local.y;

      let newW = Math.max(MIN_SHAPE_SIZE, right - left);
      let newH = Math.max(MIN_SHAPE_SIZE, bottom - top);

      if (ev.shiftKey && handle.length === 2 && orig.width > 1e-6 && orig.height > 1e-6){
        const ratioX = newW / orig.width;
        const ratioY = newH / orig.height;
        const k = Math.max(ratioX, ratioY);
        newW = Math.max(MIN_SHAPE_SIZE, orig.width * k);
        newH = Math.max(MIN_SHAPE_SIZE, orig.height * k);
        if (handle === 'se'){ right = left + newW; bottom = top + newH; }
        else if (handle === 'sw'){ left = right - newW; bottom = top + newH; }
        else if (handle === 'ne'){ right = left + newW; top = bottom - newH; }
        else if (handle === 'nw'){ left = right - newW; top = bottom - newH; }
      } else {
        if (right - left < MIN_SHAPE_SIZE){
          if (handle.indexOf('w') >= 0) left = right - MIN_SHAPE_SIZE;
          else right = left + MIN_SHAPE_SIZE;
        }
        if (bottom - top < MIN_SHAPE_SIZE){
          if (handle.indexOf('n') >= 0) top = bottom - MIN_SHAPE_SIZE;
          else bottom = top + MIN_SHAPE_SIZE;
        }
      }
      shape.x = left;
      shape.y = top;
      shape.width = right - left;
      shape.height = bottom - top;
      renderDuringDrag();
      return;
    }
    let sx = orig.scaleX, sy = orig.scaleY;
    const hw = orig.width/2 || 0.0001, hh = orig.height/2 || 0.0001;
    const initialRight = pivot.x + hw * orig.scaleX;
    const initialLeft = pivot.x - hw * orig.scaleX;
    const initialBottom = pivot.y + hh * orig.scaleY;
    const initialTop = pivot.y - hh * orig.scaleY;
    if (handle.indexOf('e') >= 0) sx = orig.scaleX + (local.x - initialRight) / orig.width;
    if (handle.indexOf('w') >= 0) sx = orig.scaleX + (initialLeft - local.x) / orig.width;
    if (handle.indexOf('s') >= 0) sy = orig.scaleY + (local.y - initialBottom) / orig.height;
    if (handle.indexOf('n') >= 0) sy = orig.scaleY + (initialTop - local.y) / orig.height;
    if (ev.shiftKey && handle.length === 2){
      const ratioX = (orig.width * Math.abs(orig.scaleX)) > 1e-6 ? Math.abs(sx / orig.scaleX) : 1;
      const ratioY = (orig.height * Math.abs(orig.scaleY)) > 1e-6 ? Math.abs(sy / orig.scaleY) : 1;
      const k = Math.max(ratioX, ratioY);
      sx = Math.sign(sx || 1) * Math.abs(orig.scaleX) * k;
      sy = Math.sign(sy || 1) * Math.abs(orig.scaleY) * k;
    }
    if (Math.abs(sx) < 0.02) sx = sx < 0 ? -0.02 : 0.02;
    if (Math.abs(sy) < 0.02) sy = sy < 0 ? -0.02 : 0.02;
    shape.scaleX = Math.round(sx*1000)/1000;
    shape.scaleY = Math.round(sy*1000)/1000;
    const anchorX = handle.indexOf('e') >= 0 ? localBounds.x : handle.indexOf('w') >= 0 ? localBounds.x+localBounds.width : pivot.x;
    const anchorY = handle.indexOf('s') >= 0 ? localBounds.y : handle.indexOf('n') >= 0 ? localBounds.y+localBounds.height : pivot.y;
    const localDx = (orig.scaleX-sx) * (anchorX-pivot.x);
    const localDy = (orig.scaleY-sy) * (anchorY-pivot.y);
    const rotation = (shape.rotation||0) * Math.PI / 180;
    shape.translateX = orig.translateX + localDx*Math.cos(rotation) - localDy*Math.sin(rotation);
    shape.translateY = orig.translateY + localDx*Math.sin(rotation) + localDy*Math.cos(rotation);
    renderDuringDrag();
  }
  function onUp(){
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (e.pointerId != null && DOM.stage.releasePointerCapture) DOM.stage.releasePointerCapture(e.pointerId);
    commitEdit();
    renderAll();
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function startRotate(e, id){
  e.stopPropagation();
  const shape = findShapeById(id);
  if (!shape || shape.locked) return;
  beginEdit();
  const pivotLocal = shapeLocalPivot(shape);
  const pivotStageX = pivotLocal.x + (shape.translateX||0), pivotStageY = pivotLocal.y + (shape.translateY||0);
  const pivotScreen = stageToClientPoint(pivotStageX, pivotStageY);
  const startAngle = Math.atan2(e.clientY-pivotScreen.y, e.clientX-pivotScreen.x);
  const startRotation = shape.rotation;
  let lastClientX = e.clientX, lastClientY = e.clientY;
  function onMove(ev){
    lastClientX = ev.clientX; lastClientY = ev.clientY;
    const curAngle = Math.atan2(ev.clientY-pivotScreen.y, ev.clientX-pivotScreen.x);
    let deg = startRotation + (curAngle-startAngle)*180/Math.PI;
    if (ev.shiftKey) deg = Math.round(deg/15)*15;
    deg = ((deg+180) % 360 + 360) % 360 - 180;
    shape.rotation = Math.round(deg*100)/100;
    renderDuringDrag();
  }
  function onUp(){
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    commitEdit();
    resyncHoverFromClientPoint(lastClientX, lastClientY);
    renderAll();
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function startDraw(e, type){
  beginEdit();
  const startStage = clientToStagePoint(e.clientX, e.clientY);
  const x0 = maybeSnap(startStage.x), y0 = maybeSnap(startStage.y);
  let shape;
  if (type === 'rect') shape = createRectShape(x0, y0, 0.001, 0.001);
  else if (type === 'ellipse') shape = createEllipseShape(x0, y0, 0.001, 0.001);
  else shape = createPolygonShape(x0, y0, 0.001, 0.001);
  if (state.lastFillColor) shape.fillColor = state.lastFillColor;
  if (state.lastStrokeColor) shape.strokeColor = state.lastStrokeColor;
  if (state.lastStrokeWidth) shape.strokeWidth = state.lastStrokeWidth;
  state.shapes.push(shape);
  state.selectedIds = [shape.id];
  renderAll();

  let dragged = false;
  function onMove(ev){
    const cur = clientToStagePoint(ev.clientX, ev.clientY);
    let cx = maybeSnap(cur.x), cy = maybeSnap(cur.y);
    let w = cx - x0, h = cy - y0;
    if (Math.abs(w) > 0.04 || Math.abs(h) > 0.04) dragged = true;
    if (ev.shiftKey){
      const m = Math.max(Math.abs(w), Math.abs(h));
      w = (w < 0 ? -1 : 1) * m; h = (h < 0 ? -1 : 1) * m;
    }
    let x, y, width, height;
    if (ev.altKey){
      const halfW = Math.abs(w), halfH = Math.abs(h);
      x = x0 - halfW; y = y0 - halfH; width = halfW*2; height = halfH*2;
    } else {
      x = w < 0 ? x0+w : x0; y = h < 0 ? y0+h : y0;
      width = Math.abs(w); height = Math.abs(h);
    }
    shape.x = x; shape.y = y; shape.width = Math.max(0.001,width); shape.height = Math.max(0.001,height);
    if (state.grid.guides){
      const b = getShapeVisualStageBounds(shape);
      const snap = computeAlignGuideSnap([shape], b);
      state.activeGuideLines = snap.lines;
    } else {
      state.activeGuideLines = null;
    }
    renderDuringDrag();
  }
  function onUp(){
    state.activeGuideLines = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (!dragged){
      const d = Math.max(1, Math.min(state.doc.viewportWidth, state.doc.viewportHeight) * 0.34);
      shape.x = x0 - d/2; shape.y = y0 - d/2; shape.width = d; shape.height = d;
    }
    shape.width = Math.max(MIN_SHAPE_SIZE, shape.width);
    shape.height = Math.max(MIN_SHAPE_SIZE, shape.height);
    commitEdit();
    setTool('select');
    switchTab('design');
    renderAll();
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function startDrawLine(e){
  const startRaw = clientToStagePoint(e.clientX, e.clientY);
  let x0 = maybeSnap(startRaw.x), y0 = maybeSnap(startRaw.y);

  if (!state.lineDraft){
    // Check if the start point snaps to an existing endpoint
    const startSnap = getClosestEndpointSnap({ x: x0, y: y0 }, null, 16);
    if (startSnap){ x0 = startSnap.snappedPoint.x; y0 = startSnap.snappedPoint.y; }
    state.lineDraft = { x: x0, y: y0, snap: startSnap || null };
    state.lineHoverPoint = { x: x0, y: y0 };
    showToast('Line start point set — click the end point');
    renderStage();
    return;
  }

  const start = state.lineDraft;
  let x1 = maybeSnap(startRaw.x), y1 = maybeSnap(startRaw.y);
  if (e.shiftKey){
    const dx = x1 - start.x, dy = y1 - start.y;
    const dist = Math.hypot(dx, dy);
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    x1 = start.x + dist * Math.cos(angle);
    y1 = start.y + dist * Math.sin(angle);
  }
  const endSnap = getClosestEndpointSnap({ x: x1, y: y1 }, null, 16);
  if (endSnap){ x1 = endSnap.snappedPoint.x; y1 = endSnap.snappedPoint.y; }

  if (Math.hypot(x1 - start.x, y1 - start.y) < MIN_SHAPE_SIZE * 0.1){
    showToast('Choose an end point farther from the start');
    return;
  }

  const shape = createLineShape(start.x, start.y, x1, y1);
  if (state.lastStrokeColor) shape.strokeColor = state.lastStrokeColor;
  if (state.lastStrokeWidth) shape.strokeWidth = state.lastStrokeWidth;

  doAction(() => {
    state.shapes.push(shape);
    state.selectedIds = [shape.id];

    let connectedShape = shape;
    if (endSnap && endSnap.targetShape){
      const joined = joinTwoShapes(connectedShape, endSnap.targetShape);
      if (joined) connectedShape = joined;
    }
    if (start.snap && start.snap.targetShape && start.snap.targetShape.id !== (endSnap ? endSnap.targetShape.id : null)){
      const joined = joinTwoShapes(connectedShape, start.snap.targetShape);
      if (joined) connectedShape = joined;
    }

    state.lineDraft = null;
    state.lineHoverPoint = null;
    state.activeEndpointSnap = null;
  });
  setTool('select');
  switchTab('design');
  renderAll();
  showToast('Line created');
}

function startMarquee(e){
  const startStage = clientToStagePoint(e.clientX, e.clientY);
  const rectEl = svgEl('rect', { class:'marquee', x:startStage.x, y:startStage.y, width:0, height:0 });
  gOverlay.appendChild(rectEl);
  function onMove(ev){
    const cur = clientToStagePoint(ev.clientX, ev.clientY);
    const x = Math.min(startStage.x, cur.x), y = Math.min(startStage.y, cur.y);
    const w = Math.abs(cur.x-startStage.x), h = Math.abs(cur.y-startStage.y);
    rectEl.setAttribute('x',x); rectEl.setAttribute('y',y); rectEl.setAttribute('width',w); rectEl.setAttribute('height',h);
    const ids = [];
    for (const shape of state.shapes){
      if (!shape.visible || shape.locked) continue;
      const node = gShapes.querySelector('.shape-node[data-id="'+shape.id+'"]');
      if (!node) continue;
      const bb = node.getBBox();
      const intersects = !(bb.x > x+w || bb.x+bb.width < x || bb.y > y+h || bb.y+bb.height < y);
      if (intersects) ids.push(shape.id);
    }
    state.selectedIds = ids;
    renderSelectionOverlay();
    gOverlay.appendChild(rectEl);
  }
  function onUp(){
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (rectEl.parentNode) rectEl.remove();
    renderAll();
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/* ---------------- pen tool ---------------- */
// Text tool: a plain click-to-place, unlike the drag-to-size shape tools — text has no
// natural "size" to drag out, it's sized by font-size instead. Places a shape at the click
// point, hands off to the Select tool immediately, and kicks off the (async) first outline
// generation so the actual glyphs pop in as soon as the font file is fetched and parsed.
function textToolClick(e){
  const pt = clientToStagePoint(e.clientX, e.clientY);
  const shape = createTextShape(pt.x, pt.y);
  doAction(() => {
    state.shapes.push(shape);
    state.selectedIds = [shape.id];
  });
  setTool('select');
  renderAll();
  regenerateTextPath(shape).then(() => renderAll()).catch(err => {
    showToast('Could not load the default font: ' + err.message);
    renderAll();
  });
  fetchGoogleFontsList().then(() => { if (selectedShapes().includes(shape)) renderPropertiesPanel(); }).catch(() => {});
  requestAnimationFrame(() => {
    const ta = document.querySelector('#selectionPanels textarea[data-field="textContent"]');
    if (ta){ ta.focus(); ta.select(); }
  });
}
function penClick(e){
  const stagePt = clientToStagePoint(e.clientX, e.clientY);
  const pt = { x: maybeSnap(stagePt.x), y: maybeSnap(stagePt.y) };
  if (!state.penActive){
    state.penActive = true;
    state.penPoints = [pt];
    renderPenOverlay();
    return;
  }
  const first = state.penPoints[0];
  const screenFirst = stageToClientPoint(first.x, first.y);
  const distScreen = Math.hypot(e.clientX-screenFirst.x, e.clientY-screenFirst.y);
  if (state.penPoints.length >= 2 && distScreen < 9){ finalizePen(true); return; }
  state.penPoints.push(pt);
  renderPenOverlay();
}
function penMouseMove(e){
  if (state.tool === 'arc' && state.arcDraft){
    const raw = clientToStagePoint(e.clientX, e.clientY);
    state.arcHoverPoint = { x: maybeSnap(raw.x), y: maybeSnap(raw.y) };
    renderStage();
  }
  if (state.tool === 'curve' && state.curveDraft){
    const raw = clientToStagePoint(e.clientX, e.clientY);
    state.curveHoverPoint = { x: maybeSnap(raw.x), y: maybeSnap(raw.y) };
    renderStage();
  }
  if (state.tool === 'line' && state.lineDraft){
    const raw = clientToStagePoint(e.clientX, e.clientY);
    let cx = maybeSnap(raw.x), cy = maybeSnap(raw.y);
    const x0 = state.lineDraft.x, y0 = state.lineDraft.y;
    if (e.shiftKey){
      const dx = cx - x0, dy = cy - y0;
      const dist = Math.hypot(dx, dy);
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      cx = x0 + dist * Math.cos(angle);
      cy = y0 + dist * Math.sin(angle);
    }
    const snapResult = getClosestEndpointSnap({ x: cx, y: cy }, null, 16);
    if (snapResult){
      cx = snapResult.snappedPoint.x;
      cy = snapResult.snappedPoint.y;
      state.activeEndpointSnap = { x: cx, y: cy, targetShape: snapResult.targetShape };
    } else {
      state.activeEndpointSnap = null;
    }
    state.lineHoverPoint = { x: cx, y: cy };
    renderStage();
  }
  if (state.cutActive){
    state.cutPreview = clientToStagePoint(e.clientX, e.clientY);
    renderCutOverlay();
  }
  if (!state.penActive) return;
  state.penPreview = clientToStagePoint(e.clientX, e.clientY);
  renderPenOverlay();
}
function finalizePen(closed){
  if (state.penPoints.length < 2){ cancelPen(); return; }
  const pts = state.penPoints;
  let d = 'M'+fmt(pts[0].x)+','+fmt(pts[0].y);
  for (let i=1;i<pts.length;i++) d += ' L'+fmt(pts[i].x)+','+fmt(pts[i].y);
  if (closed) d += ' Z';
  state.penActive = false; state.penPoints = []; state.penPreview = null;
  doAction(() => {
    const shape = createPathShape(d);
    if (state.lastFillColor) shape.fillColor = state.lastFillColor;
    if (!closed){ shape.fillEnabled = false; shape.strokeEnabled = true; shape.strokeColor = state.lastStrokeColor || shape.fillColor; shape.strokeWidth = state.lastStrokeWidth || 1; }
    state.shapes.push(shape);
    state.selectedIds = [shape.id];
  });
  setTool('select');
  switchTab('design');
}
function cancelPen(){
  state.penActive = false; state.penPoints = []; state.penPreview = null;
  renderPenOverlay();
}
function renderPenOverlay(){
  const existing = gOverlay.querySelector('#penPreviewGroup');
  if (existing) existing.remove();
  if (!state.penActive || !state.penPoints.length) return;
  const g = svgEl('g', { id:'penPreviewGroup' });
  let d = 'M'+fmt(state.penPoints[0].x)+','+fmt(state.penPoints[0].y);
  for (let i=1;i<state.penPoints.length;i++) d += ' L'+fmt(state.penPoints[i].x)+','+fmt(state.penPoints[i].y);
  if (state.penPreview) d += ' L'+fmt(state.penPreview.x)+','+fmt(state.penPreview.y);
  g.appendChild(svgEl('path', { d, fill:'none', stroke:'#6FA8FF', 'stroke-width':1.2, 'vector-effect':'non-scaling-stroke', 'stroke-dasharray':'4 3' }));
  const r = 4.2/(PX_PER_UNIT*state.view.zoom);
  for (const p of state.penPoints){
    g.appendChild(svgEl('circle', { cx:p.x, cy:p.y, r, fill:'#151824', stroke:'#6FA8FF', 'stroke-width':1.3, 'vector-effect':'non-scaling-stroke' }));
  }
  gOverlay.appendChild(g);
}

/* ---------------- wheel zoom ---------------- */
function stageWheel(e){
  e.preventDefault();
  if (e.shiftKey){
    state.view.panX -= e.deltaX || e.deltaY;
    layoutStage();
    return;
  }
  if (e.ctrlKey){
    state.view.panY -= e.deltaY;
    layoutStage();
    return;
  }
  const factor = Math.pow(1.0016, -e.deltaY);
  applyZoomAt(state.view.zoom * factor, e.clientX, e.clientY);
}

/* ---------------- keyboard shortcuts ---------------- */
function isTypingTarget(el){
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
function onKeyDown(e){
  if (settingsUI.open) return;
  if (e.code === 'Space' && !state.spaceHeld && !isTypingTarget(document.activeElement)){
    state.spaceHeld = true; DOM.canvasScroll.classList.add('pan-tool'); e.preventDefault();
  }
  if (isTypingTarget(document.activeElement)){
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  if (e.key === '/' && document.body.classList.contains('home-visible')){
    e.preventDefault();
    DOM.homeSearchInput.focus();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;

  if (e.key === 'Delete' || e.key === 'Backspace'){
    if (state.tool === 'node' && state.nodeEdit.shapeId && state.nodeEdit.selectedNodeIndex != null){
      e.preventDefault();
      deleteNodeFromPath(state.nodeEdit.shapeId, state.nodeEdit.selectedNodeIndex);
      return;
    }
    if (state.selectedIds.length){ e.preventDefault(); doAction(() => deleteShapesByIds(state.selectedIds)); }
    return;
  }
  if (e.key === 'Escape'){
    if (state.arcDraft){ state.arcDraft = null; state.arcHoverPoint = null; showToast('Arc drawing cancelled'); renderStage(); }
    else if (state.curveDraft){ state.curveDraft = null; state.curveHoverPoint = null; showToast('Curve drawing cancelled'); renderStage(); }
    else if (state.lineDraft){ state.lineDraft = null; state.lineHoverPoint = null; state.activeEndpointSnap = null; showToast('Line drawing cancelled'); renderStage(); }
    else if (state.cutActive){ cancelCut(); showToast('Cut cancelled'); }
    else if (state.penActive) cancelPen(); else { clearSelection(); renderAll(); }
    return;
  }
  if (e.key === 'Enter' && state.penActive){ finalizePen(false); return; }
  if (e.key === 'Enter' && state.cutActive){ finalizeCut(); return; }

  if (!mod && state.selectedIds.length && e.key.indexOf('Arrow') === 0){
    e.preventDefault();
    let step = 1;
    if (e.shiftKey) step = 5;
    if (e.altKey) step = 0.1;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -step; else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step; else if (e.key === 'ArrowDown') dy = step;
    doAction(() => { for (const s of selectedShapes()) if (!s.locked) moveShapeBy(s, dx, dy); });
    return;
  }

  // Everything else — undo/redo, clipboard, tool switching, zoom — goes through the
  // user-customizable keybind table (see the "keybinds" section) so a rebind from the
  // Keybinds settings tab takes effect immediately, with no other code to touch.
  const actionId = keybindIdForCombo(comboFromEvent(e));
  if (actionId){ e.preventDefault(); KEYBIND_ACTIONS[actionId](); return; }
}
function onKeyUp(e){ if (e.code === 'Space'){ state.spaceHeld = false; DOM.canvasScroll.classList.remove('pan-tool'); } }

function duplicateSelectionAction(){
  if (!state.selectedIds.length) return;
  doAction(() => { const clones = duplicateShapesByIds(state.selectedIds); state.selectedIds = clones.map(c=>c.id); });
}
function cutSelectionToClipboard(){
  if (!state.selectedIds.length) return;
  const count = state.selectedIds.length;
  state.clipboard = state.selectedIds.map(id => deepClone(findShapeById(id))).filter(Boolean);
  doAction(() => deleteShapesByIds(state.selectedIds));
  showToast('Cut ' + count + ' layer' + (count > 1 ? 's' : '') + ' to clipboard');
}
function copySelectionToClipboard(){
  if (!state.selectedIds.length) return;
  state.clipboard = state.selectedIds.map(id => deepClone(findShapeById(id))).filter(Boolean);
  showToast('Copied ' + state.clipboard.length + ' layer' + (state.clipboard.length>1?'s':'') + ' to clipboard');
}
function pasteClipboard(){
  if (!state.clipboard || !state.clipboard.length) return;
  doAction(() => {
    const newIds = [];
    for (const s of state.clipboard){
      const c = deepClone(s);
      c.id = uid('shape');
      const nudge = Math.max(state.doc.viewportWidth, state.doc.viewportHeight) * 0.04;
      moveShapeBy(c, nudge, nudge);
      state.shapes.push(c);
      newIds.push(c.id);
    }
    state.selectedIds = newIds;
  });
}


function startMultiResize(e, handle){
  e.preventDefault();
  e.stopPropagation();
  const shapes = selectedShapes().filter(shape => shape.visible && !shape.locked);
  if (!shapes.length) return;
  const bounds = getSelectionStageBounds(shapes);
  if (!bounds || bounds.width < 0.0001 || bounds.height < 0.0001) return;
  beginEdit();
  if (e.pointerId != null && DOM.stage.setPointerCapture) DOM.stage.setPointerCapture(e.pointerId);
  let lastClientX = e.clientX, lastClientY = e.clientY;
  const originals = shapes.map(shape => {
    const isLine = isLineShape(shape);
    const linePts = isLine ? getLineEndpointsStage(shape) : null;
    return {
      shape,
      isLine,
      linePts,
      type: shape.type,
      x: shape.x,
      y: shape.y,
      width: shape.width,
      height: shape.height,
      nativeWidth: shape.nativeWidth,
      nativeHeight: shape.nativeHeight,
      pivot: shapeLocalPivot(shape),
      pivotStage: getShapePivotStage(shape),
      scaleX: shape.scaleX || 1,
      scaleY: shape.scaleY || 1,
      translateX: shape.translateX || 0,
      translateY: shape.translateY || 0,
      rotation: shape.rotation || 0,
    };
  });
  function onMove(ev){
    lastClientX = ev.clientX; lastClientY = ev.clientY;
    const point = clientToStagePoint(ev.clientX, ev.clientY);
    let width = bounds.width, height = bounds.height;
    if (handle.indexOf('e') >= 0) width = Math.max(MIN_SHAPE_SIZE, point.x - bounds.x);
    if (handle.indexOf('w') >= 0) width = Math.max(MIN_SHAPE_SIZE, bounds.right - point.x);
    if (handle.indexOf('s') >= 0) height = Math.max(MIN_SHAPE_SIZE, point.y - bounds.y);
    if (handle.indexOf('n') >= 0) height = Math.max(MIN_SHAPE_SIZE, bounds.bottom - point.y);
    let sx = (handle.indexOf('e') >= 0 || handle.indexOf('w') >= 0) ? width / bounds.width : 1;
    let sy = (handle.indexOf('s') >= 0 || handle.indexOf('n') >= 0) ? height / bounds.height : 1;
    if (ev.shiftKey && handle.length === 2){
      const uniform = Math.max(Math.abs(sx), Math.abs(sy));
      sx = Math.sign(sx || 1) * uniform;
      sy = Math.sign(sy || 1) * uniform;
    }
    const anchorX = handle.indexOf('e') >= 0 ? bounds.x : (handle.indexOf('w') >= 0 ? bounds.right : bounds.x);
    const anchorY = handle.indexOf('s') >= 0 ? bounds.y : (handle.indexOf('n') >= 0 ? bounds.bottom : bounds.y);
    for (const orig of originals){
      const shape = orig.shape;
      if (orig.isLine && orig.linePts){
        const newP1 = {
          x: anchorX + (orig.linePts.p1.x - anchorX) * sx,
          y: anchorY + (orig.linePts.p1.y - anchorY) * sy
        };
        const newP2 = {
          x: anchorX + (orig.linePts.p2.x - anchorX) * sx,
          y: anchorY + (orig.linePts.p2.y - anchorY) * sy
        };
        setLineEndpointsStage(shape, newP1, newP2);
        continue;
      }
      const isSimple = (orig.type === 'rect' || orig.type === 'ellipse' || orig.type === 'polygon') &&
                       orig.rotation === 0 && Math.abs(orig.scaleX - 1) < 1e-6 && Math.abs(orig.scaleY - 1) < 1e-6 &&
                       Math.abs(orig.translateX) < 1e-6 && Math.abs(orig.translateY) < 1e-6;
      if (isSimple){
        let newX = anchorX + (orig.x - anchorX) * sx;
        let newY = anchorY + (orig.y - anchorY) * sy;
        let newW = orig.width * sx;
        let newH = orig.height * sy;
        if (newW < 0){ newX += newW; newW = -newW; }
        if (newH < 0){ newY += newH; newH = -newH; }
        shape.x = newX;
        shape.y = newY;
        shape.width = Math.max(MIN_SHAPE_SIZE, newW);
        shape.height = Math.max(MIN_SHAPE_SIZE, newH);
        shape.scaleX = 1;
        shape.scaleY = 1;
        shape.translateX = 0;
        shape.translateY = 0;
      } else {
        const pivotStageX = anchorX + (orig.pivotStage.x - anchorX) * sx;
        const pivotStageY = anchorY + (orig.pivotStage.y - anchorY) * sy;
        shape.scaleX = Math.round(orig.scaleX * sx * 1000) / 1000;
        shape.scaleY = Math.round(orig.scaleY * sy * 1000) / 1000;
        shape.translateX = pivotStageX - orig.pivot.x;
        shape.translateY = pivotStageY - orig.pivot.y;
      }
    }
    if (state.grid.guides){
      const curB = getSelectionVisualStageBounds(shapes);
      if (curB){
        const snap = computeAlignGuideSnap(shapes, curB);
        state.activeGuideLines = snap.lines;
      }
    } else {
      state.activeGuideLines = null;
    }
    renderDuringDrag();
  }
  function onUp(){
    state.activeGuideLines = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (e.pointerId != null && DOM.stage.releasePointerCapture) DOM.stage.releasePointerCapture(e.pointerId);
    commitEdit();
    resyncHoverFromClientPoint(lastClientX, lastClientY);
    renderAll();
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}