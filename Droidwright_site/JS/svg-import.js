/* =====================================================================================
   Part 9: SVG import
   ===================================================================================== */
function resolveCssColor(raw){
  if (!raw) return null;
  const s = raw.trim();
  if (s === 'none') return null;
  if (s.indexOf('url(') === 0) return null;
  try{
    const probe = document.createElement('span');
    probe.style.color = '';
    probe.style.color = s;
    if (!probe.style.color) return null;
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    document.body.removeChild(probe);
    const m = computed.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    const r = clamp(Math.round(parseFloat(m[1])),0,255), g = clamp(Math.round(parseFloat(m[2])),0,255), b = clamp(Math.round(parseFloat(m[3])),0,255);
    const hex = '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
    const alpha = m[4] != null ? parseFloat(m[4]) : 1;
    return { hex, alpha };
  }catch(e){ return null; }
}
/* ---- SVG gradient import ----
   Imported SVGs reference their gradients by id (fill="url(#grad1)"), so before walking
   the tree we index every <linearGradient>/<radialGradient> in the document, resolve
   xlink:href inheritance, and convert each into the normalized model. */
let __svgGradientDefs = {};
function collectSvgGradientDefs(root){
  __svgGradientDefs = {};
  const nodes = root.querySelectorAll('linearGradient, radialGradient');
  const byId = {};
  nodes.forEach(node => { if (node.id) byId[node.id] = node; });

  // A gradient can inherit stops and geometry from another via href — follow the chain.
  function resolveAttr(node, name, seen){
    if (!node || seen.has(node)) return null;
    seen.add(node);
    const own = node.getAttribute(name);
    if (own != null) return own;
    const href = node.getAttribute('href') || node.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    const parent = href.startsWith('#') ? byId[href.slice(1)] : null;
    return parent ? resolveAttr(parent, name, seen) : null;
  }
  function resolveStops(node, seen){
    if (!node || seen.has(node)) return [];
    seen.add(node);
    const own = Array.from(node.children).filter(n => n.tagName && n.tagName.toLowerCase() === 'stop');
    if (own.length) return own;
    const href = node.getAttribute('href') || node.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    const parent = href.startsWith('#') ? byId[href.slice(1)] : null;
    return parent ? resolveStops(parent, seen) : [];
  }

  nodes.forEach(node => {
    if (!node.id) return;
    const isRadial = node.tagName.toLowerCase() === 'radialgradient';
    const g = makeGradient(isRadial ? 'radial' : 'linear');
    const stopEls = resolveStops(node, new Set());
    const stops = [];
    stopEls.forEach((stopEl, idx) => {
      const style = parseStylePairs(stopEl.getAttribute('style'));
      const rawColor = style['stop-color'] || stopEl.getAttribute('stop-color') || '#000000';
      const resolved = resolveCssColor(rawColor);
      const rawOffset = stopEl.getAttribute('offset') || String(idx / Math.max(1, stopEls.length - 1));
      // offset accepts both 0..1 and percentages
      const offset = rawOffset.trim().endsWith('%') ? parseFloat(rawOffset) / 100 : parseFloat(rawOffset);
      const rawOpacity = style['stop-opacity'] != null ? style['stop-opacity'] : stopEl.getAttribute('stop-opacity');
      let opacity = rawOpacity != null && !isNaN(parseFloat(rawOpacity)) ? clamp(parseFloat(rawOpacity), 0, 1) : 1;
      if (resolved && resolved.alpha < 1) opacity *= resolved.alpha;
      stops.push(makeGradientStop(isFinite(offset) ? offset : 0, resolved ? resolved.hex : '#000000', opacity));
    });
    if (stops.length < 2) return;
    g.stops = stops.slice(0, MAX_GRADIENT_STOPS);

    const seen = new Set();
    const spread = resolveAttr(node, 'spreadMethod', new Set());
    if (spread && SPREAD_TO_TILE[spread]) g.tileMode = SPREAD_TO_TILE[spread];
    // Geometry defaults are objectBoundingBox fractions, which is exactly how the model
    // stores them; userSpaceOnUse coordinates can't be mapped without a shape to measure
    // against, so those fall back to the sensible full-box defaults.
    const units = resolveAttr(node, 'gradientUnits', new Set()) || 'objectBoundingBox';
    const frac = (name, fallback) => {
      const raw = resolveAttr(node, name, new Set(seen));
      if (raw == null) return fallback;
      const v = raw.trim().endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
      return isFinite(v) ? v : fallback;
    };
    if (units === 'objectBoundingBox'){
      if (isRadial){
        g.cx = clamp(frac('cx', 0.5), -1, 2);
        g.cy = clamp(frac('cy', 0.5), -1, 2);
        g.radius = clamp(frac('r', 0.5), 0.01, 3);
      } else {
        const x1 = frac('x1', 0), y1 = frac('y1', 0), x2 = frac('x2', 1), y2 = frac('y2', 0);
        const dx = x2 - x1, dy = y2 - y1;
        if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) g.angle = ((Math.atan2(dy, dx) * 180 / Math.PI) % 360 + 360) % 360;
      }
    }
    __svgGradientDefs[node.id] = sortGradientStops(g);
  });
}
function svgGradientFromPaint(raw){
  const m = /^url\(\s*['"]?#([^)'"]+)['"]?\s*\)/.exec(String(raw || '').trim());
  if (!m) return null;
  const g = __svgGradientDefs[m[1]];
  return g ? cloneGradient(g) : null;
}
function parseStylePairs(styleStr){
  const out = {};
  if (!styleStr) return out;
  styleStr.split(';').forEach(pair => {
    const idx = pair.indexOf(':');
    if (idx < 0) return;
    const k = pair.slice(0,idx).trim(), v = pair.slice(idx+1).trim();
    if (k) out[k] = v;
  });
  return out;
}
function getEffectiveAttr(el, name, styleObj){
  if (styleObj && styleObj[name] != null) return styleObj[name];
  return el.getAttribute(name);
}
function applyStyleToShape(el, chainEls, shape){
  let fill = '#000000', fillOpacity = 1, hasFill = true;
  let stroke = null, strokeOpacity = 1, strokeWidth = 1;
  let fillRuleVal = 'nonzero';
  let fillGradient = null, strokeGradient = null;
  for (const node of chainEls){
    const style = parseStylePairs(node.getAttribute('style'));
    const f = getEffectiveAttr(node, 'fill', style);
    if (f != null){
      const grad = svgGradientFromPaint(f);
      if (grad){ fillGradient = grad; hasFill = true; fill = grad.stops[0].color; }
      else if (f === 'none') hasFill = false;
      else { const c = resolveCssColor(f); if (c){ fill = c.hex; hasFill = true; fillGradient = null; if (c.alpha < 1) fillOpacity = c.alpha; } }
    }
    const fo = getEffectiveAttr(node, 'fill-opacity', style);
    if (fo != null && !isNaN(parseFloat(fo))) fillOpacity = clamp(parseFloat(fo),0,1);
    const s = getEffectiveAttr(node, 'stroke', style);
    if (s != null){
      const grad = svgGradientFromPaint(s);
      if (grad){ strokeGradient = grad; stroke = grad.stops[0].color; }
      else if (s === 'none'){ stroke = null; strokeGradient = null; }
      else { const c = resolveCssColor(s); if (c){ stroke = c.hex; strokeGradient = null; if (c.alpha<1) strokeOpacity = c.alpha; } }
    }
    const so = getEffectiveAttr(node, 'stroke-opacity', style);
    if (so != null && !isNaN(parseFloat(so))) strokeOpacity = clamp(parseFloat(so),0,1);
    const sw = getEffectiveAttr(node, 'stroke-width', style);
    if (sw != null && !isNaN(parseFloat(sw))) strokeWidth = parseFloat(sw);
    const fr = getEffectiveAttr(node, 'fill-rule', style);
    if (fr) fillRuleVal = fr;
  }
  shape.fillEnabled = hasFill;
  shape.fillColor = fill;
  shape.fillOpacity = fillOpacity;
  shape.fillType = fillRuleVal === 'evenodd' ? 'evenOdd' : 'nonZero';
  shape.fillPaint = fillGradient ? 'gradient' : 'solid';
  shape.fillGradient = fillGradient;
  shape.strokeEnabled = !!stroke;
  shape.strokePaint = strokeGradient ? 'gradient' : 'solid';
  shape.strokeGradient = strokeGradient;
  if (stroke){ shape.strokeColor = stroke; shape.strokeOpacity = strokeOpacity; shape.strokeWidth = strokeWidth; }
}
function roundedRectSvgPath(x,y,w,h,rx,ry){
  const r = Math.max(0, rx||ry||0);
  return rectPathData(x,y,w,h, Math.min(r, w/2, h/2));
}
const SVG_SKIP_TAGS = ['defs','clippath','mask','symbol','title','desc','style','metadata','filter','lineargradient','radialgradient'];
function walkSvgNode(node, matrix, outShapes, chainEls){
  chainEls = chainEls || [];
  for (const child of Array.from(node.children)){
    const tag = child.tagName ? child.tagName.toLowerCase() : '';
    if (SVG_SKIP_TAGS.indexOf(tag) >= 0) continue;
    const localMatrix = matrix.multiply(parseTransformAttr(child.getAttribute('transform')));
    const newChain = chainEls.concat([child]);

    if (tag === 'g' || tag === 'a' || tag === 'svg'){ walkSvgNode(child, localMatrix, outShapes, newChain); continue; }

    let rawD = null;
    let forceStrokeOnly = false;
    if (tag === 'path'){
      rawD = child.getAttribute('d');
    } else if (tag === 'rect'){
      const x=parseFloat(child.getAttribute('x'))||0, y=parseFloat(child.getAttribute('y'))||0;
      const w=parseFloat(child.getAttribute('width'))||0, h=parseFloat(child.getAttribute('height'))||0;
      let rx=child.getAttribute('rx'), ry=child.getAttribute('ry');
      rx = rx!=null ? parseFloat(rx) : (ry!=null ? parseFloat(ry) : 0);
      ry = ry!=null ? parseFloat(ry) : rx;
      if (w>0 && h>0) rawD = roundedRectSvgPath(x,y,w,h,rx,ry);
    } else if (tag === 'circle'){
      const cx=parseFloat(child.getAttribute('cx'))||0, cy=parseFloat(child.getAttribute('cy'))||0, r=parseFloat(child.getAttribute('r'))||0;
      if (r>0) rawD = ellipsePathData(cx-r, cy-r, r*2, r*2);
    } else if (tag === 'ellipse'){
      const cx=parseFloat(child.getAttribute('cx'))||0, cy=parseFloat(child.getAttribute('cy'))||0;
      const rx=parseFloat(child.getAttribute('rx'))||0, ry=parseFloat(child.getAttribute('ry'))||0;
      if (rx>0 && ry>0) rawD = ellipsePathData(cx-rx, cy-ry, rx*2, ry*2);
    } else if (tag === 'polygon' || tag === 'polyline'){
      const ptsAttr = (child.getAttribute('points')||'').trim();
      const nums = ptsAttr.split(/[\s,]+/).filter(s=>s.length).map(Number);
      const pts = [];
      for (let i=0;i+1<nums.length;i+=2) pts.push([nums[i],nums[i+1]]);
      if (pts.length > 1){
        rawD = 'M'+pts.map((p,i)=>(i===0?'':'L')+fmt(p[0])+','+fmt(p[1])).join(' ');
        if (tag === 'polygon') rawD += ' Z'; else forceStrokeOnly = true;
      }
    } else if (tag === 'line'){
      const x1=parseFloat(child.getAttribute('x1'))||0, y1=parseFloat(child.getAttribute('y1'))||0;
      const x2=parseFloat(child.getAttribute('x2'))||0, y2=parseFloat(child.getAttribute('y2'))||0;
      rawD = `M${fmt(x1)},${fmt(y1)} L${fmt(x2)},${fmt(y2)}`;
      forceStrokeOnly = true;
    }
    if (!rawD) continue;

    const bbox = measurePathBBox(rawD);
    if (bbox.width < 1e-6 && bbox.height < 1e-6) continue;
    const localPivot = { x: bbox.x + bbox.width/2, y: bbox.y + bbox.height/2 };
    const decomposed = localMatrix.decomposeLinear();
    const desiredPivot = localMatrix.transformPoint(localPivot.x, localPivot.y);

    const shape = createPathShape(rawD);
    shape.rotation = Math.round(decomposed.rotation*100)/100;
    shape.scaleX = Math.round(decomposed.scaleX*1000)/1000;
    shape.scaleY = Math.round(decomposed.scaleY*1000)/1000;
    shape.translateX = desiredPivot.x - localPivot.x;
    shape.translateY = desiredPivot.y - localPivot.y;
    applyStyleToShape(child, newChain, shape);
    const idAttr = child.getAttribute('id');
    if (idAttr) shape.name = sanitizeResourceName(idAttr);
    if (forceStrokeOnly){
      shape.fillEnabled = false;
      if (!shape.strokeEnabled){ shape.strokeEnabled = true; shape.strokeColor = shape.fillColor; shape.strokeWidth = shape.strokeWidth || 1; }
    }
    outShapes.push(shape);
  }
}
function importSvgFile(file){
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const text = String(reader.result);
      const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
      const svgRoot = parsed.documentElement;
      if (!svgRoot || svgRoot.nodeName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror')){
        showToast('That file does not look like a valid SVG');
        return;
      }
      let vpW = 24, vpH = 24;
      const viewBoxAttr = svgRoot.getAttribute('viewBox');
      if (viewBoxAttr){
        const parts = viewBoxAttr.trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts[2]>0 && parts[3]>0){ vpW = parts[2]; vpH = parts[3]; }
      } else {
        const wAttr = parseFloat(svgRoot.getAttribute('width'));
        const hAttr = parseFloat(svgRoot.getAttribute('height'));
        if (wAttr>0) vpW = wAttr;
        if (hAttr>0) vpH = hAttr;
      }
      const newShapes = [];
      // Index gradient defs first — shapes reference them by id while the tree is walked.
      collectSvgGradientDefs(svgRoot);
      walkSvgNode(svgRoot, Mat2D.identity(), newShapes, []);
      __svgGradientDefs = {};
      if (!newShapes.length){ showToast('No supported shapes found in that SVG'); return; }

      const fileName = file ? file.name : 'Imported SVG';
      const fromHome = document.body.classList.contains('home-visible');
      const sameViewport = Math.abs(vpW-state.doc.viewportWidth)<0.01 && Math.abs(vpH-state.doc.viewportHeight)<0.01;

      if (fromHome || sameViewport || !state.shapes.length){
        finishImport(newShapes, sameViewport ? null : { vpW, vpH }, fileName);
      } else {
        showModal({
          title: 'Import SVG',
          body: `Found ${newShapes.length} shape${newShapes.length>1?'s':''} in a ${fmtAttr(vpW)}×${fmtAttr(vpH)} viewBox. Your canvas is currently ${fmtAttr(state.doc.viewportWidth)}×${fmtAttr(state.doc.viewportHeight)}. Match the canvas to the imported artwork?`,
          actions: [
            { label:'Keep current canvas', variant:'ghost', onClick: () => finishImport(newShapes, null, fileName) },
            { label:`Use ${fmtAttr(vpW)}×${fmtAttr(vpH)}`, variant:'primary', onClick: () => finishImport(newShapes, { vpW, vpH }, fileName) },
          ]
        });
      }
    }catch(err){
      showToast('Could not import that SVG file');
    }
  };
  reader.readAsText(file);
}
function finishImport(newShapes, viewportOverride, fileName){
  const fromHome = document.body.classList.contains('home-visible');
  document.body.classList.remove('home-visible');
  switchTab('design');

  doAction(() => {
    if (fromHome || !state.shapes.length){
      state.shapes = [];
      state.groups = {};
      state.projectId = uid('project');
      const cleanName = fileName ? fileName.replace(/\.svg$/i, '').replace(/[-_]+/g, ' ') : 'Imported SVG';
      state.projectName = cleanName;
      state.doc.name = sanitizeResourceName(cleanName);
      state.history.past = [];
      state.history.future = [];
    }
    if (viewportOverride){
      state.doc.viewportWidth = viewportOverride.vpW;
      state.doc.viewportHeight = viewportOverride.vpH;
      if (state.doc.linkSize){ state.doc.width = viewportOverride.vpW; state.doc.height = viewportOverride.vpH; }
    }
    for (const s of newShapes) state.shapes.push(s);
    state.selectedIds = newShapes.map(s => s.id);
  });
  syncDocSettingsUI();
  layoutStage();
  if (fromHome) applyDefaultZoom(); else fitZoom();
  renderAll();
  closeModal();
  showToast('Imported ' + newShapes.length + ' shape' + (newShapes.length>1?'s':''));
}

