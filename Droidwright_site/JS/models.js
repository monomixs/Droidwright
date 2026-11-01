/* ---------------- Structured Path / Node Editor Model ---------------- */
function parseSvgPathToNodes(d){
  if (!d) return [];
  const cmdRegex = /([a-df-z])([^a-df-z]*)/gi;
  let match;
  const subpaths = [];
  let currentNodes = [];
  let curX = 0, curY = 0;
  let startX = 0, startY = 0;

  function finishSub(closed = false){
    if (currentNodes.length > 0){
      subpaths.push({ nodes: currentNodes, closed });
    }
    currentNodes = [];
  }

  while ((match = cmdRegex.exec(d))){
    const cmd = match[1];
    const isRel = cmd === cmd.toLowerCase();
    const type = cmd.toUpperCase();
    const nums = extractNumbers(match[2]);
    let i = 0;

    switch(type){
      case 'M': {
        if (currentNodes.length > 0) finishSub(false);
        while (i < nums.length){
          let x = isRel ? curX + nums[i] : nums[i];
          let y = isRel ? curY + nums[i+1] : nums[i+1];
          currentNodes.push({ x, y, type: 'corner', cp1: null, cp2: null });
          curX = x; curY = y;
          if (i === 0){ startX = x; startY = y; }
          i += 2;
        }
        break;
      }
      case 'L': {
        while (i < nums.length){
          let x = isRel ? curX + nums[i] : nums[i];
          let y = isRel ? curY + nums[i+1] : nums[i+1];
          currentNodes.push({ x, y, type: 'corner', cp1: null, cp2: null });
          curX = x; curY = y;
          i += 2;
        }
        break;
      }
      case 'H': {
        while (i < nums.length){
          let x = isRel ? curX + nums[i] : nums[i];
          currentNodes.push({ x, y: curY, type: 'corner', cp1: null, cp2: null });
          curX = x;
          i += 1;
        }
        break;
      }
      case 'V': {
        while (i < nums.length){
          let y = isRel ? curY + nums[i] : nums[i];
          currentNodes.push({ x: curX, y, type: 'corner', cp1: null, cp2: null });
          curY = y;
          i += 1;
        }
        break;
      }
      case 'C': {
        while (i + 5 < nums.length){
          let cp1x = isRel ? curX + nums[i] : nums[i];
          let cp1y = isRel ? curY + nums[i+1] : nums[i+1];
          let cp2x = isRel ? curX + nums[i+2] : nums[i+2];
          let cp2y = isRel ? curY + nums[i+3] : nums[i+3];
          let x = isRel ? curX + nums[i+4] : nums[i+4];
          let y = isRel ? curY + nums[i+5] : nums[i+5];

          if (currentNodes.length > 0){
            currentNodes[currentNodes.length - 1].cp2 = { x: cp1x, y: cp1y };
          }
          currentNodes.push({ x, y, type: 'smooth', cp1: { x: cp2x, y: cp2y }, cp2: null });
          curX = x; curY = y;
          i += 6;
        }
        break;
      }
      case 'S': {
        while (i + 3 < nums.length){
          let cp2x = isRel ? curX + nums[i] : nums[i];
          let cp2y = isRel ? curY + nums[i+1] : nums[i+1];
          let x = isRel ? curX + nums[i+2] : nums[i+2];
          let y = isRel ? curY + nums[i+3] : nums[i+3];

          let cp1x = curX, cp1y = curY;
          if (currentNodes.length > 0 && currentNodes[currentNodes.length - 1].cp1){
            const prevCp = currentNodes[currentNodes.length - 1].cp1;
            cp1x = 2 * curX - prevCp.x;
            cp1y = 2 * curY - prevCp.y;
            currentNodes[currentNodes.length - 1].cp2 = { x: cp1x, y: cp1y };
          }
          currentNodes.push({ x, y, type: 'smooth', cp1: { x: cp2x, y: cp2y }, cp2: null });
          curX = x; curY = y;
          i += 4;
        }
        break;
      }
      case 'Q': {
        while (i + 3 < nums.length){
          let qx = isRel ? curX + nums[i] : nums[i];
          let qy = isRel ? curY + nums[i+1] : nums[i+1];
          let x = isRel ? curX + nums[i+2] : nums[i+2];
          let y = isRel ? curY + nums[i+3] : nums[i+3];
          const cp1x = curX + (2/3) * (qx - curX);
          const cp1y = curY + (2/3) * (qy - curY);
          const cp2x = x + (2/3) * (qx - x);
          const cp2y = y + (2/3) * (qy - y);
          if (currentNodes.length > 0){
            currentNodes[currentNodes.length - 1].cp2 = { x: cp1x, y: cp1y };
          }
          currentNodes.push({ x, y, type: 'smooth', cp1: { x: cp2x, y: cp2y }, cp2: null });
          curX = x; curY = y;
          i += 4;
        }
        break;
      }
      case 'Z': {
        finishSub(true);
        curX = startX; curY = startY;
        break;
      }
      default:
        break;
    }
  }
  if (currentNodes.length > 0) finishSub(false);
  return subpaths;
}

function nodesToPathData(subpaths){
  if (!subpaths || !subpaths.length) return 'M0,0';
  const out = [];
  for (const sub of subpaths){
    const nodes = sub.nodes;
    if (!nodes || !nodes.length) continue;
    out.push(`M${fmt(nodes[0].x)},${fmt(nodes[0].y)}`);
    const count = sub.closed ? nodes.length : nodes.length - 1;
    for (let i = 0; i < count; i++){
      const curr = nodes[i];
      const next = nodes[(i + 1) % nodes.length];
      const cp1 = curr.cp2;
      const cp2 = next.cp1;
      if (cp1 || cp2){
        const c1x = cp1 ? cp1.x : curr.x;
        const c1y = cp1 ? cp1.y : curr.y;
        const c2x = cp2 ? cp2.x : next.x;
        const c2y = cp2 ? cp2.y : next.y;
        out.push(`C${fmt(c1x)},${fmt(c1y)} ${fmt(c2x)},${fmt(c2y)} ${fmt(next.x)},${fmt(next.y)}`);
      } else {
        out.push(`L${fmt(next.x)},${fmt(next.y)}`);
      }
    }
    if (sub.closed){
      out.push('Z');
    }
  }
  return out.join(' ') || 'M0,0';
}

function shapePathData(shape){
  switch(shape.type){
    case 'rect': {
      const hasPerCorner = shape.radiusTL != null || shape.radiusTR != null || shape.radiusBR != null || shape.radiusBL != null;
      if (hasPerCorner){
        return rectPathData(shape.x, shape.y, shape.width, shape.height,
          shape.radiusTL ?? shape.radius,
          shape.radiusTR ?? shape.radius,
          shape.radiusBR ?? shape.radius,
          shape.radiusBL ?? shape.radius
        );
      }
      return rectPathData(shape.x, shape.y, shape.width, shape.height, shape.radius);
    }
    case 'ellipse': return ellipsePathData(shape.x, shape.y, shape.width, shape.height);
    case 'arc': {
      const rx = shape.width / 2, ry = shape.height / 2;
      const cx = shape.x + rx, cy = shape.y + ry;
      const isSector = shape.sector || shape.isPie;
      const innerRatio = shape.innerRadiusPercent != null ? shape.innerRadiusPercent / 100 : (shape.innerRatio || 0);
      return arcPathData(cx, cy, rx, ry, shape.startAngle || 0, shape.sweepAngle != null ? shape.sweepAngle : 270, isSector, innerRatio);
    }
    case 'polygon': return polygonPathData(shape.x, shape.y, shape.width, shape.height, shape.sides, shape.star, shape.innerRatio);
    case 'line': {
      if (shape.x1 != null && shape.y1 != null && shape.x2 != null && shape.y2 != null){
        return `M${fmt(shape.x1)},${fmt(shape.y1)} L${fmt(shape.x2)},${fmt(shape.y2)}`;
      }
      return shape.rawD || 'M0,0';
    }
    case 'curve': {
      if (shape.x1 != null && shape.y1 != null && shape.x2 != null && shape.y2 != null){
        const cp1x = shape.cp1x != null ? shape.cp1x : shape.x1 + (shape.x2 - shape.x1)*0.25;
        const cp1y = shape.cp1y != null ? shape.cp1y : shape.y1 + (shape.y2 - shape.y1)*0.25;
        const cp2x = shape.cp2x != null ? shape.cp2x : shape.x1 + (shape.x2 - shape.x1)*0.75;
        const cp2y = shape.cp2y != null ? shape.cp2y : shape.y1 + (shape.y2 - shape.y1)*0.75;
        return `M${fmt(shape.x1)},${fmt(shape.y1)} C${fmt(cp1x)},${fmt(cp1y)} ${fmt(cp2x)},${fmt(cp2y)} ${fmt(shape.x2)},${fmt(shape.y2)}`;
      }
      return shape.rawD || 'M0,0';
    }
    case 'path':    return shape.rawD || 'M0,0';
    case 'text':    return shape.rawD || 'M0,0';
    default:        return 'M0,0';
  }
}


/* =====================================================================================
   Shape model
   ===================================================================================== */
const TYPE_LABEL = { rect:'Rectangle', ellipse:'Ellipse', polygon:'Polygon', arc:'Arc / Sector', line:'Line', path:'Path', curve:'Bézier Curve', text:'Text' };
let __shapeCounter = { rect:0, ellipse:0, polygon:0, arc:0, line:0, path:0, curve:0, text:0 };
function defaultShapeName(type){ __shapeCounter[type] = (__shapeCounter[type]||0) + 1; return (TYPE_LABEL[type]||'Shape') + ' ' + __shapeCounter[type]; }

function makeBaseShape(type){
  return {
    id: uid('shape'),
    type,
    name: defaultShapeName(type),
    visible: true,
    locked: false,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    translateX: 0,
    translateY: 0,
    fillEnabled: true,
    fillColor: '#000000',
    fillOpacity: 1,
    fillType: 'nonZero',
    // 'solid' uses fillColor; 'gradient' uses fillGradient (see makeGradient below).
    fillPaint: 'solid',
    fillGradient: null,
    strokeEnabled: false,
    strokeColor: '#000000',
    strokeOpacity: 1,
    strokePaint: 'solid',
    strokeGradient: null,
    strokeWidth: 1,
    strokeInnerWidth: 0,
    strokeOuterWidth: 0,
    strokeLineCap: 'butt',
    strokeLineJoin: 'miter',
    strokeMiterLimit: 4,
  };
}
/* =====================================================================================
   Gradients
   A gradient is stored in NORMALIZED space — every geometric value is a 0..1 fraction of
   the shape's own local bounding box — so a gradient survives resizing, and so the same
   object can describe both the on-canvas SVG paint server and the exported Android
   <gradient> (which wants absolute viewport coordinates) without a second source of truth.

     type      'linear' | 'radial' | 'sweep'   (Android: linear / radial / sweep)
     angle     degrees; 0 = left→right, 90 = top→bottom. Linear direction, sweep start.
     cx, cy    center, 0..1 of the bbox. Used by radial + sweep.
     radius    0..1, as a fraction of the bbox's longer side. Radial only.
     tileMode  'clamp' | 'repeat' | 'mirror'   (SVG spreadMethod pad / repeat / reflect)
     stops     [{ offset 0..1, color '#rrggbb', opacity 0..1 }], at least two, sorted.

   Per-stop opacity is what gives gradients real transparency: Android has no stop-alpha
   attribute, so on export the opacity is folded into the color as #AARRGGBB.
   ===================================================================================== */
const GRADIENT_TYPES = ['linear', 'radial', 'sweep'];
const TILE_MODES = ['clamp', 'repeat', 'mirror'];
const TILE_TO_SPREAD = { clamp:'pad', repeat:'repeat', mirror:'reflect' };
const SPREAD_TO_TILE = { pad:'clamp', repeat:'repeat', reflect:'mirror' };
const MAX_GRADIENT_STOPS = 12;

function makeGradientStop(offset, color, opacity){
  return { offset: clamp(Number(offset) || 0, 0, 1), color: normalizeHexColor(color) || '#000000', opacity: opacity == null ? 1 : clamp(Number(opacity), 0, 1) };
}
function makeGradient(type, stops){
  return {
    type: GRADIENT_TYPES.indexOf(type) >= 0 ? type : 'linear',
    angle: 90,
    cx: 0.5,
    cy: 0.5,
    radius: 0.5,
    tileMode: 'clamp',
    stops: (stops && stops.length >= 2 ? stops : [makeGradientStop(0, '#5EE1A0', 1), makeGradientStop(1, '#6FA8FF', 1)]).map(s => makeGradientStop(s.offset, s.color, s.opacity)),
  };
}
/* Ready-made ramps. `transparent` ones exist so the alpha channel is discoverable —
   it's the part of gradient support people most often don't realize is there. */
const GRADIENT_PRESETS = [
  { name:'Mint to sky',    type:'linear', angle:90,  stops:[[0,'#5EE1A0',1],[1,'#6FA8FF',1]] },
  { name:'Sunset',         type:'linear', angle:45,  stops:[[0,'#f5b75e',1],[1,'#ff6b6b',1]] },
  { name:'Violet haze',    type:'linear', angle:90,  stops:[[0,'#b98cff',1],[1,'#6fa8ff',1]] },
  { name:'Ember',          type:'linear', angle:0,   stops:[[0,'#ff6b6b',1],[0.55,'#f5b75e',1],[1,'#ffe29a',1]] },
  { name:'Steel',          type:'linear', angle:90,  stops:[[0,'#9aa1af',1],[1,'#333947',1]] },
  { name:'Fade out',       type:'linear', angle:90,  stops:[[0,'#000000',1],[1,'#000000',0]] },
  { name:'Glass',          type:'linear', angle:90,  stops:[[0,'#ffffff',0.85],[1,'#ffffff',0]] },
  { name:'Spotlight',      type:'radial', angle:90,  stops:[[0,'#ffffff',1],[1,'#6fa8ff',1]] },
  { name:'Soft vignette',  type:'radial', angle:90,  stops:[[0,'#000000',0],[1,'#000000',0.75]] },
  { name:'Color wheel',    type:'sweep',  angle:0,   stops:[[0,'#ff6b6b',1],[0.33,'#5ee1a0',1],[0.66,'#6fa8ff',1],[1,'#ff6b6b',1]] },
];
function gradientFromPreset(preset){
  const g = makeGradient(preset.type, preset.stops.map(([o,c,a]) => makeGradientStop(o,c,a)));
  g.angle = preset.angle;
  return g;
}
/* Accepts anything that's been through localStorage, an import, or an older project file
   and returns a gradient that's safe to render. */
function normalizeGradient(raw){
  if (!raw || typeof raw !== 'object') return makeGradient('linear');
  const g = makeGradient(raw.type);
  if (isFinite(raw.angle)) g.angle = ((Number(raw.angle) % 360) + 360) % 360;
  if (isFinite(raw.cx)) g.cx = clamp(Number(raw.cx), -1, 2);
  if (isFinite(raw.cy)) g.cy = clamp(Number(raw.cy), -1, 2);
  if (isFinite(raw.radius)) g.radius = clamp(Number(raw.radius), 0.01, 3);
  if (TILE_MODES.indexOf(raw.tileMode) >= 0) g.tileMode = raw.tileMode;
  if (Array.isArray(raw.stops) && raw.stops.length >= 2){
    g.stops = raw.stops.slice(0, MAX_GRADIENT_STOPS).map(s => makeGradientStop(s.offset, s.color, s.opacity));
  }
  return sortGradientStops(g);
}
function sortGradientStops(g){
  g.stops.sort((a, b) => a.offset - b.offset);
  return g;
}
function cloneGradient(g){ return g ? deepClone(g) : null; }
/* The gradient a shape is actually painting with right now, or null if it's on solid. */
function activeGradient(shape, kind){
  const paint = kind === 'stroke' ? shape.strokePaint : shape.fillPaint;
  if (paint !== 'gradient') return null;
  const g = kind === 'stroke' ? shape.strokeGradient : shape.fillGradient;
  return g ? normalizeGradient(g) : null;
}
/* Lazily builds a gradient the first time a shape is switched over to one, seeded from
   the solid color it already had so the switch reads as a continuation, not a reset. */
function ensureShapeGradient(shape, kind){
  const key = kind === 'stroke' ? 'strokeGradient' : 'fillGradient';
  if (shape[key]) { shape[key] = normalizeGradient(shape[key]); return shape[key]; }
  const base = normalizeHexColor(kind === 'stroke' ? shape.strokeColor : shape.fillColor) || '#5EE1A0';
  shape[key] = makeGradient('linear', [makeGradientStop(0, base, 1), makeGradientStop(1, shadeHexColor(base, -0.45), 1)]);
  return shape[key];
}
/* Lighten (amount > 0) or darken (amount < 0) a hex color by a ratio. */
function shadeHexColor(hex, amount){
  const n = normalizeHexColor(hex);
  if (!n) return '#000000';
  const to = amount < 0 ? 0 : 255;
  const r = Math.abs(amount);
  const parts = [1,3,5].map(i => {
    const v = parseInt(n.slice(i, i+2), 16);
    return clamp(Math.round(v + (to - v) * r), 0, 255).toString(16).padStart(2, '0');
  });
  return '#' + parts.join('');
}
function hexToRgb(hex){
  const n = normalizeHexColor(hex) || '#000000';
  return { r: parseInt(n.slice(1,3),16), g: parseInt(n.slice(3,5),16), b: parseInt(n.slice(5,7),16) };
}
function rgbaCss(hex, opacity){
  const c = hexToRgb(hex);
  return `rgba(${c.r},${c.g},${c.b},${opacity == null ? 1 : Math.round(opacity*1000)/1000})`;
}
/* '#AARRGGBB' — Android's color order, with the stop's opacity as the alpha byte. */
function androidColorWithAlpha(hex, opacity){
  const n = normalizeHexColor(hex) || '#000000';
  const a = clamp(Math.round((opacity == null ? 1 : opacity) * 255), 0, 255).toString(16).padStart(2, '0');
  return ('#' + a + n.slice(1)).toUpperCase();
}
/* Parses #RGB / #RRGGBB / #AARRGGBB (Android) into { hex, opacity }. */
function parseAndroidColor(raw){
  const s = String(raw || '').trim();
  if (/^#[0-9a-fA-F]{8}$/.test(s)){
    return { hex: ('#' + s.slice(3)).toLowerCase(), opacity: parseInt(s.slice(1,3),16) / 255 };
  }
  const n = normalizeHexColor(s);
  return n ? { hex:n, opacity:1 } : null;
}
/* Direction vector for `angle`, as a line through the middle of the unit box.
   0° points right, 90° points down (SVG's y-axis runs downward). */
function gradientUnitEndpoints(angle){
  const rad = (Number(angle) || 0) * Math.PI / 180;
  const dx = Math.cos(rad) / 2, dy = Math.sin(rad) / 2;
  return { x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy };
}
/* Normalized gradient geometry resolved against a real bounding box, in user units.
   Both the SVG renderer and the Android exporter go through this, so what you see on
   canvas is what lands in the XML. */
function gradientUserGeometry(gradient, bbox){
  const w = Math.max(bbox.width, 1e-4), h = Math.max(bbox.height, 1e-4);
  const at = (nx, ny) => ({ x: bbox.x + nx * w, y: bbox.y + ny * h });
  const e = gradientUnitEndpoints(gradient.angle);
  const start = at(e.x1, e.y1), end = at(e.x2, e.y2);
  const center = at(gradient.cx, gradient.cy);
  return {
    startX: start.x, startY: start.y,
    endX: end.x, endY: end.y,
    centerX: center.x, centerY: center.y,
    radius: Math.max(gradient.radius * Math.max(w, h), 1e-4),
  };
}
/* A CSS gradient string for the editor's preview swatch. Mirrors the SVG output closely
   enough to be trustworthy while staying cheap to render in a <div>. */
function gradientCssPreview(gradient){
  const g = normalizeGradient(gradient);
  const stops = g.stops.map(s => `${rgbaCss(s.color, s.opacity)} ${Math.round(s.offset*1000)/10}%`).join(', ');
  if (g.type === 'radial') return `radial-gradient(circle at ${Math.round(g.cx*100)}% ${Math.round(g.cy*100)}%, ${stops})`;
  if (g.type === 'sweep') return `conic-gradient(from ${fmt(g.angle)}deg at ${Math.round(g.cx*100)}% ${Math.round(g.cy*100)}%, ${stops})`;
  return `linear-gradient(${fmt(g.angle + 90)}deg, ${stops})`;
}
/* Color at an arbitrary position along the ramp — used to build sweep wedges and to
   pick a sensible color when a new stop is dropped into the middle of the ramp. */
function sampleGradientColor(g, t){
  const stops = g.stops;
  const pos = clamp(t, 0, 1);
  if (pos <= stops[0].offset) return { color: stops[0].color, opacity: stops[0].opacity };
  const last = stops[stops.length - 1];
  if (pos >= last.offset) return { color: last.color, opacity: last.opacity };
  for (let i = 0; i < stops.length - 1; i++){
    const a = stops[i], b = stops[i+1];
    if (pos >= a.offset && pos <= b.offset){
      const span = b.offset - a.offset;
      const k = span <= 1e-9 ? 0 : (pos - a.offset) / span;
      const ca = hexToRgb(a.color), cb = hexToRgb(b.color);
      const mix = (x, y) => clamp(Math.round(x + (y - x) * k), 0, 255).toString(16).padStart(2, '0');
      return { color: '#' + mix(ca.r, cb.r) + mix(ca.g, cb.g) + mix(ca.b, cb.b), opacity: a.opacity + (b.opacity - a.opacity) * k };
    }
  }
  return { color: last.color, opacity: last.opacity };
}

function createRectShape(x,y,w,h){
  const s = makeBaseShape('rect');
  Object.assign(s, { x, y, width:w, height:h, radius:0, radiusTL:null, radiusTR:null, radiusBR:null, radiusBL:null });
  return s;
}
function createEllipseShape(x,y,w,h){
  const s = makeBaseShape('ellipse');
  Object.assign(s, { x, y, width:w, height:h });
  return s;
}
function createArcShape(x,y,w,h,startAngle=0,sweepAngle=270,sector=false,innerRadiusPercent=0){
  const s = makeBaseShape('arc');
  s.fillEnabled = sector || innerRadiusPercent > 0;
  s.strokeEnabled = !s.fillEnabled;
  s.fillColor = state.lastFillColor || '#5EE1A0';
  s.strokeColor = state.lastStrokeColor || '#5EE1A0';
  s.strokeWidth = state.lastStrokeWidth || 2;
  s.strokeLineCap = 'round';
  s.strokeLineJoin = 'round';
  Object.assign(s, { x, y, width:w, height:h, startAngle, sweepAngle, sector, innerRadiusPercent });
  return s;
}
function createPolygonShape(x,y,w,h){
  const s = makeBaseShape('polygon');
  Object.assign(s, { x, y, width:w, height:h, sides:6, star:false, innerRatio:0.5 });
  return s;
}
function createPathShape(rawD, extra){
  const s = makeBaseShape('path');
  const bbox = measurePathBBox(rawD);
  Object.assign(s, {
    rawD,
    pivotX: bbox.x + bbox.width/2,
    pivotY: bbox.y + bbox.height/2,
    nativeWidth: bbox.width || 0.0001,
    nativeHeight: bbox.height || 0.0001,
  });
  if (extra) Object.assign(s, extra);
  return s;
}
// A text shape carries the live, re-editable text properties (content/font/size/etc) AND a
// baked `rawD` glyph outline (same pivot/nativeWidth/nativeHeight fields as a 'path' shape)
// so it renders, transforms, resizes and exports exactly like any other path-backed shape
// without needing special-case geometry code. The outline is regenerated by
// regenerateTextPath() whenever the live properties change — see Part 1b below.
function createTextShape(x, y){
  const s = makeBaseShape('text');
  s.name = defaultShapeName('text');
  Object.assign(s, {
    text: 'Text',
    fontFamily: 'Roboto',
    fontWeight: 400,
    fontItalic: false,
    fontSize: 10,
    letterSpacing: 0,
    textAlign: 'left',
    rawD: '',
    // anchorX/Y is the fixed point (baseline start of the first line) the outline is
    // generated around — set once at creation and left alone afterward. Subsequent moves
    // go through translateX/translateY instead (same convention as path/curve shapes), so
    // editing text/font properties later never causes the shape to jump on canvas.
    anchorX: x, anchorY: y,
    pivotX: x, pivotY: y,
    nativeWidth: 0.0001, nativeHeight: 0.0001,
    fillColor: state.lastFillColor || '#000000',
  });
  return s;
}

