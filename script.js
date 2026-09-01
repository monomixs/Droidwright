'use strict';
/* =====================================================================================
   DROIDWRIGHT — Android Vector Icon Editor
   Part 1: constants, math/geometry utils, state, shape factories, path-data generation
   ===================================================================================== */

const NS_SVG = 'http://www.w3.org/2000/svg';
const KAPPA = 0.5522847498307936;         // 4-bezier circle approximation constant
const PX_PER_UNIT = 20;                    // on-screen px per viewport unit at zoom = 1
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
   Path-data generators — everything is authored as Android-compatible pathData
   (M/L/C/Z only — no arcs, so output is maximally compatible & unambiguous)
   ===================================================================================== */
function rectPathData(x,y,w,h,rTL,rTR,rBR,rBL){
  w = Math.max(0,w); h = Math.max(0,h);
  // If called with single radius (old signature), spread to all corners
  if (rTR === undefined && rBR === undefined && rBL === undefined){
    const r = Math.max(0, Math.min(rTL||0, w/2, h/2));
    if (r <= 0.0005){
      return `M${fmt(x)},${fmt(y)} L${fmt(x+w)},${fmt(y)} L${fmt(x+w)},${fmt(y+h)} L${fmt(x)},${fmt(y+h)} Z`;
    }
    const k = r*KAPPA;
    return [
      `M${fmt(x+r)},${fmt(y)}`,
      `L${fmt(x+w-r)},${fmt(y)}`,
      `C${fmt(x+w-r+k)},${fmt(y)} ${fmt(x+w)},${fmt(y+r-k)} ${fmt(x+w)},${fmt(y+r)}`,
      `L${fmt(x+w)},${fmt(y+h-r)}`,
      `C${fmt(x+w)},${fmt(y+h-r+k)} ${fmt(x+w-r+k)},${fmt(y+h)} ${fmt(x+w-r)},${fmt(y+h)}`,
      `L${fmt(x+r)},${fmt(y+h)}`,
      `C${fmt(x+r-k)},${fmt(y+h)} ${fmt(x)},${fmt(y+h-r+k)} ${fmt(x)},${fmt(y+h-r)}`,
      `L${fmt(x)},${fmt(y+r)}`,
      `C${fmt(x)},${fmt(y+r-k)} ${fmt(x+r-k)},${fmt(y)} ${fmt(x+r)},${fmt(y)}`,
      'Z'
    ].join(' ');
  }
  // Per-corner mode
  const tl = Math.max(0, Math.min(rTL||0, w/2, h/2));
  const tr = Math.max(0, Math.min(rTR||0, w/2, h/2));
  const br = Math.max(0, Math.min(rBR||0, w/2, h/2));
  const bl = Math.max(0, Math.min(rBL||0, w/2, h/2));
  const seg = (r, ...rest) => r > 0.0005 ? rest : [];
  const parts = [
    `M${fmt(x+tl)},${fmt(y)}`,
    `L${fmt(x+w-tr)},${fmt(y)}`,
    ...(tr > 0.0005 ? [`C${fmt(x+w-tr+tr*KAPPA)},${fmt(y)} ${fmt(x+w)},${fmt(y+tr-tr*KAPPA)} ${fmt(x+w)},${fmt(y+tr)}`] : []),
    `L${fmt(x+w)},${fmt(y+h-br)}`,
    ...(br > 0.0005 ? [`C${fmt(x+w)},${fmt(y+h-br+br*KAPPA)} ${fmt(x+w-br+br*KAPPA)},${fmt(y+h)} ${fmt(x+w-br)},${fmt(y+h)}`] : []),
    `L${fmt(x+bl)},${fmt(y+h)}`,
    ...(bl > 0.0005 ? [`C${fmt(x+bl-bl*KAPPA)},${fmt(y+h)} ${fmt(x)},${fmt(y+h-bl+bl*KAPPA)} ${fmt(x)},${fmt(y+h-bl)}`] : []),
    `L${fmt(x)},${fmt(y+tl)}`,
    ...(tl > 0.0005 ? [`C${fmt(x)},${fmt(y+tl-tl*KAPPA)} ${fmt(x+tl-tl*KAPPA)},${fmt(y)} ${fmt(x+tl)},${fmt(y)}`] : []),
    'Z',
  ];
  return parts.join(' ');
}
function ellipsePathData(x,y,w,h){
  const rx = Math.max(0,w)/2, ry = Math.max(0,h)/2, cx = x+rx, cy = y+ry;
  const ox = rx*KAPPA, oy = ry*KAPPA;
  return [
    `M${fmt(cx-rx)},${fmt(cy)}`,
    `C${fmt(cx-rx)},${fmt(cy-oy)} ${fmt(cx-ox)},${fmt(cy-ry)} ${fmt(cx)},${fmt(cy-ry)}`,
    `C${fmt(cx+ox)},${fmt(cy-ry)} ${fmt(cx+rx)},${fmt(cy-oy)} ${fmt(cx+rx)},${fmt(cy)}`,
    `C${fmt(cx+rx)},${fmt(cy+oy)} ${fmt(cx+ox)},${fmt(cy+ry)} ${fmt(cx)},${fmt(cy+ry)}`,
    `C${fmt(cx-ox)},${fmt(cy+ry)} ${fmt(cx-rx)},${fmt(cy+oy)} ${fmt(cx-rx)},${fmt(cy)}`,
    'Z'
  ].join(' ');
}
function polygonPathData(x,y,w,h,sides,star,innerRatio){
  sides = Math.max(3, Math.round(sides||3));
  const n = star ? sides*2 : sides;
  const step = star ? Math.PI/sides : (2*Math.PI/sides);
  const rawPts = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i=0; i<n; i++){
    const angle = -Math.PI/2 + i*step;
    const rf = (star && (i % 2 === 1)) ? clamp(innerRatio==null?0.5:innerRatio, 0.05, 0.95) : 1;
    const px = Math.cos(angle) * rf;
    const py = Math.sin(angle) * rf;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    rawPts.push({ x: px, y: py });
  }
  const rawW = (maxX - minX) || 1e-6;
  const rawH = (maxY - minY) || 1e-6;
  const safeW = Math.max(0.0001, w);
  const safeH = Math.max(0.0001, h);
  const pts = rawPts.map(p => [
    x + ((p.x - minX) / rawW) * safeW,
    y + ((p.y - minY) / rawH) * safeH
  ]);
  return 'M' + pts.map((p,i)=> (i===0?'':'L') + fmt(p[0]) + ',' + fmt(p[1])).join(' ') + ' Z';
}

/* ---------------- Arc / Sector / Donut Path Generator ---------------- */
function arcPathData(cx, cy, rx, ry, startAngleDeg = 0, sweepAngleDeg = 270, isPie = false, innerRatio = 0){
  rx = Math.max(0.001, rx);
  ry = Math.max(0.001, ry);
  const startRad = (startAngleDeg % 360) * Math.PI / 180;
  const sweepRad = clamp(sweepAngleDeg, -360, 360) * Math.PI / 180;

  if (Math.abs(sweepAngleDeg) >= 359.99){
    if (innerRatio > 0.001){
      const irx = rx * innerRatio, iry = ry * innerRatio;
      return ellipsePathData(cx - rx, cy - ry, rx * 2, ry * 2) + ' ' + ellipsePathData(cx - irx, cy - iry, irx * 2, iry * 2);
    }
    return ellipsePathData(cx - rx, cy - ry, rx * 2, ry * 2);
  }

  const numSegs = Math.max(1, Math.ceil(Math.abs(sweepRad) / (Math.PI / 2)));
  const segAngle = sweepRad / numSegs;

  function calcArcBeziers(radiusX, radiusY, angleStart, totalAngle, segs, step){
    const beziers = [];
    let curAng = angleStart;
    for (let s = 0; s < segs; s++){
      const nextAng = curAng + step;
      const alpha = Math.sin(step) * (Math.sqrt(4 + 3 * Math.tan(step / 2) * Math.tan(step / 2)) - 1) / 3;
      const x0 = cx + radiusX * Math.cos(curAng);
      const y0 = cy + radiusY * Math.sin(curAng);
      const x3 = cx + radiusX * Math.cos(nextAng);
      const y3 = cy + radiusY * Math.sin(nextAng);

      const dx0 = -radiusX * Math.sin(curAng);
      const dy0 = radiusY * Math.cos(curAng);
      const dx3 = -radiusX * Math.sin(nextAng);
      const dy3 = radiusY * Math.cos(nextAng);

      const x1 = x0 + alpha * dx0;
      const y1 = y0 + alpha * dy0;
      const x2 = x3 - alpha * dx3;
      const y2 = y3 - alpha * dy3;

      beziers.push({ x0, y0, x1, y1, x2, y2, x3, y3 });
      curAng = nextAng;
    }
    return beziers;
  }

  const outerBeziers = calcArcBeziers(rx, ry, startRad, sweepRad, numSegs, segAngle);
  const parts = [`M${fmt(outerBeziers[0].x0)},${fmt(outerBeziers[0].y0)}`];
  for (const b of outerBeziers){
    parts.push(`C${fmt(b.x1)},${fmt(b.y1)} ${fmt(b.x2)},${fmt(b.y2)} ${fmt(b.x3)},${fmt(b.y3)}`);
  }

  if (innerRatio > 0.001){
    const irx = rx * innerRatio, iry = ry * innerRatio;
    const innerBeziers = calcArcBeziers(irx, iry, startRad + sweepRad, -sweepRad, numSegs, -segAngle);
    parts.push(`L${fmt(innerBeziers[0].x0)},${fmt(innerBeziers[0].y0)}`);
    for (const b of innerBeziers){
      parts.push(`C${fmt(b.x1)},${fmt(b.y1)} ${fmt(b.x2)},${fmt(b.y2)} ${fmt(b.x3)},${fmt(b.y3)}`);
    }
    parts.push('Z');
  } else if (isPie){
    parts.push(`L${fmt(cx)},${fmt(cy)} Z`);
  }

  return parts.join(' ');
}

/* ---------------- Preset Shapes Catalog ---------------- */
const PRESET_SHAPES = {
  pie: {
    name: 'Pie Chart',
    isArc: true,
  },
  triangle: {
    name: 'Triangle',
    generate(x, y, w, h){
      return polygonPathData(x, y, w, h, 3, false);
    }
  },
  diamond: {
    name: 'Diamond',
    generate(x, y, w, h){
      // A cut-gem silhouette reads more cleanly than a stretched square at icon sizes.
      return `M${fmt(x+w*.5)},${fmt(y)} L${fmt(x+w)},${fmt(y+h*.36)} L${fmt(x+w*.82)},${fmt(y+h)} L${fmt(x+w*.18)},${fmt(y+h)} L${fmt(x)},${fmt(y+h*.36)} Z`;
    }
  },
  pentagon: {
    name: 'Pentagon',
    generate(x, y, w, h){
      return polygonPathData(x, y, w, h, 5, false);
    }
  },
  hexagon: {
    name: 'Hexagon',
    generate(x, y, w, h){
      return polygonPathData(x, y, w, h, 6, false);
    }
  },
  star: {
    name: 'Star',
    generate(x, y, w, h){
      return polygonPathData(x, y, w, h, 5, true, 0.48);
    }
  },
  heart: {
    name: 'Heart',
    generate(x, y, w, h){
      const cx = x + w / 2;
      const topY = y + h * 0.28;
      const bottomY = y + h * 0.95;
      const topC = y + h * 0.02;
      return [
        `M${fmt(cx)},${fmt(topY)}`,
        `C${fmt(cx - w * 0.2)},${fmt(topC)} ${fmt(x)},${fmt(y + h * 0.12)} ${fmt(x)},${fmt(y + h * 0.42)}`,
        `C${fmt(x)},${fmt(y + h * 0.65)} ${fmt(cx - w * 0.18)},${fmt(y + h * 0.78)} ${fmt(cx)},${fmt(bottomY)}`,
        `C${fmt(cx + w * 0.18)},${fmt(y + h * 0.78)} ${fmt(x + w)},${fmt(y + h * 0.65)} ${fmt(x + w)},${fmt(y + h * 0.42)}`,
        `C${fmt(x + w)},${fmt(y + h * 0.12)} ${fmt(cx + w * 0.2)},${fmt(topC)} ${fmt(cx)},${fmt(topY)}`,
        'Z'
      ].join(' ');
    }
  },
  arrow: {
    name: 'Arrow',
    generate(x, y, w, h){
      const tipX = x + w;
      const midY = y + h / 2;
      const stemTop = y + h * 0.32;
      const stemBot = y + h * 0.68;
      const headX = x + w * 0.55;
      return `M${fmt(x)},${fmt(stemTop)} L${fmt(headX)},${fmt(stemTop)} L${fmt(headX)},${fmt(y)} L${fmt(tipX)},${fmt(midY)} L${fmt(headX)},${fmt(y + h)} L${fmt(headX)},${fmt(stemBot)} L${fmt(x)},${fmt(stemBot)} Z`;
    }
  },
  lightning: {
    name: 'Lightning',
    generate(x, y, w, h){
      return [
        `M${fmt(x + w * 0.58)},${fmt(y)}`,
        `L${fmt(x + w * 0.18)},${fmt(y + h * 0.52)}`,
        `L${fmt(x + w * 0.48)},${fmt(y + h * 0.52)}`,
        `L${fmt(x + w * 0.38)},${fmt(y + h)}`,
        `L${fmt(x + w * 0.88)},${fmt(y + h * 0.42)}`,
        `L${fmt(x + w * 0.56)},${fmt(y + h * 0.42)}`,
        `Z`
      ].join(' ');
    }
  },
  moon: {
    name: 'Moon',
    generate(x, y, w, h){
      return [
        // One continuous concave contour: avoids the filled-in blob caused by a missing cut-out.
        `M${fmt(x+w*.53)},${fmt(y)}`,
        `C${fmt(x+w*.25)},${fmt(y)} ${fmt(x)},${fmt(y+h*.22)} ${fmt(x)},${fmt(y+h*.5)}`,
        `C${fmt(x)},${fmt(y+h*.78)} ${fmt(x+w*.24)},${fmt(y+h)} ${fmt(x+w*.52)},${fmt(y+h)}`,
        `C${fmt(x+w*.7)},${fmt(y+h)} ${fmt(x+w*.86)},${fmt(y+h*.91)} ${fmt(x+w*.96)},${fmt(y+h*.76)}`,
        `C${fmt(x+w*.78)},${fmt(y+h*.84)} ${fmt(x+w*.58)},${fmt(y+h*.73)} ${fmt(x+w*.5)},${fmt(y+h*.54)}`,
        `C${fmt(x+w*.4)},${fmt(y+h*.31)} ${fmt(x+w*.42)},${fmt(y+h*.12)} ${fmt(x+w*.53)},${fmt(y)}`,
        'Z'
      ].join(' ');
    }
  },
  shield: {
    name: 'Shield',
    generate(x, y, w, h){ return `M${fmt(x+w*.5)},${fmt(y)} L${fmt(x+w)},${fmt(y+h*.16)} L${fmt(x+w)},${fmt(y+h*.53)} C${fmt(x+w)},${fmt(y+h*.78)} ${fmt(x+w*.78)},${fmt(y+h*.94)} ${fmt(x+w*.5)},${fmt(y+h)} C${fmt(x+w*.22)},${fmt(y+h*.94)} ${fmt(x)},${fmt(y+h*.78)} ${fmt(x)},${fmt(y+h*.53)} L${fmt(x)},${fmt(y+h*.16)} Z`; }
  },
  cross: {
    name: 'Cross',
    generate(x, y, w, h){ return `M${fmt(x+w*.32)},${fmt(y)} L${fmt(x+w*.68)},${fmt(y)} L${fmt(x+w*.68)},${fmt(y+h*.32)} L${fmt(x+w)},${fmt(y+h*.32)} L${fmt(x+w)},${fmt(y+h*.68)} L${fmt(x+w*.68)},${fmt(y+h*.68)} L${fmt(x+w*.68)},${fmt(y+h)} L${fmt(x+w*.32)},${fmt(y+h)} L${fmt(x+w*.32)},${fmt(y+h*.68)} L${fmt(x)},${fmt(y+h*.68)} L${fmt(x)},${fmt(y+h*.32)} L${fmt(x+w*.32)},${fmt(y+h*.32)} Z`; }
  },
  check: {
    name: 'Check',
    generate(x, y, w, h){ return `M${fmt(x)},${fmt(y+h*.54)} L${fmt(x+w*.16)},${fmt(y+h*.38)} L${fmt(x+w*.4)},${fmt(y+h*.62)} L${fmt(x+w*.82)},${fmt(y)} L${fmt(x+w)},${fmt(y+h*.18)} L${fmt(x+w*.4)},${fmt(y+h)} Z`; }
  },
  bookmark: {
    name: 'Bookmark',
    generate(x, y, w, h){ const r=w*.1; return `M${fmt(x+r)},${fmt(y)} L${fmt(x+w-r)},${fmt(y)} C${fmt(x+w-r*.45)},${fmt(y)} ${fmt(x+w)},${fmt(y+r*.45)} ${fmt(x+w)},${fmt(y+r)} L${fmt(x+w)},${fmt(y+h)} L${fmt(x+w*.5)},${fmt(y+h*.73)} L${fmt(x)},${fmt(y+h)} L${fmt(x)},${fmt(y+r)} C${fmt(x)},${fmt(y+r*.45)} ${fmt(x+r*.45)},${fmt(y)} ${fmt(x+r)},${fmt(y)} Z`; }
  },
  speechBubble: {
    name: 'Speech Bubble',
    generate(x, y, w, h){
      const r = Math.min(w * 0.15, h * 0.15);
      const kr = r * KAPPA;
      const by = y + h * 0.78;
      return [
        `M${fmt(x + r)},${fmt(y)}`,
        `L${fmt(x + w - r)},${fmt(y)}`,
        `C${fmt(x + w - r + kr)},${fmt(y)} ${fmt(x + w)},${fmt(y + r - kr)} ${fmt(x + w)},${fmt(y + r)}`,
        `L${fmt(x + w)},${fmt(by - r)}`,
        `C${fmt(x + w)},${fmt(by - r + kr)} ${fmt(x + w - r + kr)},${fmt(by)} ${fmt(x + w - r)},${fmt(by)}`,
        `L${fmt(x + w * 0.42)},${fmt(by)}`,
        `L${fmt(x + w * 0.2)},${fmt(y + h)}`,
        `L${fmt(x + w * 0.25)},${fmt(by)}`,
        `L${fmt(x + r)},${fmt(by)}`,
        `C${fmt(x + r - kr)},${fmt(by)} ${fmt(x)},${fmt(by - r + kr)} ${fmt(x)},${fmt(by - r)}`,
        `L${fmt(x)},${fmt(y + r)}`,
        `C${fmt(x)},${fmt(y + r - kr)} ${fmt(x + r - kr)},${fmt(y)} ${fmt(x + r)},${fmt(y)}`,
        'Z'
      ].join(' ');
    }
  }
};

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
    default:        return 'M0,0';
  }
}

/* =====================================================================================
   Shape model
   ===================================================================================== */
const TYPE_LABEL = { rect:'Rectangle', ellipse:'Ellipse', polygon:'Polygon', arc:'Arc / Sector', line:'Line', path:'Path', curve:'Bézier Curve' };
let __shapeCounter = { rect:0, ellipse:0, polygon:0, arc:0, line:0, path:0, curve:0 };
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
    strokeEnabled: false,
    strokeColor: '#000000',
    strokeOpacity: 1,
    strokeWidth: 1,
    strokeInnerWidth: 0,
    strokeOuterWidth: 0,
    strokeLineCap: 'butt',
    strokeLineJoin: 'miter',
    strokeMiterLimit: 4,
  };
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
function createCurveShape(p1OrX1, cp1OrY1, cp2OrX2, p2OrY2){
  const s = makeBaseShape('curve');
  s.name = defaultShapeName('curve');
  s.fillEnabled = false;
  s.strokeEnabled = true;
  s.strokeColor = state.lastStrokeColor || '#6FA8FF';
  s.strokeWidth = state.lastStrokeWidth || 2;
  s.strokeLineCap = 'round';
  s.strokeLineJoin = 'round';

  if (typeof p1OrX1 === 'object' && p1OrX1 !== null){
    const p1 = p1OrX1, cp1 = cp1OrY1, cp2 = cp2OrX2, p2 = p2OrY2;
    s.x1 = p1.x; s.y1 = p1.y;
    s.cp1x = cp1.x; s.cp1y = cp1.y;
    s.cp2x = cp2.x; s.cp2y = cp2.y;
    s.x2 = p2.x; s.y2 = p2.y;
  } else {
    const x1 = p1OrX1, y1 = cp1OrY1, x2 = cp2OrX2, y2 = p2OrY2;
    s.x1 = x1; s.y1 = y1;
    s.x2 = x2; s.y2 = y2;
    const dx = x2 - x1, dy = y2 - y1;
    s.cp1x = x1 + dx * 0.25 - dy * 0.3;
    s.cp1y = y1 + dy * 0.25 + dx * 0.3;
    s.cp2x = x1 + dx * 0.75 - dy * 0.3;
    s.cp2y = y1 + dy * 0.75 + dx * 0.3;
  }
  s.rawD = `M${fmt(s.x1)},${fmt(s.y1)} C${fmt(s.cp1x)},${fmt(s.cp1y)} ${fmt(s.cp2x)},${fmt(s.cp2y)} ${fmt(s.x2)},${fmt(s.y2)}`;
  const bbox = measurePathBBox(s.rawD);
  s.pivotX = (s.x1 + s.x2) / 2;
  s.pivotY = (s.y1 + s.y2) / 2;
  s.nativeWidth = Math.max(0.0001, bbox.width);
  s.nativeHeight = Math.max(0.0001, bbox.height);
  return s;
}
function insertPresetShape(presetKey, targetBounds = null){
  const def = PRESET_SHAPES[presetKey];
  if (!def) return null;
  const vw = state.doc.viewportWidth, vh = state.doc.viewportHeight;
  let x, y, w, h;
  if (targetBounds){
    x = targetBounds.x; y = targetBounds.y; w = targetBounds.width; h = targetBounds.height;
  } else {
    w = vw * 0.6; h = vh * 0.6;
    x = (vw - w) / 2; y = (vh - h) / 2;
  }
  let shape;
  if (def.isArc){
    // Real Arc shape (not a flattened path) — opens straight into the Arc/Pie panel and
    // the on-canvas angle handles so the "opening" is adjustable right away.
    shape = createArcShape(x, y, w, h, -90, 270, true, 0);
    shape.name = def.name;
    shape.fillColor = state.lastFillColor || '#5EE1A0';
    shape.strokeColor = state.lastStrokeColor || '#5EE1A0';
  } else {
    const d = def.generate(x, y, w, h);
    shape = createPathShape(d);
    shape.name = def.name;
    shape.fillColor = state.lastFillColor || '#5EE1A0';
    shape.strokeColor = state.lastStrokeColor || '#5EE1A0';
  }
  doAction(() => {
    state.shapes.push(shape);
    state.selectedIds = [shape.id];
  });
  renderAll();
  showToast(`Added ${def.name} preset`);
  return shape;
}

function createLineShape(x1, y1, x2, y2){
  const s = makeBaseShape('line');
  s.name = defaultShapeName('line');
  s.fillEnabled = false;
  s.strokeEnabled = true;
  s.strokeColor = state.lastStrokeColor || '#5EE1A0';
  s.strokeWidth = state.lastStrokeWidth || 2;
  s.strokeLineCap = 'round';
  s.strokeLineJoin = 'round';
  s.x1 = x1;
  s.y1 = y1;
  s.x2 = x2;
  s.y2 = y2;
  s.rawD = `M${fmt(x1)},${fmt(y1)} L${fmt(x2)},${fmt(y2)}`;
  const bbox = measurePathBBox(s.rawD);
  s.pivotX = (x1 + x2) / 2;
  s.pivotY = (y1 + y2) / 2;
  s.nativeWidth = Math.max(0.0001, bbox.width);
  s.nativeHeight = Math.max(0.0001, bbox.height);
  return s;
}

function isLineShape(shape){
  if (!shape) return false;
  if (shape.type === 'line') return true;
  if (shape.type === 'path' && shape.rawD){
    const sub = parseSvgPathToSubpaths(shape.rawD);
    if (sub.length === 1 && !sub[0].closed && sub[0].points.length === 2){
      return true;
    }
  }
  return false;
}

function shapePointToStage(shape, pt){
  const pivot = shapeLocalPivot(shape);
  const scaleX = shape.scaleX ?? 1;
  const scaleY = shape.scaleY ?? 1;
  const rotRad = ((shape.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rotRad);
  const sin = Math.sin(rotRad);
  const dx = (pt.x - pivot.x) * scaleX;
  const dy = (pt.y - pivot.y) * scaleY;
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  return {
    x: rx + pivot.x + (shape.translateX || 0),
    y: ry + pivot.y + (shape.translateY || 0),
  };
}

function getLineEndpointsStage(shape){
  if (!shape) return { p1: { x:0, y:0 }, p2: { x:0, y:0 } };
  let rawP1, rawP2;
  if (shape.x1 != null && shape.y1 != null && shape.x2 != null && shape.y2 != null){
    rawP1 = { x: shape.x1, y: shape.y1 };
    rawP2 = { x: shape.x2, y: shape.y2 };
  } else if (shape.rawD){
    const sub = parseSvgPathToSubpaths(shape.rawD);
    if (sub.length && sub[0].points.length >= 2){
      rawP1 = sub[0].points[0];
      rawP2 = sub[0].points[sub[0].points.length - 1];
    } else {
      rawP1 = { x: 0, y: 0 };
      rawP2 = { x: 10, y: 10 };
    }
  } else {
    rawP1 = { x: 0, y: 0 };
    rawP2 = { x: 10, y: 10 };
  }
  return {
    p1: shapePointToStage(shape, rawP1),
    p2: shapePointToStage(shape, rawP2)
  };
}

function setLineEndpointsStage(shape, p1Stage, p2Stage){
  shape.rotation = 0;
  shape.scaleX = 1;
  shape.scaleY = 1;
  shape.translateX = 0;
  shape.translateY = 0;
  shape.type = 'line';
  shape.x1 = p1Stage.x;
  shape.y1 = p1Stage.y;
  shape.x2 = p2Stage.x;
  shape.y2 = p2Stage.y;
  const d = `M${fmt(p1Stage.x)},${fmt(p1Stage.y)} L${fmt(p2Stage.x)},${fmt(p2Stage.y)}`;
  shape.rawD = d;
  const bbox = measurePathBBox(d);
  shape.pivotX = (p1Stage.x + p2Stage.x) / 2;
  shape.pivotY = (p1Stage.y + p2Stage.y) / 2;
  shape.nativeWidth = Math.max(0.0001, bbox.width);
  shape.nativeHeight = Math.max(0.0001, bbox.height);
}

function getShapePointsInStage(shape){
  if (!shape) return [];
  if (isLineShape(shape)){
    const pts = getLineEndpointsStage(shape);
    return [pts.p1, pts.p2];
  }
  if (shape.type === 'path' && shape.rawD){
    const sub = parseSvgPathToSubpaths(shape.rawD);
    if (sub.length && sub[0].points.length){
      return sub[0].points.map(p => shapePointToStage(shape, p));
    }
  }
  return [];
}

function findConnectableEndpoints(excludeShapeId){
  const results = [];
  for (const s of state.shapes){
    if (!s.visible || s.locked || (excludeShapeId && s.id === excludeShapeId)) continue;
    if (isLineShape(s)){
      const pts = getLineEndpointsStage(s);
      results.push({ shape: s, point: pts.p1, handle: 'line-p1', isStart: true, isEnd: false });
      results.push({ shape: s, point: pts.p2, handle: 'line-p2', isStart: false, isEnd: true });
    } else if (s.type === 'path' && s.rawD){
      const sub = parseSvgPathToSubpaths(s.rawD);
      if (sub.length === 1 && !sub[0].closed && sub[0].points.length >= 2){
        const pts = sub[0].points;
        results.push({ shape: s, point: shapePointToStage(s, pts[0]), handle: 'path-start', isStart: true, isEnd: false });
        results.push({ shape: s, point: shapePointToStage(s, pts[pts.length - 1]), handle: 'path-end', isStart: false, isEnd: true });
      }
    }
  }
  return results;
}

function getClosestEndpointSnap(stagePt, excludeShapeId, thresholdPx = 15){
  const z = state.view.zoom || 1;
  const maxDistStage = thresholdPx / (PX_PER_UNIT * z);
  const candidates = findConnectableEndpoints(excludeShapeId);
  let best = null;
  let bestDist = maxDistStage;

  for (const cand of candidates){
    const d = Math.hypot(stagePt.x - cand.point.x, stagePt.y - cand.point.y);
    if (d < bestDist){
      bestDist = d;
      best = cand;
    }
  }

  if (best){
    return {
      snappedPoint: { x: best.point.x, y: best.point.y },
      targetShape: best.shape,
      candidate: best,
      dist: bestDist
    };
  }
  return null;
}

function joinTwoShapes(shapeA, shapeB){
  if (!shapeA || !shapeB || shapeA.id === shapeB.id) return null;
  const ptsA = getShapePointsInStage(shapeA);
  const ptsB = getShapePointsInStage(shapeB);
  if (ptsA.length < 2 || ptsB.length < 2) return null;

  const aStart = ptsA[0], aEnd = ptsA[ptsA.length - 1];
  const bStart = ptsB[0], bEnd = ptsB[ptsB.length - 1];

  const d_aEnd_bStart = Math.hypot(aEnd.x - bStart.x, aEnd.y - bStart.y);
  const d_aEnd_bEnd   = Math.hypot(aEnd.x - bEnd.x, aEnd.y - bEnd.y);
  const d_aStart_bEnd = Math.hypot(aStart.x - bEnd.x, aStart.y - bEnd.y);
  const d_aStart_bStart = Math.hypot(aStart.x - bStart.x, aStart.y - bStart.y);

  const minD = Math.min(d_aEnd_bStart, d_aEnd_bEnd, d_aStart_bEnd, d_aStart_bStart);
  let combined = [];

  if (minD === d_aEnd_bStart){
    combined = [...ptsA, ...ptsB.slice(1)];
  } else if (minD === d_aEnd_bEnd){
    combined = [...ptsA, ...ptsB.slice(0, -1).reverse()];
  } else if (minD === d_aStart_bEnd){
    combined = [...ptsB, ...ptsA.slice(1)];
  } else {
    combined = [...ptsA.slice().reverse(), ...ptsB.slice(1)];
  }

  // Check if outer endpoints also meet to close the loop
  const outerDist = Math.hypot(combined[0].x - combined[combined.length - 1].x, combined[0].y - combined[combined.length - 1].y);
  const isClosed = combined.length > 2 && outerDist < 1.0;
  if (isClosed){
    combined = combined.slice(0, -1);
  }

  let dStr = 'M' + fmt(combined[0].x) + ',' + fmt(combined[0].y);
  for (let i = 1; i < combined.length; i++){
    dStr += ' L' + fmt(combined[i].x) + ',' + fmt(combined[i].y);
  }
  if (isClosed) dStr += ' Z';

  const newShape = createPathShape(dStr, {
    name: isClosed ? 'Closed Polygon' : 'Connected Path',
    strokeEnabled: true,
    strokeColor: shapeA.strokeColor || shapeB.strokeColor || state.lastStrokeColor || '#5EE1A0',
    strokeWidth: shapeA.strokeWidth || shapeB.strokeWidth || state.lastStrokeWidth || 2,
    strokeLineCap: shapeA.strokeLineCap || 'round',
    strokeLineJoin: shapeA.strokeLineJoin || 'round',
    fillEnabled: isClosed ? (shapeA.fillEnabled || shapeB.fillEnabled) : false,
    fillColor: shapeA.fillColor || shapeB.fillColor || state.lastFillColor || '#6FA8FF',
  });

  const idxA = state.shapes.indexOf(shapeA);
  state.shapes = state.shapes.filter(s => s.id !== shapeA.id && s.id !== shapeB.id);
  if (idxA >= 0 && idxA <= state.shapes.length){
    state.shapes.splice(idxA, 0, newShape);
  } else {
    state.shapes.push(newShape);
  }
  state.selectedIds = [newShape.id];
  return newShape;
}

function joinSelectedLinesAction(){
  const sel = selectedShapes().filter(s => isLineShape(s) || (s.type === 'path' && !s.locked));
  if (sel.length < 2){
    showToast('Select 2 or more lines or open paths to connect');
    return;
  }
  doAction(() => {
    let current = sel[0];
    for (let i = 1; i < sel.length; i++){
      const merged = joinTwoShapes(current, sel[i]);
      if (merged) current = merged;
    }
    showToast('Connected ' + sel.length + ' shapes into continuous path');
  });
}

function disconnectShapeIntoLines(shape){
  if (!shape) return [];
  if (shape.type === 'line'){
    return [shape];
  }
  if (shape.type !== 'path' || !shape.rawD){
    return [shape];
  }

  const subpaths = parseSvgPathToSubpaths(shape.rawD);
  if (!subpaths.length) return [shape];

  const newShapes = [];
  let segIndex = 0;

  for (const sub of subpaths){
    const pts = sub.points;
    if (pts.length < 2) continue;

    // Convert points to stage coordinates
    const stagePts = pts.map(p => shapePointToStage(shape, p));
    const count = sub.closed ? stagePts.length : stagePts.length - 1;

    for (let i = 0; i < count; i++){
      const p1 = stagePts[i];
      const p2 = stagePts[(i + 1) % stagePts.length];

      const line = createLineShape(p1.x, p1.y, p2.x, p2.y);
      line.name = (shape.name ? shape.name.replace(/ Path| Connected| Closed Polygon/gi, '') : 'Line') + ' ' + (segIndex + 1);
      line.strokeEnabled = shape.strokeEnabled != null ? shape.strokeEnabled : true;
      line.strokeColor = shape.strokeColor || state.lastStrokeColor || '#5EE1A0';
      line.strokeWidth = shape.strokeWidth || state.lastStrokeWidth || 2;
      line.strokeOpacity = shape.strokeOpacity ?? 1;
      line.strokeLineCap = shape.strokeLineCap || 'round';
      line.strokeLineJoin = shape.strokeLineJoin || 'round';
      line.strokeMiterLimit = shape.strokeMiterLimit || 4;
      line.fillEnabled = false;
      line.groupId = shape.groupId;
      newShapes.push(line);
      segIndex++;
    }
  }

  if (!newShapes.length) return [shape];

  const idx = state.shapes.indexOf(shape);
  if (idx >= 0){
    state.shapes.splice(idx, 1, ...newShapes);
  } else {
    state.shapes = state.shapes.filter(s => s.id !== shape.id).concat(newShapes);
  }

  return newShapes;
}

function disconnectSelectedLinesAction(){
  const sel = selectedShapes().filter(s => !s.locked && (s.type === 'path' || isLineShape(s)));
  if (!sel.length){
    showToast('Select a connected path or line to disconnect');
    return;
  }
  doAction(() => {
    const allNewShapes = [];
    for (const shape of sel){
      const created = disconnectShapeIntoLines(shape);
      allNewShapes.push(...created);
    }
    state.selectedIds = allNewShapes.map(s => s.id);
    showToast(`Disconnected into ${allNewShapes.length} separate line${allNewShapes.length>1?'s':''}`);
  });
}

function shapeLocalPivot(shape){
  if (shape.type === 'line'){
    if (shape.pivotX != null && shape.pivotY != null) return { x: shape.pivotX, y: shape.pivotY };
    if (shape.x1 != null && shape.x2 != null) return { x: (shape.x1 + shape.x2)/2, y: (shape.y1 + shape.y2)/2 };
  }
  if (shape.type === 'path' || shape.type === 'curve') return { x: shape.pivotX, y: shape.pivotY };
  return { x: shape.x + shape.width/2, y: shape.y + shape.height/2 };
}
function shapeHasTransform(shape){
  return !!shape.rotation || shape.scaleX !== 1 || shape.scaleY !== 1 ||
    Math.abs(shape.translateX||0) > 1e-9 || Math.abs(shape.translateY||0) > 1e-9;
}
function shapeGroupTransformStr(shape){
  const p = shapeLocalPivot(shape);
  const tx = shape.translateX||0, ty = shape.translateY||0;
  const parts = [];
  parts.push(`translate(${fmt(p.x+tx)} ${fmt(p.y+ty)})`);
  if (shape.rotation) parts.push(`rotate(${fmt(shape.rotation)})`);
  if (shape.scaleX !== 1 || shape.scaleY !== 1) parts.push(`scale(${fmt(shape.scaleX)} ${fmt(shape.scaleY)})`);
  parts.push(`translate(${fmt(-p.x)} ${fmt(-p.y)})`);
  return parts.join(' ');
}
function getShapePos(shape){
  if (shape.type === 'line') return { x: shape.x1 ?? 0, y: shape.y1 ?? 0 };
  if (shape.type === 'path' || shape.type === 'curve') return { x: shape.translateX||0, y: shape.translateY||0 };
  return { x: shape.x, y: shape.y };
}
function setShapePos(shape, x, y){
  if (shape.type === 'line'){
    const dx = x - (shape.x1 ?? 0), dy = y - (shape.y1 ?? 0);
    shape.x1 = x;
    shape.y1 = y;
    shape.x2 = (shape.x2 ?? 0) + dx;
    shape.y2 = (shape.y2 ?? 0) + dy;
    setLineEndpointsStage(shape, { x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 });
  } else if (shape.type === 'path' || shape.type === 'curve'){
    shape.translateX = x; shape.translateY = y;
  } else {
    shape.x = x; shape.y = y;
  }
}
function moveShapeBy(shape, dx, dy){
  const p = getShapePos(shape);
  setShapePos(shape, p.x+dx, p.y+dy);
}
function getShapeNativeSize(shape){
  if (shape.type === 'line'){
    const lb = localBBoxForShape(shape);
    return { width: lb.width, height: lb.height };
  }
  if (shape.type === 'path' || shape.type === 'curve') return { width: shape.nativeWidth, height: shape.nativeHeight };
  return { width: shape.width, height: shape.height };
}
function shapeHasFillOrStroke(shape){
  return shape.fillEnabled || shape.strokeEnabled || (shape.strokeInnerWidth || 0) > 0 || (shape.strokeOuterWidth || 0) > 0;
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
  lineDraft: null,
  lineHoverPoint: null,
  lineStartSnap: null,
  arcDraft: null,
  arcHoverPoint: null,
  curveDraft: null,
  curveHoverPoint: null,
  cutActive: false,
  cutPoints: [],
  cutPreview: null,
  hoveredShapeId: null,
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
  DOM.homeImportProject = document.getElementById('homeImportProject');
  DOM.homeNewProject = document.getElementById('homeNewProject');
  DOM.homeInfoBtn = document.getElementById('homeInfoBtn');
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
  pattern.appendChild(svgEl('rect', { width:2, height:2, fill:'#20232c' }));
  pattern.appendChild(svgEl('rect', { width:1, height:1, fill:'#282c37' }));
  pattern.appendChild(svgEl('rect', { x:1, y:1, width:1, height:1, fill:'#282c37' }));
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
  const w = d.viewportWidth * PX_PER_UNIT * z;
  const h = d.viewportHeight * PX_PER_UNIT * z;
  DOM.stage.setAttribute('viewBox', `0 0 ${d.viewportWidth} ${d.viewportHeight}`);
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
  state.view.panX = Math.round((rect.width - w) / 2);
  state.view.panY = Math.round((rect.height - h) / 2);
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
}

function maybeSnap(v){
  if (!state.grid.snap) return v;
  const s = state.grid.snapSize || 1;
  return Math.round(v / s) * s;
}

/* =====================================================================================
   Part 3: rendering — artboard/grid, shapes, selection overlay
   ===================================================================================== */
function findShapeById(id){ return state.shapes.find(s => s.id === id) || null; }
function selectedShapes(){ return state.selectedIds.map(findShapeById).filter(Boolean); }
function shapeIndex(id){ return state.shapes.findIndex(s => s.id === id); }

function buildShapeFillStrokeAttrs(shape){
  return {
    fill: shape.fillEnabled ? shape.fillColor : 'none',
    'fill-opacity': shape.fillEnabled ? shape.fillOpacity : null,
    'fill-rule': shape.fillType === 'evenOdd' ? 'evenodd' : 'nonzero',
    stroke: shape.strokeEnabled ? shape.strokeColor : 'none',
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
  const path = svgEl('path', Object.assign({ d: shapePathData(shape) }, buildShapeFillStrokeAttrs(shape)));
  g.appendChild(path);
  return g;
}

function renderArtboardAndGrid(){
  gArtboard.innerHTML = '';
  gGrid.innerHTML = '';
  const d = state.doc;
  const w = d.viewportWidth, h = d.viewportHeight;

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
    let step = 1;
    while ((w/step) > 60 || (h/step) > 60) step *= 2;
    const minor = svgEl('g', { stroke:'#3a4050', 'stroke-width':1, 'vector-effect':'non-scaling-stroke', opacity:0.55 });
    for (let x = step; x < w; x += step){
      minor.appendChild(svgEl('line', { x1:x, y1:0, x2:x, y2:h }));
    }
    for (let y = step; y < h; y += step){
      minor.appendChild(svgEl('line', { x1:0, y1:y, x2:w, y2:y }));
    }
    gGrid.appendChild(minor);

    const mid = svgEl('g', { stroke:'#4a5266', 'stroke-width':1, 'vector-effect':'non-scaling-stroke', opacity:0.8 });
    mid.appendChild(svgEl('line', { x1:w/2, y1:0, x2:w/2, y2:h }));
    mid.appendChild(svgEl('line', { x1:0, y1:h/2, x2:w, y2:h/2 }));
    gGrid.appendChild(mid);
  }

  if (state.grid.keyline){
    const kg = svgEl('g', { fill:'none', stroke:'#5EE1A0', 'stroke-width':1, 'vector-effect':'non-scaling-stroke', opacity:0.35, 'stroke-dasharray':'3 2' });
    const cx = w/2, cy = h/2;
    kg.appendChild(svgEl('circle', { cx, cy, r: Math.min(w,h) * (10/24) }));
    const sq = w * (18/24), sqh = h * (18/24);
    kg.appendChild(svgEl('rect', { x: cx - sq/2, y: cy - sqh/2, width: sq, height: sqh }));
    gGrid.appendChild(kg);
  }

  gGrid.appendChild(svgEl('rect', { x:0, y:0, width:w, height:h, fill:'none', stroke:'#5a6376', 'stroke-width':1.25, 'vector-effect':'non-scaling-stroke' }));
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
    // An outer stroke is painted under the fill; the fill hides its inner half.
    // The inner stroke is clipped to the path interior, so both widths can coexist.
    if (outerWidth > 0){
      const outer = svgEl('path', { d, fill:'none', stroke:shape.strokeColor, 'stroke-opacity':shape.strokeOpacity, 'stroke-width':outerWidth * 2, 'stroke-linecap':shape.strokeLineCap, 'stroke-linejoin':shape.strokeLineJoin, 'stroke-miterlimit':shape.strokeMiterLimit });
      outer.setAttribute('pointer-events', 'none');
      xform.appendChild(outer);
    }
    const visible = svgEl('path', Object.assign({ d }, buildShapeFillStrokeAttrs(visibleAttrsSafe(shape))));
    visible.setAttribute('pointer-events', 'none');
    xform.appendChild(hit);
    xform.appendChild(visible);
    if (innerWidth > 0){
      const clipId = 'stroke-inner-' + shape.id;
      const defs = svgEl('defs');
      const clip = svgEl('clipPath', { id:clipId });
      clip.appendChild(svgEl('path', { d, 'clip-rule':shape.fillType === 'evenOdd' ? 'evenodd' : 'nonzero' }));
      defs.appendChild(clip);
      xform.appendChild(defs);
      const inner = svgEl('path', { d, fill:'none', stroke:shape.strokeColor, 'stroke-opacity':shape.strokeOpacity, 'stroke-width':innerWidth * 2, 'stroke-linecap':shape.strokeLineCap, 'stroke-linejoin':shape.strokeLineJoin, 'stroke-miterlimit':shape.strokeMiterLimit, 'clip-path':'url(#' + clipId + ')' });
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
  if (shape.type === 'path' || shape.type === 'curve'){
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
  if (shape.type === 'path' || shape.type === 'curve'){
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
      stroke: '#5EE1A0',
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

  if (state.tool === 'line' && state.lineDraft && state.lineHoverPoint){
    const p1 = state.lineDraft, p2 = state.lineHoverPoint;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);

    gOverlay.appendChild(svgEl('line', {
      x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
      stroke: state.lastStrokeColor || 'var(--accent)',
      'stroke-width': Math.max(1.2, (state.lastStrokeWidth || 2)),
      'stroke-dasharray': '3 2',
      'stroke-linecap': 'round',
      'vector-effect': 'non-scaling-stroke',
      'pointer-events': 'none',
      opacity: 0.9,
    }));
    gOverlay.appendChild(svgEl('circle', {
      cx: p1.x, cy: p1.y, r: hs * 0.65,
      fill: 'var(--accent)', stroke: '#12141C', 'stroke-width': 1.2,
      'pointer-events': 'none'
    }));
    gOverlay.appendChild(svgEl('circle', {
      cx: p2.x, cy: p2.y, r: hs * 0.65,
      fill: 'var(--accent)', stroke: '#12141C', 'stroke-width': 1.2,
      opacity: 0.75,
      'pointer-events': 'none'
    }));
  }

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
      fill: '#5EE1A0',
    }));
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
        fill: '#5EE1A0',
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
        fill: '#5EE1A0',
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
      fill: isSelected ? '#5EE1A0' : '#FFFFFF',
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
  updateUndoRedoButtons();
}
function doAction(mutateFn){ beginEdit(); mutateFn(); commitEdit(); renderAll(); }
function undo(){
  if (!state.history.past.length) return;
  const cur = snapshotState();
  const prev = state.history.past.pop();
  state.history.future.push(cur);
  restoreSnapshot(prev);
  renderAll();
  updateUndoRedoButtons();
}
function redo(){
  if (!state.history.future.length) return;
  const cur = snapshotState();
  const next = state.history.future.pop();
  state.history.past.push(cur);
  restoreSnapshot(next);
  renderAll();
  updateUndoRedoButtons();
}
function updateUndoRedoButtons(){
  DOM.btnUndo.disabled = state.history.past.length === 0;
  DOM.btnRedo.disabled = state.history.future.length === 0;
}

/* ---------------- selection ---------------- */
function selectOnly(id){
  if (!id){ state.selectedIds = []; return; }
  const s = findShapeById(id);
  if (s && s.groupId){
    state.selectedIds = state.shapes.filter(x => x.groupId === s.groupId && !x.locked).map(x => x.id);
  } else {
    state.selectedIds = [id];
  }
}
function toggleSelectId(id){
  const s = findShapeById(id);
  const targetIds = (s && s.groupId) ? state.shapes.filter(x => x.groupId === s.groupId && !x.locked).map(x => x.id) : [id];
  const allSelected = targetIds.every(tId => state.selectedIds.includes(tId));
  if (allSelected){
    state.selectedIds = state.selectedIds.filter(tId => !targetIds.includes(tId));
  } else {
    for (const tId of targetIds){
      if (!state.selectedIds.includes(tId)) state.selectedIds.push(tId);
    }
  }
}
function selectAllShapes(){ state.selectedIds = state.shapes.filter(s => !s.locked).map(s => s.id); }
function clearSelection(){ state.selectedIds = []; }

/* ---------------- shape grouping ---------------- */
function groupSelectedShapes(){
  const sel = selectedShapes().filter(s => !s.locked);
  if (sel.length < 2) return;
  const newGroupId = uid('group');
  if (!state.groups) state.groups = {};
  state.groups[newGroupId] = { id: newGroupId, name: 'Group ' + (Object.keys(state.groups).length + 1), expanded: true };
  doAction(() => {
    for (const s of sel){
      s.groupId = newGroupId;
    }
  });
  showToast('Grouped ' + sel.length + ' layers');
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
   BOOLEAN OPERATIONS & POLYGON CLIPPING ENGINE
   (Union, Subtract / Cut, Intersect, Exclude / XOR)
   ===================================================================================== */

function transformPathDataWithMatrix(d, mat){
  if (!d) return 'M0,0';
  const cmdRegex = /([a-df-z])([^a-df-z]*)/gi;
  let match;
  const out = [];
  let curX = 0, curY = 0;
  let startX = 0, startY = 0;

  while ((match = cmdRegex.exec(d))){
    const cmd = match[1];
    const isRel = cmd === cmd.toLowerCase();
    const type = cmd.toUpperCase();
    const nums = match[2].trim().split(/[\s,]+/).filter(s=>s.length).map(Number);
    let i = 0;

    switch(type){
      case 'M': {
        while (i < nums.length){
          let x = isRel ? curX + nums[i] : nums[i];
          let y = isRel ? curY + nums[i+1] : nums[i+1];
          const tp = mat.transformPoint(x, y);
          out.push(`${i === 0 ? 'M' : 'L'}${fmt(tp.x)},${fmt(tp.y)}`);
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
          const tp = mat.transformPoint(x, y);
          out.push(`L${fmt(tp.x)},${fmt(tp.y)}`);
          curX = x; curY = y;
          i += 2;
        }
        break;
      }
      case 'H': {
        while (i < nums.length){
          let x = isRel ? curX + nums[i] : nums[i];
          let y = curY;
          const tp = mat.transformPoint(x, y);
          out.push(`L${fmt(tp.x)},${fmt(tp.y)}`);
          curX = x;
          i += 1;
        }
        break;
      }
      case 'V': {
        while (i < nums.length){
          let x = curX;
          let y = isRel ? curY + nums[i] : nums[i];
          const tp = mat.transformPoint(x, y);
          out.push(`L${fmt(tp.x)},${fmt(tp.y)}`);
          curY = y;
          i += 1;
        }
        break;
      }
      case 'C': {
        while (i + 5 < nums.length){
          let x1 = isRel ? curX + nums[i] : nums[i];
          let y1 = isRel ? curY + nums[i+1] : nums[i+1];
          let x2 = isRel ? curX + nums[i+2] : nums[i+2];
          let y2 = isRel ? curY + nums[i+3] : nums[i+3];
          let x = isRel ? curX + nums[i+4] : nums[i+4];
          let y = isRel ? curY + nums[i+5] : nums[i+5];
          const p1 = mat.transformPoint(x1, y1);
          const p2 = mat.transformPoint(x2, y2);
          const p = mat.transformPoint(x, y);
          out.push(`C${fmt(p1.x)},${fmt(p1.y)} ${fmt(p2.x)},${fmt(p2.y)} ${fmt(p.x)},${fmt(p.y)}`);
          curX = x; curY = y;
          i += 6;
        }
        break;
      }
      case 'Z': {
        out.push('Z');
        curX = startX; curY = startY;
        break;
      }
      default: {
        // For unhandled commands, preserve original
        out.push(`${cmd}${match[2]}`);
        break;
      }
    }
  }
  return out.join(' ');
}

function getShapeTransformedPath(shape){
  const d = shapePathData(shape);
  const p = shapeLocalPivot(shape);
  const tx = shape.translateX || 0;
  const ty = shape.translateY || 0;
  const rot = shape.rotation || 0;
  const sx = shape.scaleX ?? 1;
  const sy = shape.scaleY ?? 1;

  if (!rot && sx === 1 && sy === 1 && !tx && !ty){
    return d;
  }

  const mat = Mat2D.translate(p.x + tx, p.y + ty)
    .multiply(Mat2D.rotateDeg(rot))
    .multiply(Mat2D.scale(sx, sy))
    .multiply(Mat2D.translate(-p.x, -p.y));

  return transformPathDataWithMatrix(d, mat);
}

/* =====================================================================================
   STROKE-AWARE SVG PATH DISCRETIZATION & POLYGON CLIPPING ENGINE
   (Union, Subtract / Cut, Intersect, Exclude / XOR, Stroke Expander, Presets)
   ===================================================================================== */

function extractNumbers(str){
  if (!str) return [];
  const matches = str.match(/[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g);
  return matches ? matches.map(Number) : [];
}

function sampleCubicBezier(p0, p1, p2, p3, samples = 16){
  const pts = [];
  for (let i = 1; i <= samples; i++){
    const t = i / samples;
    const it = 1 - t;
    const px = it*it*it*p0.x + 3*it*it*t*p1.x + 3*it*t*t*p2.x + t*t*t*p3.x;
    const py = it*it*it*p0.y + 3*it*it*t*p1.y + 3*it*t*t*p2.y + t*t*t*p3.y;
    pts.push({ x: px, y: py });
  }
  return pts;
}

function sampleQuadBezier(p0, p1, p2, samples = 16){
  const pts = [];
  for (let i = 1; i <= samples; i++){
    const t = i / samples;
    const it = 1 - t;
    const px = it*it*p0.x + 2*it*t*p1.x + t*t*p2.x;
    const py = it*it*p0.y + 2*it*t*p1.y + t*t*p2.y;
    pts.push({ x: px, y: py });
  }
  return pts;
}

function sampleSvgArc(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2, samples = 16){
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx < 1e-6 || ry < 1e-6) return [{ x: x2, y: y2 }];
  const phi = (phiDeg || 0) * Math.PI / 180;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  
  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1){
    const s = Math.sqrt(lambda);
    rx *= s; ry *= s;
  }
  
  const sign = fa === fs ? -1 : 1;
  const sq = Math.max(0, (rx*rx*ry*ry - rx*rx*y1p*y1p - ry*ry*x1p*x1p) / (rx*rx*y1p*y1p + ry*ry*x1p*x1p + 1e-12));
  const coef = sign * Math.sqrt(sq);
  const cxp = coef * (rx * y1p / ry);
  const cyp = coef * -(ry * x1p / rx);
  
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  
  function calcAngle(u, v){
    const dot = u.x * v.x + u.y * v.y;
    const len = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y);
    let ang = Math.acos(Math.max(-1, Math.min(1, dot / (len || 1))));
    if (u.x * v.y - u.y * v.x < 0) ang = -ang;
    return ang;
  }
  
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  let theta1 = calcAngle({ x: 1, y: 0 }, { x: ux, y: uy });
  let dTheta = calcAngle({ x: ux, y: uy }, { x: vx, y: vy });
  
  if (!fs && dTheta > 0) dTheta -= 2 * Math.PI;
  else if (fs && dTheta < 0) dTheta += 2 * Math.PI;
  
  const pts = [];
  for (let i = 1; i <= samples; i++){
    const t = i / samples;
    const ang = theta1 + t * dTheta;
    const ex = rx * Math.cos(ang), ey = ry * Math.sin(ang);
    const px = cosPhi * ex - sinPhi * ey + cx;
    const py = sinPhi * ex + cosPhi * ey + cy;
    pts.push({ x: px, y: py });
  }
  return pts;
}

/* Parse SVG path string to discretized continuous subpaths (open or closed) */
function parseSvgPathToSubpaths(d, samplesPerCurve = 16){
  if (!d) return [];
  const cmdRegex = /([a-df-z])([^a-df-z]*)/gi;
  let match;
  const subpaths = [];
  let currentPoints = [];
  let curX = 0, curY = 0;
  let startX = 0, startY = 0;
  let lastControl = null;

  function pushPt(x, y){
    if (currentPoints.length > 0){
      const last = currentPoints[currentPoints.length - 1];
      if (Math.hypot(last.x - x, last.y - y) < 0.0001) return;
    }
    currentPoints.push({ x, y });
  }

  function finishSubpath(closed = false){
    if (currentPoints.length >= 2 || (currentPoints.length === 1 && closed)){
      subpaths.push({ points: currentPoints, closed });
    }
    currentPoints = [];
  }

  while ((match = cmdRegex.exec(d))){
    const cmd = match[1];
    const isRel = cmd === cmd.toLowerCase();
    const type = cmd.toUpperCase();
    const nums = extractNumbers(match[2]);
    let i = 0;

    switch(type){
      case 'M': {
        if (currentPoints.length > 0){
          finishSubpath(false);
        }
        while (i < nums.length){
          let x = isRel ? curX + nums[i] : nums[i];
          let y = isRel ? curY + nums[i+1] : nums[i+1];
          pushPt(x, y);
          curX = x; curY = y;
          if (i === 0){ startX = x; startY = y; }
          i += 2;
        }
        lastControl = null;
        break;
      }
      case 'L': {
        while (i < nums.length){
          let x = isRel ? curX + nums[i] : nums[i];
          let y = isRel ? curY + nums[i+1] : nums[i+1];
          pushPt(x, y);
          curX = x; curY = y;
          i += 2;
        }
        lastControl = null;
        break;
      }
      case 'H': {
        while (i < nums.length){
          let x = isRel ? curX + nums[i] : nums[i];
          pushPt(x, curY);
          curX = x;
          i += 1;
        }
        lastControl = null;
        break;
      }
      case 'V': {
        while (i < nums.length){
          let y = isRel ? curY + nums[i] : nums[i];
          pushPt(curX, y);
          curY = y;
          i += 1;
        }
        lastControl = null;
        break;
      }
      case 'C': {
        while (i + 5 < nums.length){
          let x1 = isRel ? curX + nums[i] : nums[i];
          let y1 = isRel ? curY + nums[i+1] : nums[i+1];
          let x2 = isRel ? curX + nums[i+2] : nums[i+2];
          let y2 = isRel ? curY + nums[i+3] : nums[i+3];
          let x = isRel ? curX + nums[i+4] : nums[i+4];
          let y = isRel ? curY + nums[i+5] : nums[i+5];
          const pts = sampleCubicBezier({ x: curX, y: curY }, { x: x1, y: y1 }, { x: x2, y: y2 }, { x, y }, samplesPerCurve);
          for (const p of pts) pushPt(p.x, p.y);
          curX = x; curY = y;
          lastControl = { x: x2, y: y2, type: 'C' };
          i += 6;
        }
        break;
      }
      case 'S': {
        while (i + 3 < nums.length){
          let x1 = curX, y1 = curY;
          if (lastControl && lastControl.type === 'C'){
            x1 = 2 * curX - lastControl.x;
            y1 = 2 * curY - lastControl.y;
          }
          let x2 = isRel ? curX + nums[i] : nums[i];
          let y2 = isRel ? curY + nums[i+1] : nums[i+1];
          let x = isRel ? curX + nums[i+2] : nums[i+2];
          let y = isRel ? curY + nums[i+3] : nums[i+3];
          const pts = sampleCubicBezier({ x: curX, y: curY }, { x: x1, y: y1 }, { x: x2, y: y2 }, { x, y }, samplesPerCurve);
          for (const p of pts) pushPt(p.x, p.y);
          curX = x; curY = y;
          lastControl = { x: x2, y: y2, type: 'C' };
          i += 4;
        }
        break;
      }
      case 'Q': {
        while (i + 3 < nums.length){
          let x1 = isRel ? curX + nums[i] : nums[i];
          let y1 = isRel ? curY + nums[i+1] : nums[i+1];
          let x = isRel ? curX + nums[i+2] : nums[i+2];
          let y = isRel ? curY + nums[i+3] : nums[i+3];
          const pts = sampleQuadBezier({ x: curX, y: curY }, { x: x1, y: y1 }, { x, y }, samplesPerCurve);
          for (const p of pts) pushPt(p.x, p.y);
          curX = x; curY = y;
          lastControl = { x: x1, y: y1, type: 'Q' };
          i += 4;
        }
        break;
      }
      case 'T': {
        while (i + 1 < nums.length){
          let x1 = curX, y1 = curY;
          if (lastControl && lastControl.type === 'Q'){
            x1 = 2 * curX - lastControl.x;
            y1 = 2 * curY - lastControl.y;
          }
          let x = isRel ? curX + nums[i] : nums[i];
          let y = isRel ? curY + nums[i+1] : nums[i+1];
          const pts = sampleQuadBezier({ x: curX, y: curY }, { x: x1, y: y1 }, { x, y }, samplesPerCurve);
          for (const p of pts) pushPt(p.x, p.y);
          curX = x; curY = y;
          lastControl = { x: x1, y: y1, type: 'Q' };
          i += 2;
        }
        break;
      }
      case 'A': {
        while (i + 6 < nums.length){
          let rx = nums[i];
          let ry = nums[i+1];
          let phi = nums[i+2];
          let fa = nums[i+3];
          let fs = nums[i+4];
          let x = isRel ? curX + nums[i+5] : nums[i+5];
          let y = isRel ? curY + nums[i+6] : nums[i+6];
          const pts = sampleSvgArc(curX, curY, rx, ry, phi, fa, fs, x, y, samplesPerCurve);
          for (const p of pts) pushPt(p.x, p.y);
          curX = x; curY = y;
          lastControl = null;
          i += 7;
        }
        break;
      }
      case 'Z': {
        finishSubpath(true);
        curX = startX; curY = startY;
        lastControl = null;
        break;
      }
    }
  }

  if (currentPoints.length > 0){
    finishSubpath(false);
  }

  return subpaths;
}

/* Parse SVG path string to closed 2D polygon rings */
function parseSvgPathToRings(d, samplesPerCurve = 16){
  const subpaths = parseSvgPathToSubpaths(d, samplesPerCurve);
  const rings = [];
  for (const sp of subpaths){
    if (sp.points && sp.points.length >= 3){
      rings.push(sp.points);
    }
  }
  return rings;
}

/* Expand a stroked line/path into watertight 2D polygon ring(s) */
function expandSubpathStroke(pts, closed, strokeWidth, cap = 'round', join = 'round', miterLimit = 4){
  if (!pts || pts.length === 0) return [];
  const hw = strokeWidth / 2;
  if (hw <= 1e-4) return [];

  // Filter out duplicate consecutive points
  const clean = [pts[0]];
  for (let i = 1; i < pts.length; i++){
    const last = clean[clean.length - 1];
    if (Math.hypot(pts[i].x - last.x, pts[i].y - last.y) > 0.001){
      clean.push(pts[i]);
    }
  }

  if (clean.length === 1){
    const c = clean[0];
    const ring = [];
    const steps = 16;
    for (let i = 0; i < steps; i++){
      const ang = (i / steps) * 2 * Math.PI;
      ring.push({ x: c.x + hw * Math.cos(ang), y: c.y + hw * Math.sin(ang) });
    }
    return [ring];
  }

  const N = clean.length;

  if (!closed){
    // Open path: build a single outer closed ribbon with caps
    const leftPts = [];
    const rightPts = [];

    const segs = [];
    for (let i = 0; i < N - 1; i++){
      const p1 = clean[i], p2 = clean[i + 1];
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1e-6;
      segs.push({
        p1, p2,
        tx: dx / len,
        ty: dy / len,
        nx: -dy / len,
        ny: dx / len
      });
    }

    // Start Cap
    const startCap = [];
    const s0 = segs[0];
    const pStart = clean[0];
    if (cap === 'round'){
      const baseAng = Math.atan2(s0.ty, s0.tx) + Math.PI;
      const steps = 8;
      for (let i = 0; i <= steps; i++){
        const ang = baseAng - Math.PI / 2 + (i / steps) * Math.PI;
        startCap.push({
          x: pStart.x + hw * Math.cos(ang),
          y: pStart.y + hw * Math.sin(ang)
        });
      }
    } else if (cap === 'square'){
      const extX = pStart.x - s0.tx * hw;
      const extY = pStart.y - s0.ty * hw;
      startCap.push({ x: extX - s0.nx * hw, y: extY - s0.ny * hw });
      startCap.push({ x: extX + s0.nx * hw, y: extY + s0.ny * hw });
    } else {
      // butt
      startCap.push({ x: pStart.x - s0.nx * hw, y: pStart.y - s0.ny * hw });
      startCap.push({ x: pStart.x + s0.nx * hw, y: pStart.y + s0.ny * hw });
    }

    // Left side traversal
    leftPts.push({ x: clean[0].x + s0.nx * hw, y: clean[0].y + s0.ny * hw });
    for (let i = 1; i < N - 1; i++){
      const sPrev = segs[i - 1];
      const sCurr = segs[i];
      const pt = clean[i];
      const cross = sPrev.tx * sCurr.ty - sPrev.ty * sCurr.tx;

      if (join === 'round'){
        const ang1 = Math.atan2(sPrev.ny, sPrev.nx);
        let ang2 = Math.atan2(sCurr.ny, sCurr.nx);
        if (cross < 0){
          while (ang2 < ang1) ang2 += 2 * Math.PI;
          const steps = Math.max(2, Math.round(Math.abs(ang2 - ang1) / (Math.PI / 6)));
          for (let s = 0; s <= steps; s++){
            const a = ang1 + (s / steps) * (ang2 - ang1);
            leftPts.push({ x: pt.x + hw * Math.cos(a), y: pt.y + hw * Math.sin(a) });
          }
        } else {
          leftPts.push({ x: pt.x + sCurr.nx * hw, y: pt.y + sCurr.ny * hw });
        }
      } else {
        leftPts.push({ x: pt.x + sPrev.nx * hw, y: pt.y + sPrev.ny * hw });
        leftPts.push({ x: pt.x + sCurr.nx * hw, y: pt.y + sCurr.ny * hw });
      }
    }
    const sLast = segs[segs.length - 1];
    leftPts.push({ x: clean[N - 1].x + sLast.nx * hw, y: clean[N - 1].y + sLast.ny * hw });

    // End Cap
    const endCap = [];
    const pEnd = clean[N - 1];
    if (cap === 'round'){
      const baseAng = Math.atan2(sLast.ty, sLast.tx);
      const steps = 8;
      for (let i = 0; i <= steps; i++){
        const ang = baseAng - Math.PI / 2 + (i / steps) * Math.PI;
        endCap.push({
          x: pEnd.x + hw * Math.cos(ang),
          y: pEnd.y + hw * Math.sin(ang)
        });
      }
    } else if (cap === 'square'){
      const extX = pEnd.x + sLast.tx * hw;
      const extY = pEnd.y + sLast.ty * hw;
      endCap.push({ x: extX + sLast.nx * hw, y: extY + sLast.ny * hw });
      endCap.push({ x: extX - sLast.nx * hw, y: extY - sLast.ny * hw });
    } else {
      endCap.push({ x: pEnd.x + sLast.nx * hw, y: pEnd.y + sLast.ny * hw });
      endCap.push({ x: pEnd.x - sLast.nx * hw, y: pEnd.y - sLast.ny * hw });
    }

    // Right side traversal
    rightPts.push({ x: clean[N - 1].x - sLast.nx * hw, y: clean[N - 1].y - sLast.ny * hw });
    for (let i = N - 2; i >= 1; i--){
      const sPrev = segs[i - 1];
      const sCurr = segs[i];
      const pt = clean[i];
      const cross = sPrev.tx * sCurr.ty - sPrev.ty * sCurr.tx;

      if (join === 'round'){
        const ang1 = Math.atan2(-sCurr.ny, -sCurr.nx);
        let ang2 = Math.atan2(-sPrev.ny, -sPrev.nx);
        if (cross > 0){
          while (ang2 < ang1) ang2 += 2 * Math.PI;
          const steps = Math.max(2, Math.round(Math.abs(ang2 - ang1) / (Math.PI / 6)));
          for (let s = 0; s <= steps; s++){
            const a = ang1 + (s / steps) * (ang2 - ang1);
            rightPts.push({ x: pt.x + hw * Math.cos(a), y: pt.y + hw * Math.sin(a) });
          }
        } else {
          rightPts.push({ x: pt.x - sPrev.nx * hw, y: pt.y - sPrev.ny * hw });
        }
      } else {
        rightPts.push({ x: pt.x - sCurr.nx * hw, y: pt.y - sCurr.ny * hw });
        rightPts.push({ x: pt.x - sPrev.nx * hw, y: pt.y - sPrev.ny * hw });
      }
    }
    rightPts.push({ x: clean[0].x - s0.nx * hw, y: clean[0].y - s0.ny * hw });

    const fullRing = [...startCap, ...leftPts, ...endCap, ...rightPts];
    return [fullRing];
  } else {
    // Closed loop
    const outerRing = [];
    const innerRing = [];
    const segs = [];
    for (let i = 0; i < N; i++){
      const p1 = clean[i], p2 = clean[(i + 1) % N];
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1e-6;
      segs.push({
        p1, p2,
        tx: dx / len,
        ty: dy / len,
        nx: -dy / len,
        ny: dx / len
      });
    }

    for (let i = 0; i < N; i++){
      const sPrev = segs[(i - 1 + N) % N];
      const sCurr = segs[i];
      const pt = clean[i];
      const cross = sPrev.tx * sCurr.ty - sPrev.ty * sCurr.tx;

      if (join === 'round'){
        const ang1 = Math.atan2(sPrev.ny, sPrev.nx);
        let ang2 = Math.atan2(sCurr.ny, sCurr.nx);
        if (cross < 0){
          while (ang2 < ang1) ang2 += 2 * Math.PI;
          const steps = Math.max(2, Math.round(Math.abs(ang2 - ang1) / (Math.PI / 6)));
          for (let s = 0; s <= steps; s++){
            const a = ang1 + (s / steps) * (ang2 - ang1);
            outerRing.push({ x: pt.x + hw * Math.cos(a), y: pt.y + hw * Math.sin(a) });
          }
        } else {
          outerRing.push({ x: pt.x + sCurr.nx * hw, y: pt.y + sCurr.ny * hw });
        }

        const iAng1 = Math.atan2(-sPrev.ny, -sPrev.nx);
        let iAng2 = Math.atan2(-sCurr.ny, -sCurr.nx);
        if (cross > 0){
          while (iAng2 < iAng1) iAng2 += 2 * Math.PI;
          const steps = Math.max(2, Math.round(Math.abs(iAng2 - iAng1) / (Math.PI / 6)));
          for (let s = 0; s <= steps; s++){
            const a = iAng1 + (s / steps) * (iAng2 - iAng1);
            innerRing.push({ x: pt.x + hw * Math.cos(a), y: pt.y + hw * Math.sin(a) });
          }
        } else {
          innerRing.push({ x: pt.x - sCurr.nx * hw, y: pt.y - sCurr.ny * hw });
        }
      } else {
        outerRing.push({ x: pt.x + sPrev.nx * hw, y: pt.y + sPrev.ny * hw });
        outerRing.push({ x: pt.x + sCurr.nx * hw, y: pt.y + sCurr.ny * hw });

        innerRing.push({ x: pt.x - sPrev.nx * hw, y: pt.y - sPrev.ny * hw });
        innerRing.push({ x: pt.x - sCurr.nx * hw, y: pt.y - sCurr.ny * hw });
      }
    }

    return [outerRing, innerRing.reverse()];
  }
}

function isPointInPolygonRing(pt, ring){
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++){
    const xi = ring[i].x, yi = ring[i].y;
    const xj = ring[j].x, yj = ring[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function getSegmentIntersection(p1, p2, p3, p4){
  const d = (p4.y - p3.y) * (p2.x - p1.x) - (p4.x - p3.x) * (p2.y - p1.y);
  if (Math.abs(d) < 1e-9) return null;
  const ua = ((p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x)) / d;
  const ub = ((p2.x - p1.x) * (p1.y - p3.y) - (p2.y - p1.y) * (p1.x - p3.x)) / d;
  if (ua >= 1e-6 && ua <= 1 - 1e-6 && ub >= 1e-6 && ub <= 1 - 1e-6){
    return {
      x: p1.x + ua * (p2.x - p1.x),
      y: p1.y + ua * (p2.y - p1.y),
      tA: ua,
      tB: ub
    };
  }
  return null;
}

/* Convert polygon rings back to SVG path commands */
function polygonRingsToPath(rings){
  if (!rings || !rings.length) return 'M0,0';
  const out = [];
  for (const ring of rings){
    if (!ring || ring.length < 3) continue;
    const simplified = [];
    for (let i = 0; i < ring.length; i++){
      const p = ring[i];
      if (simplified.length > 0){
        const last = simplified[simplified.length - 1];
        if (Math.hypot(last.x - p.x, last.y - p.y) < 0.02) continue;
      }
      simplified.push(p);
    }
    if (simplified.length < 3) continue;
    out.push('M' + fmt(simplified[0].x) + ',' + fmt(simplified[0].y));
    for (let i = 1; i < simplified.length; i++){
      out.push('L' + fmt(simplified[i].x) + ',' + fmt(simplified[i].y));
    }
    out.push('Z');
  }
  return out.length ? out.join(' ') : 'M0,0';
}

/* Greiner-Hormann polygon clipper for 2 rings */
function clipTwoPolygonRings(ringA, ringB, op){
  if (!ringA || ringA.length < 3) return op === 'union' ? [ringB] : [];
  if (!ringB || ringB.length < 3) return op === 'subtract' ? [ringA] : (op === 'union' ? [ringA] : []);

  const listA = ringA.map((p, i) => ({ x: p.x, y: p.y, next: null, prev: null, intersect: false, entry: false, visited: false, alpha: 0, neighbor: null }));
  const listB = ringB.map((p, i) => ({ x: p.x, y: p.y, next: null, prev: null, intersect: false, entry: false, visited: false, alpha: 0, neighbor: null }));

  for (let i = 0; i < listA.length; i++){
    listA[i].next = listA[(i + 1) % listA.length];
    listA[i].prev = listA[(i - 1 + listA.length) % listA.length];
  }
  for (let i = 0; i < listB.length; i++){
    listB[i].next = listB[(i + 1) % listB.length];
    listB[i].prev = listB[(i - 1 + listB.length) % listB.length];
  }

  let hasIntersections = false;
  for (let i = 0; i < ringA.length; i++){
    const a1 = ringA[i];
    const a2 = ringA[(i + 1) % ringA.length];
    for (let j = 0; j < ringB.length; j++){
      const b1 = ringB[j];
      const b2 = ringB[(j + 1) % ringB.length];
      const isect = getSegmentIntersection(a1, a2, b1, b2);
      if (isect){
        hasIntersections = true;
        const vA = { x: isect.x, y: isect.y, next: null, prev: null, intersect: true, entry: false, visited: false, alpha: isect.tA, neighbor: null };
        const vB = { x: isect.x, y: isect.y, next: null, prev: null, intersect: true, entry: false, visited: false, alpha: isect.tB, neighbor: null };
        vA.neighbor = vB;
        vB.neighbor = vA;

        let currA = listA[i];
        while (currA.next !== listA[(i + 1) % listA.length] && currA.next.alpha < isect.tA){
          currA = currA.next;
        }
        vA.next = currA.next;
        vA.prev = currA;
        currA.next.prev = vA;
        currA.next = vA;

        let currB = listB[j];
        while (currB.next !== listB[(j + 1) % listB.length] && currB.next.alpha < isect.tB){
          currB = currB.next;
        }
        vB.next = currB.next;
        vB.prev = currB;
        currB.next.prev = vB;
        currB.next = vB;
      }
    }
  }

  if (!hasIntersections){
    const aInB = isPointInPolygonRing(ringA[0], ringB);
    const bInA = isPointInPolygonRing(ringB[0], ringA);

    if (op === 'union'){
      if (aInB) return [ringB];
      if (bInA) return [ringA];
      return [ringA, ringB];
    } else if (op === 'subtract'){
      if (aInB) return [];
      if (bInA) return [ringA, ringB];
      return [ringA];
    } else if (op === 'intersect'){
      if (aInB) return [ringA];
      if (bInA) return [ringB];
      return [];
    } else if (op === 'exclude'){
      return [ringA, ringB];
    }
  }

  let currentA = listA[0];
  let insideB = isPointInPolygonRing({ x: currentA.x, y: currentA.y }, ringB);
  let startNode = currentA;
  do {
    if (currentA.intersect){
      currentA.entry = !insideB;
      insideB = !insideB;
    }
    currentA = currentA.next;
  } while (currentA !== startNode);

  let currentB = listB[0];
  let insideA = isPointInPolygonRing({ x: currentB.x, y: currentB.y }, ringA);
  startNode = currentB;
  do {
    if (currentB.intersect){
      currentB.entry = !insideA;
      insideA = !insideA;
    }
    currentB = currentB.next;
  } while (currentB !== startNode);

  const resultRings = [];
  const maxIterations = 2000;

  function findUnvisitedIntersection(list){
    let node = list[0];
    let start = node;
    do {
      if (node.intersect && !node.visited){
        if (op === 'union' && !node.entry) return node;
        if (op === 'intersect' && node.entry) return node;
        if (op === 'subtract' && node.entry) return node;
        if (op === 'exclude') return node;
      }
      node = node.next;
    } while (node !== start);
    return null;
  }

  let isectNode;
  while ((isectNode = findUnvisitedIntersection(listA))){
    const loop = [];
    let curr = isectNode;
    let onA = true;
    let count = 0;

    while (count++ < maxIterations){
      curr.visited = true;
      if (curr.neighbor) curr.neighbor.visited = true;
      loop.push({ x: curr.x, y: curr.y });

      if (onA){
        if (op === 'union'){
          curr = curr.entry ? curr.prev : curr.next;
        } else if (op === 'intersect'){
          curr = curr.entry ? curr.next : curr.prev;
        } else if (op === 'subtract'){
          curr = curr.entry ? curr.next : curr.prev;
        } else {
          curr = curr.next;
        }
      } else {
        if (op === 'union'){
          curr = curr.entry ? curr.prev : curr.next;
        } else if (op === 'intersect'){
          curr = curr.entry ? curr.next : curr.prev;
        } else if (op === 'subtract'){
          curr = curr.entry ? curr.prev : curr.next;
        } else {
          curr = curr.next;
        }
      }

      if (curr.intersect){
        curr.visited = true;
        if (curr.neighbor) curr.neighbor.visited = true;
        if (Math.hypot(curr.x - isectNode.x, curr.y - isectNode.y) < 0.001){
          break;
        }
        curr = curr.neighbor;
        onA = !onA;
      }
    }

    if (loop.length >= 3){
      resultRings.push(loop);
    }
  }

  return resultRings.length ? resultRings : [ringA];
}

/* Get comprehensive visual 2D polygon rings of a shape including its stroke & fill */
function getShapeVisualRings(shape){
  const transformedD = getShapeTransformedPath(shape);
  const subpaths = parseSvgPathToSubpaths(transformedD);
  const hasFill = !!shape.fillEnabled;
  const strokeWidth = shape.strokeEnabled ? Math.max(0, Number(shape.strokeWidth) || 0) : 0;
  const hasStroke = shape.strokeEnabled && strokeWidth > 0;
  const cap = shape.strokeLineCap || 'round';
  const join = shape.strokeLineJoin || 'round';
  const miter = shape.strokeMiterLimit || 4;

  if (!hasStroke){
    return parseSvgPathToRings(transformedD);
  }

  // Has active stroke
  if (!hasFill){
    // Stroke-only (e.g. stroked cut knife, pen line, outline circle)
    const strokeRings = [];
    for (const sp of subpaths){
      const rings = expandSubpathStroke(sp.points, sp.closed, strokeWidth, cap, join, miter);
      strokeRings.push(...rings);
    }
    return strokeRings.length ? strokeRings : parseSvgPathToRings(transformedD);
  }

  // Both Fill AND Stroke active
  const fillRings = parseSvgPathToRings(transformedD);
  const strokeRings = [];
  for (const sp of subpaths){
    const rings = expandSubpathStroke(sp.points, sp.closed, strokeWidth, cap, join, miter);
    strokeRings.push(...rings);
  }

  if (!fillRings.length) return strokeRings;
  if (!strokeRings.length) return fillRings;

  let combined = fillRings;
  for (const sRing of strokeRings){
    let nextCombined = [];
    for (const fRing of combined){
      const res = clipTwoPolygonRings(fRing, sRing, 'union');
      nextCombined.push(...res);
    }
    combined = nextCombined.length ? nextCombined : combined;
  }
  return combined;
}

/* Master Boolean Operation executor with stroke counting */
function performBooleanOp(op){
  const shapes = selectedShapes().filter(s => s.visible && !s.locked);
  if (shapes.length < 2){
    showToast('Select 2 or more shapes to perform ' + op);
    return;
  }

  const primary = shapes[0];
  const rest = shapes.slice(1);

  // Styling
  const fillCol = primary.fillEnabled ? primary.fillColor : (primary.strokeEnabled ? primary.strokeColor : '#5EE1A0');
  const fillOp = primary.fillEnabled ? primary.fillOpacity : (primary.strokeEnabled ? primary.strokeOpacity : 1);

  // 1. If Exclude (XOR)
  if (op === 'exclude'){
    const allRings = [];
    for (const s of shapes){
      allRings.push(...getShapeVisualRings(s));
    }
    const combinedD = polygonRingsToPath(allRings);
    const newShape = createPathShape(combinedD, {
      name: `Boolean (Exclude)`,
      fillEnabled: true,
      fillColor: fillCol,
      fillOpacity: fillOp,
      fillType: 'evenOdd',
      strokeEnabled: false,
    });

    doAction(() => {
      const idx = shapeIndex(primary.id);
      deleteShapesByIds(shapes.map(s => s.id));
      state.shapes.splice(Math.max(0, idx), 0, newShape);
      state.selectedIds = [newShape.id];
    });
    showToast('Applied Exclude / XOR');
    return;
  }

  // 2. Perform polygon clipping for Union, Subtract, Intersect
  try {
    let baseRings = getShapeVisualRings(primary);
    for (const other of rest){
      const otherRings = getShapeVisualRings(other);
      let combinedRings = [];
      for (const rA of baseRings){
        for (const rB of otherRings){
          const res = clipTwoPolygonRings(rA, rB, op);
          combinedRings.push(...res);
        }
      }
      baseRings = combinedRings.length ? combinedRings : baseRings;
    }

    let finalD = polygonRingsToPath(baseRings);
    if (!finalD || finalD === 'M0,0'){
      finalD = shapes.map(s => getShapeTransformedPath(s)).join(' ');
    }

    const opLabel = op === 'union' ? 'Union' : (op === 'subtract' ? 'Subtract' : 'Intersect');
    const newShape = createPathShape(finalD, {
      name: `Boolean (${opLabel})`,
      fillEnabled: true,
      fillColor: fillCol,
      fillOpacity: fillOp,
      fillType: op === 'subtract' ? 'evenOdd' : (primary.fillType || 'nonZero'),
      strokeEnabled: false,
    });

    doAction(() => {
      const idx = shapeIndex(primary.id);
      deleteShapesByIds(shapes.map(s => s.id));
      state.shapes.splice(Math.max(0, idx), 0, newShape);
      state.selectedIds = [newShape.id];
    });
    showToast(`Applied ${opLabel} on ${shapes.length} shapes (strokes included)`);
  } catch (err){
    console.error('Boolean operation failed:', err);
    const fallbackD = shapes.map(s => getShapeTransformedPath(s)).join(' ');
    const newShape = createPathShape(fallbackD, {
      name: `Compound (${op})`,
      fillEnabled: true,
      fillColor: fillCol,
      fillOpacity: fillOp,
      fillType: op === 'subtract' || op === 'exclude' ? 'evenOdd' : 'nonZero',
      strokeEnabled: false,
    });
    doAction(() => {
      const idx = shapeIndex(primary.id);
      deleteShapesByIds(shapes.map(s => s.id));
      state.shapes.splice(Math.max(0, idx), 0, newShape);
      state.selectedIds = [newShape.id];
    });
    showToast(`Merged ${shapes.length} shapes`);
  }
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
}

function setTool(tool){
  if (state.tool !== 'pen' && tool !== 'pen' && state.penActive) cancelPen();
  if (state.tool === 'pen' && tool !== 'pen' && state.penActive) cancelPen();
  if (state.tool === 'line' && tool !== 'line'){ state.lineDraft = null; state.lineHoverPoint = null; state.lineStartSnap = null; }
  if (state.tool === 'arc' && tool !== 'arc'){ state.arcDraft = null; state.arcHoverPoint = null; }
  if (state.tool === 'curve' && tool !== 'curve'){ state.curveDraft = null; state.curveHoverPoint = null; }
  if (state.tool === 'cut' && tool !== 'cut' && state.cutActive){ cancelCut(); }
  state.tool = tool;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  DOM.canvasScroll.classList.toggle('pan-tool', tool === 'pan');
  DOM.canvasScroll.style.cursor = (tool === 'select') ? 'default' : (tool === 'pan' ? '' : 'crosshair');
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
      if (e.shiftKey) toggleSelectId(id);
      else if (!state.selectedIds.includes(id)) selectOnly(id);
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

function startMove(e){
  beginEdit();
  const startStage = clientToStagePoint(e.clientX, e.clientY);
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
}

function straightenCurveShape(shape){
  if (shape.type !== 'curve') return;
  shape.cp1x = shape.x1 + (shape.x2 - shape.x1) / 3;
  shape.cp1y = shape.y1 + (shape.y2 - shape.y1) / 3;
  shape.cp2x = shape.x1 + (shape.x2 - shape.x1) * 2 / 3;
  shape.cp2y = shape.y1 + (shape.y2 - shape.y1) * 2 / 3;
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
  function onMove(ev){
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
  const raw = clientToStagePoint(e.clientX, e.clientY);
  let pt = { x: maybeSnap(raw.x), y: maybeSnap(raw.y) };

  // Step 1: Select start point
  if (!state.lineDraft){
    const startSnap = getClosestEndpointSnap(pt, null, 16);
    if (startSnap){
      pt = { x: startSnap.snappedPoint.x, y: startSnap.snappedPoint.y };
      state.lineStartSnap = startSnap;
    } else {
      state.lineStartSnap = null;
    }
    state.lineDraft = pt;
    state.lineHoverPoint = pt;
    state.activeEndpointSnap = null;
    showToast('Line start point set — move to preview, click (or drag) to set end point (Shift for 45°)');
    renderStage();

    let dragged = false;
    let endSnap = null;

    function onMove(ev){
      const curRaw = clientToStagePoint(ev.clientX, ev.clientY);
      let cx = maybeSnap(curRaw.x), cy = maybeSnap(curRaw.y);
      if (Math.abs(cx - pt.x) > 0.04 || Math.abs(cy - pt.y) > 0.04) dragged = true;

      if (ev.shiftKey){
        const dx = cx - pt.x, dy = cy - pt.y;
        const dist = Math.hypot(dx, dy);
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        cx = pt.x + dist * Math.cos(angle);
        cy = pt.y + dist * Math.sin(angle);
      }

      const snapResult = getClosestEndpointSnap({ x: cx, y: cy }, null, 16);
      if (snapResult){
        cx = snapResult.snappedPoint.x;
        cy = snapResult.snappedPoint.y;
        endSnap = snapResult;
        state.activeEndpointSnap = {
          x: cx,
          y: cy,
          targetShape: snapResult.targetShape
        };
      } else {
        endSnap = null;
        state.activeEndpointSnap = null;
      }

      state.lineHoverPoint = { x: cx, y: cy };
      renderStage();
    }

    function onUp(){
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);

      if (dragged && state.lineDraft){
        const p1 = state.lineDraft;
        const p2 = state.lineHoverPoint || pt;
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (dist >= MIN_SHAPE_SIZE * 0.25){
          finalizeLineShape(p1, p2, state.lineStartSnap, endSnap);
        }
      }
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return;
  }

  // Step 2: Select end point on click
  let p1 = state.lineDraft;
  let p2 = pt;

  if (e.shiftKey){
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const dist = Math.hypot(dx, dy);
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    p2 = {
      x: p1.x + dist * Math.cos(angle),
      y: p1.y + dist * Math.sin(angle)
    };
  }

  const endSnap = getClosestEndpointSnap(p2, null, 16);
  if (endSnap){
    p2 = { x: endSnap.snappedPoint.x, y: endSnap.snappedPoint.y };
  }

  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (dist < MIN_SHAPE_SIZE * 0.1){
    showToast('Choose an end point farther from the start point');
    return;
  }

  const startSnap = state.lineStartSnap;
  finalizeLineShape(p1, p2, startSnap, endSnap);
}

function finalizeLineShape(p1, p2, startSnap, endSnap){
  state.activeEndpointSnap = null;
  state.lineDraft = null;
  state.lineHoverPoint = null;
  state.lineStartSnap = null;

  doAction(() => {
    let shape = createLineShape(p1.x, p1.y, p2.x, p2.y);
    if (state.lastStrokeColor) shape.strokeColor = state.lastStrokeColor;
    if (state.lastStrokeWidth) shape.strokeWidth = state.lastStrokeWidth;

    let connectedShape = shape;
    if (endSnap && endSnap.targetShape){
      const joined = joinTwoShapes(connectedShape, endSnap.targetShape);
      if (joined) connectedShape = joined;
    }
    if (startSnap && startSnap.targetShape && startSnap.targetShape.id !== (endSnap ? endSnap.targetShape.id : null)){
      const joined = joinTwoShapes(connectedShape, startSnap.targetShape);
      if (joined) connectedShape = joined;
    }

    state.shapes.push(connectedShape);
    state.selectedIds = [connectedShape.id];
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
  if (state.tool === 'line'){
    const raw = clientToStagePoint(e.clientX, e.clientY);
    let cx = maybeSnap(raw.x), cy = maybeSnap(raw.y);
    if (state.lineDraft){
      if (e.shiftKey){
        const dx = cx - state.lineDraft.x, dy = cy - state.lineDraft.y;
        const dist = Math.hypot(dx, dy);
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        cx = state.lineDraft.x + dist * Math.cos(angle);
        cy = state.lineDraft.y + dist * Math.sin(angle);
      }
      const snapResult = getClosestEndpointSnap({ x: cx, y: cy }, null, 16);
      if (snapResult){
        cx = snapResult.snappedPoint.x;
        cy = snapResult.snappedPoint.y;
        state.activeEndpointSnap = {
          x: cx,
          y: cy,
          targetShape: snapResult.targetShape
        };
      } else {
        state.activeEndpointSnap = null;
      }
      state.lineHoverPoint = { x: cx, y: cy };
      renderStage();
    } else {
      const snapResult = getClosestEndpointSnap({ x: cx, y: cy }, null, 16);
      if (snapResult){
        state.activeEndpointSnap = {
          x: snapResult.snappedPoint.x,
          y: snapResult.snappedPoint.y,
          targetShape: snapResult.targetShape
        };
        renderStage();
      } else if (state.activeEndpointSnap){
        state.activeEndpointSnap = null;
        renderStage();
      }
    }
  }
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
    if (!closed){ shape.fillEnabled = false; shape.strokeEnabled = true; shape.strokeColor = state.lastStrokeColor || shape.fillColor; shape.strokeWidth = 1; }
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
  if (mod && e.key.toLowerCase() === 'z'){ e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && e.key.toLowerCase() === 'y'){ e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 'x'){ e.preventDefault(); cutSelectionToClipboard(); return; }
  if (mod && e.key.toLowerCase() === 'c'){ e.preventDefault(); copySelectionToClipboard(); return; }
  if (mod && e.key.toLowerCase() === 'v'){ e.preventDefault(); pasteClipboard(); return; }
  if (mod && e.key.toLowerCase() === 'd'){ e.preventDefault(); duplicateSelectionAction(); return; }
  if (mod && e.key.toLowerCase() === 'g'){ e.preventDefault(); if (e.shiftKey) ungroupSelectedShapes(); else groupSelectedShapes(); return; }
  if (mod && e.key.toLowerCase() === 'a'){ e.preventDefault(); selectAllShapes(); renderAll(); return; }
  if (mod && e.key.toLowerCase() === 's'){ e.preventDefault(); saveProjectFile(); return; }

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
    if (state.lineDraft){ state.lineDraft = null; state.lineHoverPoint = null; state.lineStartSnap = null; state.activeEndpointSnap = null; showToast('Line drawing cancelled'); renderStage(); }
    else if (state.arcDraft){ state.arcDraft = null; state.arcHoverPoint = null; showToast('Arc drawing cancelled'); renderStage(); }
    else if (state.curveDraft){ state.curveDraft = null; state.curveHoverPoint = null; showToast('Curve drawing cancelled'); renderStage(); }
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

  const toolKeys = { v:'select', n:'node', r:'rect', o:'ellipse', a:'arc', p:'polygon', l:'line', c:'curve', f:'pen', h:'pan', k:'cut' };
  const k = e.key.toLowerCase();
  if (toolKeys[k] && !mod){ setTool(toolKeys[k]); return; }
  if (e.key === '+' || e.key === '='){ applyZoomAt(state.view.zoom*1.2); return; }
  if (e.key === '-' || e.key === '_'){ applyZoomAt(state.view.zoom/1.2); return; }
  if (e.key === '1' && e.shiftKey){ fitZoom(); return; }
  if (e.key === '0' && mod){ e.preventDefault(); applyZoomAt(1); return; }
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

function geometryRowsHtml(shape){
  const pos = getShapePos(shape);
  let rows = `
    <div class="row">
      <div class="field"><label>X</label><input type="number" step="0.1" data-field="posX" value="${fmt(pos.x)}"></div>
      <div class="field"><label>Y</label><input type="number" step="0.1" data-field="posY" value="${fmt(pos.y)}"></div>
    </div>`;
  if (shape.type !== 'path' && shape.type !== 'curve'){
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
function fillRowsHtml(shape){
  let html = `<label class="checkbox-row"><input type="checkbox" class="sw" data-field="fillEnabled" ${shape.fillEnabled?'checked':''}><span>Filled</span></label>`;
  if (shape.fillEnabled){
    html += `
    <div class="color-field">
      <span class="swatch"><i style="background:${shape.fillColor}"></i><input type="color" data-field="fillColor" value="${shape.fillColor}"></span>
      <input type="text" class="hexinput" data-field="fillColor" value="${shape.fillColor}" maxlength="9" spellcheck="false">
    </div>
    <div class="field"><label>Opacity ${Math.round(shape.fillOpacity*100)}%</label><input type="range" min="0" max="100" data-field="fillOpacity" value="${Math.round(shape.fillOpacity*100)}"></div>
    <div class="presets">${colorPresetsHtml('fillColor')}</div>
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
    html += `
    <div class="color-field">
      <span class="swatch"><i style="background:${shape.strokeColor}"></i><input type="color" data-field="strokeColor" value="${shape.strokeColor}"></span>
      <input type="text" class="hexinput" data-field="strokeColor" value="${shape.strokeColor}" maxlength="9" spellcheck="false">
    </div>
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
  return `
    ${selectionHeaderHtml([shape])}
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
          <button class="btn small" data-action="boolUnion" title="Merge shapes together">➕ Union</button>
          <button class="btn small" data-action="boolSubtract" title="Cut top shape from bottom shape">➖ Subtract</button>
        </div>
        <div class="btn-row">
          <button class="btn small" data-action="boolIntersect" title="Keep only overlapping area">✖️ Intersect</button>
          <button class="btn small" data-action="boolExclude" title="Remove overlapping sections (XOR)">🔀 Exclude</button>
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
  if (shape.type !== 'path' && shape.type !== 'curve'){
    if (axis === 'x') shape.translateX = (shape.scaleX - 1) * shape.width / 2;
    else shape.translateY = (shape.scaleY - 1) * shape.height / 2;
  }
}
function applySegmentedField(s, field, value){
  if (field === 'strokeCap') s.strokeLineCap = value;
  else if (field === 'strokeJoin') s.strokeLineJoin = value;
  else if (field === 'fillType') s.fillType = value;
  else if (field === 'fillColor'){ s.fillColor = value; state.lastFillColor = value; }
  else if (field === 'strokeColor'){ s.strokeColor = value; state.lastStrokeColor = value; }
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
  }
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
    case 'connectLines': case 'joinLines': joinSelectedLinesAction(); break;
    case 'disconnectLines': case 'splitLines': disconnectSelectedLinesAction(); break;
    case 'arcPreset0': doAction(() => { for (const s of selectedShapes()) if (s.type==='arc') s.sweepAngle = 360; }); break;
    case 'arcPreset90': doAction(() => { for (const s of selectedShapes()) if (s.type==='arc') s.sweepAngle = 90; }); break;
    case 'arcPreset180': doAction(() => { for (const s of selectedShapes()) if (s.type==='arc') s.sweepAngle = 180; }); break;
    case 'arcPreset270': doAction(() => { for (const s of selectedShapes()) if (s.type==='arc') s.sweepAngle = 270; }); break;
    case 'arcPreset330': doAction(() => { for (const s of selectedShapes()) if (s.type==='arc') s.sweepAngle = 30; }); break;
    case 'curveSmooth': doAction(() => { for (const s of selectedShapes()) if (s.type==='curve') smoothCurveShape(s); }); break;
    case 'curveStraighten': doAction(() => { for (const s of selectedShapes()) if (s.type==='curve') straightenCurveShape(s); }); break;
  }
}

/* ---------------- event delegation (focus-safe: no innerHTML rebuild while typing/dragging) ---------------- */
function updateRangeLabelIfNeeded(t){
  if (t.type !== 'range') return;
  const field = t.closest('.field');
  const label = field && field.querySelector('label');
  if (!label) return;
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
}
function onSelectionPanelsInput(e){
  const t = e.target;
  const field = t.dataset.field;
  if (!field || t.classList.contains('hexinput')) return;
  beginEdit();
  applyFieldChange(field, t);
  renderStage();
  updateRangeLabelIfNeeded(t);
  updateSwatchPreviewIfNeeded(t);
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
  beginEdit();
  const ok = applyFieldChange(field, t);
  if (ok === false){ __historySnapshotBeforeEdit = null; renderPropertiesPanel(); showToast('Invalid hex color'); return; }
  commitEdit();
  renderAll();
}
function onSelectionPanelsClick(e){
  const segBtn = e.target.closest('[data-field][data-value]');
  if (segBtn){
    doAction(() => { for (const s of selectedShapes()) applySegmentedField(s, segBtn.dataset.field, segBtn.dataset.value); });
    return;
  }
  const actBtn = e.target.closest('[data-action]');
  if (actBtn){ handlePropertiesAction(actBtn.dataset.action); return; }
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
  };
  return icons[type] || icons.path;
}
function folderIcon(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'; }
function chevronDownIcon(){ return '<svg class="grp-toggle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'; }
function unlinkIcon(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="8" y1="12" x2="16" y2="12"/></svg>'; }

function buildLayerItemHtml(shape){
  return `
    <span class="drag-handle" data-tip="Drag to reorder">⠿</span>
    <span class="type-ic">${shapeTypeIcon(shape.type)}</span>
    <input class="lname" data-id="${shape.id}" value="${escapeHtml(shape.name)}" spellcheck="false">
    ${!shapeHasFillOrStroke(shape) ? '<svg class="warn-badge" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-tip="No stroke and no fill"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>' : ''}
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
        li.draggable = true;
        li.innerHTML = buildLayerItemHtml(mShape);
        itemsContainer.appendChild(li);
      }

      card.append(head, itemsContainer);
      list.appendChild(card);
    } else {
      const li = document.createElement('li');
      li.className = 'layer-item' + (state.selectedIds.includes(shape.id) ? ' selected' : '');
      li.dataset.id = shape.id;
      li.draggable = true;
      li.innerHTML = buildLayerItemHtml(shape);
      list.appendChild(li);
    }
  }

  DOM.layerCount.textContent = state.shapes.length + ' layer' + (state.shapes.length === 1 ? '' : 's');
  DOM.layerTabBadge.textContent = state.shapes.length;
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
        }
      }
      return;
    }

    if (microBtn){
      const act = microBtn.dataset.act;
      const gId = microBtn.dataset.gid;
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
        state.groups[gId].name = e.target.value.trim() || 'Group';
      }
    }
  });

  let dragSrcId = null;
  DOM.layerList.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.layer-item');
    if (!li){ e.preventDefault(); return; }
    dragSrcId = li.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
  });
  DOM.layerList.addEventListener('dragover', (e) => {
    e.preventDefault();
    const li = e.target.closest('.layer-item');
    document.querySelectorAll('.layer-item.dragover').forEach(el => el.classList.remove('dragover'));
    if (li) li.classList.add('dragover');
  });
  DOM.layerList.addEventListener('dragleave', (e) => {
    const li = e.target.closest('.layer-item');
    if (li) li.classList.remove('dragover');
  });
  DOM.layerList.addEventListener('drop', (e) => {
    e.preventDefault();
    document.querySelectorAll('.layer-item.dragover').forEach(el => el.classList.remove('dragover'));
    const li = e.target.closest('.layer-item');
    if (!li || !dragSrcId) return;
    const targetId = li.dataset.id;
    if (targetId === dragSrcId){ dragSrcId=null; return; }
    doAction(() => {
      const idx = shapeIndex(targetId);
      reorderShapeTo(dragSrcId, state.shapes[idx+1] ? state.shapes[idx+1].id : null);
    });
    dragSrcId = null;
  });

  const btnGrp = document.getElementById('btnLayerGroup');
  const btnUngrp = document.getElementById('btnLayerUngroup');
  if (btnGrp) btnGrp.addEventListener('click', groupSelectedShapes);
  if (btnUngrp) btnUngrp.addEventListener('click', ungroupSelectedShapes);
  document.getElementById('btnLayerDup').addEventListener('click', duplicateSelectionAction);
  document.getElementById('btnLayerDel').addEventListener('click', () => { if (state.selectedIds.length) doAction(() => deleteShapesByIds(state.selectedIds)); });
}

/* =====================================================================================
   Part 8: Android XML generation, syntax highlight, copy / export, save & load project
   ===================================================================================== */
function generateXmlString(){
  const d = state.doc;
  const lines = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  let vecAttrs = 'xmlns:android="http://schemas.android.com/apk/res/android"';
  vecAttrs += `\n    android:width="${fmtAttr(d.width)}dp"`;
  vecAttrs += `\n    android:height="${fmtAttr(d.height)}dp"`;
  vecAttrs += `\n    android:viewportWidth="${fmtAttr(d.viewportWidth)}"`;
  vecAttrs += `\n    android:viewportHeight="${fmtAttr(d.viewportHeight)}"`;
  if (d.tint) vecAttrs += `\n    android:tint="${d.tint}"`;
  if (d.alpha !== 1) vecAttrs += `\n    android:alpha="${fmtAttr(d.alpha)}"`;
  if (d.autoMirrored) vecAttrs += '\n    android:autoMirrored="true"';
  lines.push(`<vector ${vecAttrs}>`);
  const canvasClipPath = `M0,0 L${fmtAttr(d.viewportWidth)},0 L${fmtAttr(d.viewportWidth)},${fmtAttr(d.viewportHeight)} L0,${fmtAttr(d.viewportHeight)} Z`;
  lines.push(`    <clip-path android:name="canvas_clip" android:pathData="${canvasClipPath}"/>`);

  const usedNames = {};
  function uniqueName(base){
    let n = base, i = 2;
    while (usedNames[n]){ n = base + '_' + i; i++; }
    usedNames[n] = true;
    return n;
  }

  if (d.backgroundEnabled && d.backgroundExport){
    const bgPathData = `M0,0 L${fmtAttr(d.viewportWidth)},0 L${fmtAttr(d.viewportWidth)},${fmtAttr(d.viewportHeight)} L0,${fmtAttr(d.viewportHeight)} Z`;
    let bgAttrs = `android:name="${uniqueName('background_layer')}"`;
    bgAttrs += `\n    android:pathData="${bgPathData}"`;
    bgAttrs += `\n    android:fillColor="${d.backgroundColor || '#1E222B'}"`;
    if (d.backgroundOpacity != null && d.backgroundOpacity !== 1){
      bgAttrs += `\n    android:fillAlpha="${fmtAttr(d.backgroundOpacity)}"`;
    }
    lines.push(`    <path ${bgAttrs}/>`);
  }

  for (const shape of state.shapes){
    if (!shape.visible) continue;
    const indent = '    ';
    const hasGroup = shapeHasTransform(shape);
    const baseName = sanitizeResourceName(shape.name);
    if (hasGroup){
      const p = shapeLocalPivot(shape);
      let gAttrs = `android:name="${uniqueName(baseName+'_group')}"`;
      gAttrs += `\n${indent}    android:pivotX="${fmtAttr(p.x)}"`;
      gAttrs += `\n${indent}    android:pivotY="${fmtAttr(p.y)}"`;
      if (shape.rotation) gAttrs += `\n${indent}    android:rotation="${fmtAttr(shape.rotation)}"`;
      if (shape.scaleX !== 1) gAttrs += `\n${indent}    android:scaleX="${fmtAttr(shape.scaleX)}"`;
      if (shape.scaleY !== 1) gAttrs += `\n${indent}    android:scaleY="${fmtAttr(shape.scaleY)}"`;
      if (Math.abs(shape.translateX||0) > 1e-9) gAttrs += `\n${indent}    android:translateX="${fmtAttr(shape.translateX)}"`;
      if (Math.abs(shape.translateY||0) > 1e-9) gAttrs += `\n${indent}    android:translateY="${fmtAttr(shape.translateY)}"`;
      lines.push(`${indent}<group ${gAttrs}>`);
    }
    const pindent = hasGroup ? indent+'    ' : indent;
    let pAttrs = `android:name="${uniqueName(baseName)}"`;
    pAttrs += `\n${pindent}    android:pathData="${shapePathData(shape)}"`;
    if (shape.fillEnabled){
      pAttrs += `\n${pindent}    android:fillColor="${shape.fillColor}"`;
      if (shape.fillOpacity !== 1) pAttrs += `\n${pindent}    android:fillAlpha="${fmtAttr(shape.fillOpacity)}"`;
      if (shape.fillType === 'evenOdd') pAttrs += `\n${pindent}    android:fillType="evenOdd"`;
    }
    if (shape.strokeEnabled){
      pAttrs += `\n${pindent}    android:strokeColor="${shape.strokeColor}"`;
      pAttrs += `\n${pindent}    android:strokeWidth="${fmtAttr(shape.strokeWidth)}"`;
      if (shape.strokeOpacity !== 1) pAttrs += `\n${pindent}    android:strokeAlpha="${fmtAttr(shape.strokeOpacity)}"`;
      if (shape.strokeLineCap !== 'butt') pAttrs += `\n${pindent}    android:strokeLineCap="${shape.strokeLineCap}"`;
      if (shape.strokeLineJoin !== 'miter') pAttrs += `\n${pindent}    android:strokeLineJoin="${shape.strokeLineJoin}"`;
      if (shape.strokeLineJoin === 'miter' && shape.strokeMiterLimit !== 4) pAttrs += `\n${pindent}    android:strokeMiterLimit="${fmtAttr(shape.strokeMiterLimit)}"`;
    }
    lines.push(`${pindent}<path ${pAttrs}/>`);
    if (hasGroup) lines.push(`${indent}</group>`);
  }
  lines.push('</vector>');
  return lines.join('\n');
}
function syntaxHighlightXml(xml){
  let out = escapeHtml(xml);
  out = out.replace(/^(&lt;\?.*?\?&gt;)/m, '<span class="cmt">$1</span>');
  out = out.replace(/(&lt;\/?)([a-zA-Z0-9:_-]+)/g, '$1<span class="tag">$2</span>');
  out = out.replace(/([a-zA-Z0-9:_-]+)(=)(&quot;.*?&quot;)/g, '<span class="attr">$1</span>$2<span class="val">$3</span>');
  out = out.replace(/(\/?&gt;)/g, '<span class="punc">$1</span>');
  return out;
}
const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
function androidXmlAttr(el, name){
  return el.getAttributeNS(ANDROID_NS, name) || el.getAttribute('android:' + name) || '';
}
function parseXmlNumber(value, suffix){
  const text = String(value || '').trim();
  if (suffix && !text.endsWith(suffix)) return NaN;
  return parseFloat(suffix ? text.slice(0, -suffix.length) : text);
}
function parseEditedAndroidXml(xml){
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (parsed.querySelector('parsererror')) throw new Error('XML syntax is invalid');
  const root = parsed.documentElement;
  if (!root || root.localName !== 'vector') throw new Error('The root element must be <vector>');
  const viewportWidth = parseXmlNumber(androidXmlAttr(root, 'viewportWidth'));
  const viewportHeight = parseXmlNumber(androidXmlAttr(root, 'viewportHeight'));
  const width = parseXmlNumber(androidXmlAttr(root, 'width'), 'dp');
  const height = parseXmlNumber(androidXmlAttr(root, 'height'), 'dp');
  if (![viewportWidth, viewportHeight, width, height].every(v => isFinite(v) && v > 0)) throw new Error('Vector width, height, and viewport values must be positive');

  const shapes = [];
  function visit(parent, matrix){
    for (const child of Array.from(parent.children)){
      const tag = child.localName;
      if (tag === 'clip-path') continue;
      if (tag === 'group'){
        const pivotX = parseXmlNumber(androidXmlAttr(child, 'pivotX')) || 0;
        const pivotY = parseXmlNumber(androidXmlAttr(child, 'pivotY')) || 0;
        const rotation = parseXmlNumber(androidXmlAttr(child, 'rotation')) || 0;
        const scaleX = parseXmlNumber(androidXmlAttr(child, 'scaleX')) || 1;
        const scaleY = parseXmlNumber(androidXmlAttr(child, 'scaleY')) || 1;
        const translateX = parseXmlNumber(androidXmlAttr(child, 'translateX')) || 0;
        const translateY = parseXmlNumber(androidXmlAttr(child, 'translateY')) || 0;
        const groupMatrix = Mat2D.translate(pivotX + translateX, pivotY + translateY)
          .multiply(Mat2D.rotateDeg(rotation))
          .multiply(Mat2D.scale(scaleX, scaleY))
          .multiply(Mat2D.translate(-pivotX, -pivotY));
        visit(child, matrix.multiply(groupMatrix));
        continue;
      }
      if (tag !== 'path') continue;
      const rawD = androidXmlAttr(child, 'pathData').trim();
      if (!rawD) throw new Error('Every <path> needs android:pathData');
      const bbox = measurePathBBox(rawD);
      if (bbox.width < 1e-6 && bbox.height < 1e-6) throw new Error('A path has invalid or empty pathData');
      const localPivot = { x:bbox.x + bbox.width/2, y:bbox.y + bbox.height/2 };
      const decomposed = matrix.decomposeLinear();
      const desiredPivot = matrix.transformPoint(localPivot.x, localPivot.y);
      const shape = createPathShape(rawD);
      shape.rotation = Math.round(decomposed.rotation*100)/100;
      shape.scaleX = Math.round(decomposed.scaleX*1000)/1000;
      shape.scaleY = Math.round(decomposed.scaleY*1000)/1000;
      shape.translateX = desiredPivot.x - localPivot.x;
      shape.translateY = desiredPivot.y - localPivot.y;
      shape.name = sanitizeResourceName(androidXmlAttr(child, 'name') || 'path');
      shape.fillEnabled = androidXmlAttr(child, 'fillColor') !== 'none';
      shape.fillColor = androidXmlAttr(child, 'fillColor') || '#000000';
      shape.fillOpacity = parseXmlNumber(androidXmlAttr(child, 'fillAlpha')) || 1;
      shape.fillType = androidXmlAttr(child, 'fillType') === 'evenOdd' ? 'evenOdd' : 'nonZero';
      shape.strokeEnabled = !!androidXmlAttr(child, 'strokeColor') && androidXmlAttr(child, 'strokeColor') !== 'none';
      shape.strokeColor = androidXmlAttr(child, 'strokeColor') || '#000000';
      shape.strokeWidth = parseXmlNumber(androidXmlAttr(child, 'strokeWidth')) || 1;
      shape.strokeOpacity = parseXmlNumber(androidXmlAttr(child, 'strokeAlpha')) || 1;
      shape.strokeLineCap = androidXmlAttr(child, 'strokeLineCap') || 'butt';
      shape.strokeLineJoin = androidXmlAttr(child, 'strokeLineJoin') || 'miter';
      shape.strokeMiterLimit = parseXmlNumber(androidXmlAttr(child, 'strokeMiterLimit')) || 4;
      shapes.push(shape);
    }
  }
  visit(root, Mat2D.identity());
  return {
    doc: { width, height, viewportWidth, viewportHeight, tint:androidXmlAttr(root, 'tint'), alpha:parseXmlNumber(androidXmlAttr(root, 'alpha')) || 1, autoMirrored:androidXmlAttr(root, 'autoMirrored') === 'true' },
    shapes,
  };
}
function setXmlStatus(valid, message){
  const status = document.getElementById('xmlStatus');
  if (!status) return;
  status.classList.toggle('invalid', !valid);
  const tooltip = message || (valid ? 'XML is valid' : 'XML is invalid');
  status.dataset.tooltip = tooltip;
  status.querySelector('.xml-status-icon').textContent = valid ? '✓' : '!';
  status.querySelector('.xml-status-text').textContent = valid ? 'Valid XML' : (message || 'Invalid XML');
}
function updateXmlLineNumbers(){
  if (!DOM.xmlout || !DOM.xmlLines) return;
  const count = DOM.xmlout.value.split('\n').length;
  DOM.xmlLines.textContent = Array.from({length:count}, (_, i) => i + 1).join('\n');
}
function updateXmlHighlight(){
  if (DOM.xmlHighlight) DOM.xmlHighlight.innerHTML = syntaxHighlightXml(DOM.xmlout.value) + '\n';
}
function validateXmlEditor(){
  try { parseEditedAndroidXml(DOM.xmlout.value); setXmlStatus(true); return true; }
  catch (err){ setXmlStatus(false, err.message); return false; }
}
function renderXmlPreview(){
  const xml = generateXmlString();
  state.lastXml = xml;
  if (DOM.xmlout && document.activeElement !== DOM.xmlout){ DOM.xmlout.value = xml; validateXmlEditor(); }
  updateXmlHighlight();
  updateXmlLineNumbers();
}
function applyEditedXml(){
  if (!validateXmlEditor()) return showToast('Fix the XML warning before applying it');
  const result = parseEditedAndroidXml(DOM.xmlout.value);
  doAction(() => {
    state.doc = Object.assign({}, state.doc, result.doc);
    state.shapes = result.shapes;
    state.selectedIds = [];
  });
  syncDocSettingsUI();
  fitZoom();
  renderAll();
  showToast('XML applied');
}
async function copyXmlToClipboard(){
  const xml = DOM.xmlout && DOM.xmlout.value ? DOM.xmlout.value : (state.lastXml || generateXmlString());
  copyTextToClipboard(xml);
}
async function copyTextToClipboard(xml){
  try{
    await navigator.clipboard.writeText(xml);
    showToast('XML copied to clipboard');
    return;
  }catch(err){ /* fall through to legacy path */ }
  try{
    const ta = document.createElement('textarea');
    ta.value = xml;
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('XML copied to clipboard');
  }catch(err2){
    showToast('Could not copy automatically — select the XML tab and copy manually');
  }
}
function downloadXmlFile(){
  const xml = DOM.xmlout && DOM.xmlout.value ? DOM.xmlout.value : (state.lastXml || generateXmlString());
  const blob = new Blob([xml], { type:'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitizeResourceName(state.doc.name) + '.xml';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast('Downloaded ' + a.download);
}
const PROJECTS_KEY = 'droidwright.projects.v1';
function readProjects(){
  try { const data = JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]'); return Array.isArray(data) ? data : []; }
  catch (err) { return []; }
}
function writeProjects(projects){ localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects)); }
function projectPreviewSvg(project){
  const svg = svgEl('svg', { viewBox:`0 0 ${project.doc.viewportWidth} ${project.doc.viewportHeight}` });
  svg.style.opacity = project.doc.alpha == null ? 1 : project.doc.alpha;
  for (const shape of project.shapes || []) if (shape.visible) svg.appendChild(buildShapeVisualGroup(shape));
  return svg;
}
function projectXml(project){
  const previousDoc = state.doc, previousShapes = state.shapes;
  state.doc = project.doc;
  state.shapes = project.shapes || [];
  const xml = generateXmlString();
  state.doc = previousDoc;
  state.shapes = previousShapes;
  return xml;
}
function projectActionIcon(type){
  const icons = {
    open:'<path d="M3 12h18M13 6l6 6-6 6"/>',
    view:'<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
    code:'<path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 6l-4 12"/>',
    delete:'<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 10v7M14 10v7"/>'
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[type]}</svg>`;
}
function showProjectQuickView(project, showCode){
  const xml = showCode ? projectXml(project) : '';
  showModal({
    title: project.name || 'Project preview',
    body: '',
    actions: [
      ...(showCode ? [{ label:'Copy code', variant:'ghost', onClick:() => copyTextToClipboard(xml) }] : []),
      { label:'Open project', variant:'primary', onClick:() => { closeModal(); openLocalProject(project.id); } },
      { label:'Close', variant:'ghost', onClick:closeModal },
    ]
  });
  DOM.modalBody.className = 'modal-body project-quickview';
  if (showCode){
    const pre = document.createElement('pre');
    pre.innerHTML = syntaxHighlightXml(xml);
    DOM.modalBody.appendChild(pre);
  } else {
    const preview = document.createElement('div');
    preview.className = 'quickview-preview';
    preview.appendChild(projectPreviewSvg(project));
    DOM.modalBody.appendChild(preview);
    const meta = document.createElement('div');
    meta.className = 'quickview-meta';
    meta.textContent = `${(project.shapes || []).length} layer${(project.shapes || []).length === 1 ? '' : 's'} · ${fmtAttr(project.doc.viewportWidth)} × ${fmtAttr(project.doc.viewportHeight)} viewport`;
    DOM.modalBody.appendChild(meta);
  }
}
function deleteProject(id){
  const project = readProjects().find(item => item.id === id);
  if (!project || !confirm(`Delete "${project.name || 'Untitled icon'}"? This cannot be undone.`)) return;
  writeProjects(readProjects().filter(item => item.id !== id));
  if (state.projectId === id) state.projectId = null;
  renderHome();
}

/* ---- home screen: search / sort / live stats ---- */
const homeState = { query:'', sort:'recent' };
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
function buildProjectCard(project, staggerIndex){
  const card = document.createElement('article');
  card.className = 'project-card';
  card.style.setProperty('--stagger', String(Math.min(staggerIndex, 12)));
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', 'Open ' + (project.name || 'Untitled icon'));
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
  [['open','Open'],['view','Quick view'],['code','Code quick view'],['delete','Delete']].forEach(([type,label]) => {
    const button = document.createElement('button');
    button.className = 'project-action' + (type === 'delete' ? ' danger' : '');
    button.type = 'button';
    button.dataset.tooltip = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = projectActionIcon(type);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (type === 'open') openLocalProject(project.id);
      else if (type === 'view') showProjectQuickView(project, false);
      else if (type === 'code') showProjectQuickView(project, true);
      else deleteProject(project.id);
    });
    actions.appendChild(button);
  });
  info.appendChild(actions);
  card.append(preview, info);
  card.addEventListener('click', () => openLocalProject(project.id));
  card.addEventListener('keydown', (e) => {
    if (e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); openLocalProject(project.id); }
  });
  return card;
}
function renderHome(){
  const all = readProjects();
  const list = getFilteredSortedProjects(all);
  renderHomeStats(all);
  DOM.homeProjectCount.textContent = `${all.length} icon${all.length === 1 ? '' : 's'}`;

  const isEmpty = all.length === 0;
  const isNoResults = !isEmpty && list.length === 0;

  DOM.homeEmpty.hidden = !isEmpty;
  DOM.homeToolbar.hidden = isEmpty;
  DOM.homeNoResults.hidden = !isNoResults;
  DOM.projectGrid.hidden = isEmpty || isNoResults;

  if (isNoResults) DOM.homeNoResultsQuery.textContent = homeState.query.trim();

  DOM.projectGrid.innerHTML = '';
  if (isEmpty || isNoResults) return;

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'project-card project-new';
  add.style.setProperty('--stagger', '0');
  add.innerHTML = '<span class="plus">+</span><strong>New project</strong>';
  add.addEventListener('click', createProjectFlow);
  DOM.projectGrid.appendChild(add);

  list.forEach((project, idx) => DOM.projectGrid.appendChild(buildProjectCard(project, idx + 1)));
}
/* ---------------- mobile block: the vector editor needs a real cursor + a decent
   viewport for precise node/handle work, so it's intentionally desktop-only for now ---------------- */
function isMobileDevice(){
  const uaMobile = /Android|iPhone|iPad|iPod|Mobile|Windows Phone|BlackBerry|IEMobile/i.test(navigator.userAgent);
  if (uaMobile) return true;
  const narrowViewport = Math.min(window.innerWidth, window.innerHeight) < 760;
  const coarsePointer = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
  return narrowViewport && coarsePointer;
}
function checkMobileEditorBlock(){
  if (!DOM.mobileBlockOverlay) return;
  const inEditor = !document.body.classList.contains('home-visible');
  const blocked = inEditor && isMobileDevice();
  DOM.mobileBlockOverlay.classList.toggle('show', blocked);
}
function wireMobileBlock(){
  if (!DOM.mobileBlockOverlay) return;
  const homeBtn = document.getElementById('mobileBlockHomeBtn');
  if (homeBtn) homeBtn.addEventListener('click', () => { showHome(); checkMobileEditorBlock(); });
  window.addEventListener('resize', checkMobileEditorBlock);
  if (window.matchMedia){
    const mq = window.matchMedia('(pointer: coarse)');
    if (mq.addEventListener) mq.addEventListener('change', checkMobileEditorBlock);
  }
  new MutationObserver(checkMobileEditorBlock).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  checkMobileEditorBlock();
}

/* ---------------- reference image panel ---------------- */
function toggleReferencePanel(show){
  state.reference.visible = show;
  if (DOM.referencePanel) DOM.referencePanel.classList.toggle('show', show);
  if (DOM.chkReference) DOM.chkReference.checked = show;
  const chip = document.getElementById('chipReference');
  if (chip) chip.classList.toggle('on', show);
}

function loadReferenceImage(src){
  const img = document.getElementById('referenceImg');
  if (!img) return;
  state.reference.src = src;
  state.reference.zoom = 1;
  state.reference.offsetX = 0;
  state.reference.offsetY = 0;
  state.reference.rotation = 0;
  state.reference._sampleCanvas = null;
  img.crossOrigin = 'anonymous';
  img.onerror = () => {
    showToast('Could not load that image — check the URL or try importing a file instead');
  };
  img.onload = () => {
    applyReferenceTransform();
  };
  img.src = src;

  document.getElementById('referenceEmptyState').hidden = true;
  document.getElementById('referenceViewport').hidden = false;
  document.getElementById('referenceControls').hidden = false;
  document.getElementById('referenceSwatch').hidden = true;
  applyReferenceTransform();
}

function clearReferenceImage(){
  const img = document.getElementById('referenceImg');
  if (img){ img.src = ''; img.onload = null; img.onerror = null; }
  state.reference.src = null;
  state.reference._sampleCanvas = null;
  document.getElementById('referenceEmptyState').hidden = false;
  document.getElementById('referenceViewport').hidden = true;
  document.getElementById('referenceControls').hidden = true;
}

function applyReferenceTransform(){
  const img = document.getElementById('referenceImg');
  if (!img) return;
  const r = state.reference;
  img.style.transform = `translate(-50%, -50%) translate(${fmt(r.offsetX)}px, ${fmt(r.offsetY)}px) scale(${fmt(r.zoom)}) rotate(${fmt(r.rotation)}deg)`;
  const zoomLabel = document.getElementById('refZoomLabel');
  if (zoomLabel) zoomLabel.textContent = Math.round(r.zoom * 100) + '%';
  const rotLabel = document.getElementById('refRotateLabel');
  if (rotLabel) rotLabel.textContent = Math.round(r.rotation) + '°';
  const rotSlider = document.getElementById('refRotate');
  if (rotSlider && Number(rotSlider.value) !== Math.round(r.rotation)) rotSlider.value = Math.round(r.rotation);
}

function applyPickedReferenceColor(hex){
  const dot = document.getElementById('referenceSwatchDot');
  const label = document.getElementById('referenceSwatchHex');
  const swatch = document.getElementById('referenceSwatch');
  if (dot) dot.style.background = hex;
  if (label) label.textContent = hex.toUpperCase();
  if (swatch) swatch.hidden = false;

  const sel = selectedShapes().filter(s => !s.locked);
  if (sel.length){
    doAction(() => { for (const s of sel){ s.fillEnabled = true; s.fillColor = hex; } });
    renderAll();
    showToast(`Applied ${hex} to fill`);
  } else {
    state.lastFillColor = hex;
    showToast(`Picked ${hex} — copied to your next fill color`);
  }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(hex).catch(() => {});
  }
}

async function pickReferenceColor(){
  if (!state.reference.src) return;
  if (window.EyeDropper){
    try {
      const ed = new window.EyeDropper();
      const result = await ed.open();
      if (result && result.sRGBHex) applyPickedReferenceColor(result.sRGBHex);
    } catch (err){ /* user cancelled the pick — nothing to do */ }
    return;
  }
  // Fallback for browsers without the native EyeDropper API: sample the reference
  // <img> directly via an offscreen canvas. Only reliable while rotation is 0°,
  // since a rotated element's bounding box no longer maps 1:1 to source pixels.
  if (Math.round(state.reference.rotation) % 360 !== 0){
    showToast('Set rotation back to 0° to pick a color precisely in this browser');
    return;
  }
  state.reference.picking = true;
  document.getElementById('referenceViewport').classList.add('picking');
  showToast('Click anywhere on the reference image to pick a color');
}

function sampleReferencePixelAt(clientX, clientY){
  const img = document.getElementById('referenceImg');
  if (!img || !img.naturalWidth) return;
  let canvas = state.reference._sampleCanvas;
  if (!canvas){
    canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    state.reference._sampleCanvas = canvas;
  }
  const rect = img.getBoundingClientRect();
  const nx = (clientX - rect.left) / rect.width;
  const ny = (clientY - rect.top) / rect.height;
  state.reference.picking = false;
  document.getElementById('referenceViewport').classList.remove('picking');
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
  const px = Math.min(canvas.width - 1, Math.floor(nx * img.naturalWidth));
  const py = Math.min(canvas.height - 1, Math.floor(ny * img.naturalHeight));
  let data;
  try {
    data = canvas.getContext('2d').getImageData(px, py, 1, 1).data;
  } catch (err){
    showToast('Can\u2019t sample this image (cross-origin) — try importing it from your device instead');
    return;
  }
  const hex = '#' + [data[0], data[1], data[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  applyPickedReferenceColor(hex);
}

function wireReferencePanel(){
  if (!DOM.referencePanel) return;

  if (DOM.chkReference){
    DOM.chkReference.addEventListener('change', () => toggleReferencePanel(DOM.chkReference.checked));
  }
  const closeBtn = document.getElementById('btnCloseReference');
  if (closeBtn) closeBtn.addEventListener('click', () => toggleReferencePanel(false));

  const urlInput = document.getElementById('referenceUrlInput');
  const urlApply = document.getElementById('referenceUrlApply');
  const doApplyUrl = () => {
    const v = urlInput.value.trim();
    if (!v) return;
    loadReferenceImage(v);
  };
  if (urlApply) urlApply.addEventListener('click', doApplyUrl);
  if (urlInput) urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doApplyUrl(); });

  const importBtn = document.getElementById('referenceImportBtn');
  const fileInput = document.getElementById('referenceFileInput');
  if (importBtn && fileInput){
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => loadReferenceImage(reader.result);
      reader.readAsDataURL(file);
      fileInput.value = '';
    });
  }

  const swapBtn = document.getElementById('refSwapImage');
  if (swapBtn) swapBtn.addEventListener('click', clearReferenceImage);

  const zoomIn = document.getElementById('refZoomIn');
  const zoomOut = document.getElementById('refZoomOut');
  if (zoomIn) zoomIn.addEventListener('click', () => { state.reference.zoom = clamp(state.reference.zoom * 1.25, 0.1, 10); applyReferenceTransform(); });
  if (zoomOut) zoomOut.addEventListener('click', () => { state.reference.zoom = clamp(state.reference.zoom / 1.25, 0.1, 10); applyReferenceTransform(); });

  const panLeft = document.getElementById('refPanLeft');
  const panRight = document.getElementById('refPanRight');
  if (panLeft) panLeft.addEventListener('click', () => { state.reference.offsetX -= 30; applyReferenceTransform(); });
  if (panRight) panRight.addEventListener('click', () => { state.reference.offsetX += 30; applyReferenceTransform(); });

  const resetBtn = document.getElementById('refResetView');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    state.reference.zoom = 1; state.reference.offsetX = 0; state.reference.offsetY = 0; state.reference.rotation = 0;
    applyReferenceTransform();
  });

  const rotate = document.getElementById('refRotate');
  if (rotate) rotate.addEventListener('input', () => { state.reference.rotation = Number(rotate.value); applyReferenceTransform(); });

  const eyedropperBtn = document.getElementById('refEyedropper');
  if (eyedropperBtn) eyedropperBtn.addEventListener('click', pickReferenceColor);

  // Drag-to-pan directly on the viewport, and wheel-to-zoom for convenience.
  const viewport = document.getElementById('referenceViewport');
  if (viewport){
    viewport.addEventListener('pointerdown', (e) => {
      if (state.reference.picking){ sampleReferencePixelAt(e.clientX, e.clientY); return; }
      if (!state.reference.src) return;
      const startX = e.clientX, startY = e.clientY;
      const origX = state.reference.offsetX, origY = state.reference.offsetY;
      const pointerId = e.pointerId;
      if (pointerId != null && viewport.setPointerCapture) viewport.setPointerCapture(pointerId);
      function onMove(ev){
        state.reference.offsetX = origX + (ev.clientX - startX);
        state.reference.offsetY = origY + (ev.clientY - startY);
        applyReferenceTransform();
      }
      function onUp(){
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    viewport.addEventListener('wheel', (e) => {
      if (!state.reference.src) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1/1.1;
      state.reference.zoom = clamp(state.reference.zoom * factor, 0.1, 10);
      applyReferenceTransform();
    }, { passive: false });
  }
}

function showHome(){
  if (state.dirty && !confirm('This project has unsaved changes. Return to the home screen?')) return;
  state.dirty = false;
  document.body.classList.add('home-visible');
  renderHome();
}
function openLocalProject(id){
  const project = readProjects().find(item => item.id === id);
  if (!project) return;
  state.projectId = project.id;
  state.projectName = project.name || project.doc.name;
  state.dirty = false;
  state.doc = Object.assign({}, state.doc, deepClone(project.doc));
  state.shapes = deepClone(project.shapes || []);
  state.selectedIds = [];
  state.history.past = [];
  state.history.future = [];
  document.body.classList.remove('home-visible');
  syncDocSettingsUI();
  fitZoom();
  renderAll();
}
function persistActiveProject(){
  if (!state.projectId) return;
  const existing = readProjects().find(project => project.id === state.projectId);
  const projects = readProjects().filter(project => project.id !== state.projectId);
  projects.unshift({
    id: state.projectId,
    name: state.projectName || state.doc.name,
    doc: deepClone(state.doc),
    shapes: deepClone(state.shapes),
    createdAt: (existing && existing.createdAt) || Date.now(),
    updatedAt: Date.now(),
  });
  writeProjects(projects);
  state.dirty = false;
}
function wireHome(){
  DOM.homeNewProject.addEventListener('click', createProjectFlow);
  DOM.homeImportProject.addEventListener('click', () => document.getElementById('fileImportSvg').click());
  if (DOM.homeInfoBtn) DOM.homeInfoBtn.addEventListener('click', showAboutModal);
  DOM.emptyNewProject.addEventListener('click', createProjectFlow);
  DOM.emptyImportProject.addEventListener('click', () => document.getElementById('fileImportSvg').click());
  DOM.homeSearchInput.addEventListener('input', () => { homeState.query = DOM.homeSearchInput.value; renderHome(); });
  DOM.homeClearSearch.addEventListener('click', () => {
    homeState.query = '';
    DOM.homeSearchInput.value = '';
    renderHome();
    DOM.homeSearchInput.focus();
  });
  DOM.homeSort.addEventListener('click', (e) => {
    const btn = e.target.closest('.sort-btn');
    if (!btn) return;
    homeState.sort = btn.dataset.sort;
    DOM.homeSort.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('on', b === btn));
    renderHome();
  });
}
function saveProjectFile(){
  persistActiveProject();
  showToast('Project saved locally');
}
function loadProjectFromFile(file){
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const payload = JSON.parse(reader.result);
      if (!payload || !payload.shapes || !payload.doc) throw new Error('bad file');
      document.body.classList.remove('home-visible');
      doAction(() => {
        state.doc = Object.assign({}, state.doc, payload.doc);
        state.shapes = payload.shapes;
        state.selectedIds = [];
      });
      syncDocSettingsUI();
      fitZoom();
      renderAll();
      showToast('Project loaded');
    }catch(err){
      showToast('Could not read that project file');
    }
  };
  reader.readAsText(file);
}

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
  for (const node of chainEls){
    const style = parseStylePairs(node.getAttribute('style'));
    const f = getEffectiveAttr(node, 'fill', style);
    if (f != null){
      if (f === 'none') hasFill = false;
      else { const c = resolveCssColor(f); if (c){ fill = c.hex; hasFill = true; if (c.alpha < 1) fillOpacity = c.alpha; } }
    }
    const fo = getEffectiveAttr(node, 'fill-opacity', style);
    if (fo != null && !isNaN(parseFloat(fo))) fillOpacity = clamp(parseFloat(fo),0,1);
    const s = getEffectiveAttr(node, 'stroke', style);
    if (s != null){ if (s === 'none') stroke = null; else { const c = resolveCssColor(s); if (c){ stroke = c.hex; if (c.alpha<1) strokeOpacity = c.alpha; } } }
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
  shape.strokeEnabled = !!stroke;
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
      walkSvgNode(svgRoot, Mat2D.identity(), newShapes, []);
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
  fitZoom();
  renderAll();
  closeModal();
  showToast('Imported ' + newShapes.length + ' shape' + (newShapes.length>1?'s':''));
}

/* =====================================================================================
   Part 10: preview strip (real-size swatches)
   ===================================================================================== */
function renderPreviewStrip(){
  const strip = DOM.previewStrip;
  strip.innerHTML = '';
  const sizes = [16, 24, 32, 48, 64];
  const d = state.doc;
  sizes.forEach((px, idx) => {
    ['light','dark'].forEach(mode => {
      const wrap = document.createElement('div');
      wrap.className = 'preview-swatch';
      const frame = document.createElement('div');
      frame.className = 'frame ' + mode;
      const pad = Math.max(6, px*0.3);
      frame.style.width = (px+pad) + 'px';
      frame.style.height = (px+pad) + 'px';
      const svg = svgEl('svg', { viewBox:`0 0 ${d.viewportWidth} ${d.viewportHeight}`, width:px, height:px });
      svg.style.opacity = d.alpha;
      for (const shape of state.shapes){
        if (!shape.visible) continue;
        svg.appendChild(buildShapeVisualGroup(shape));
      }
      frame.appendChild(svg);
      const label = document.createElement('label');
      label.textContent = px + (mode==='dark' ? ' dark' : ' light');
      wrap.appendChild(frame);
      wrap.appendChild(label);
      strip.appendChild(wrap);
    });
    if (idx < sizes.length-1){ const sep = document.createElement('div'); sep.className='vsep'; strip.appendChild(sep); }
  });
}

/* =====================================================================================
   Part 11: toast / modal helpers
   ===================================================================================== */
let __toastTimer = null;
function showToast(msg){
  DOM.toastMsg.textContent = msg;
  DOM.toast.classList.add('show');
  clearTimeout(__toastTimer);
  __toastTimer = setTimeout(() => DOM.toast.classList.remove('show'), 2600);
}
function showModal(opts){
  DOM.modalTitle.textContent = opts.title;
  DOM.modalBody.className = 'modal-body';
  DOM.modalBody.textContent = opts.body;
  DOM.modalFoot.innerHTML = '';
  for (const act of (opts.actions||[])){
    const b = document.createElement('button');
    b.className = 'btn' + (act.variant==='primary' ? ' primary' : act.variant==='danger' ? ' danger' : ' ghost');
    b.textContent = act.label;
    b.addEventListener('click', () => { if (act.onClick) act.onClick(); });
    DOM.modalFoot.appendChild(b);
  }
  DOM.modalBackdrop.classList.add('show');
}
function closeModal(){ DOM.modalBackdrop.classList.remove('show'); }

function showAboutModal(){
  DOM.modalTitle.textContent = 'About Droidwright';
  DOM.modalBody.innerHTML = `
    <div class="about-modal-body">
      <div class="about-modal-profile">
        <img class="about-modal-avatar" src="https://github.com/monomixs.png" alt="Wedley" loading="lazy"
             onerror="this.onerror=null;this.src='data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27%3E%3Crect width=%2724%27 height=%2724%27 rx=%2712%27 fill=%27%23282d39%27/%3E%3Ccircle cx=%2712%27 cy=%279%27 r=%274%27 fill=%27%235EE1A0%27/%3E%3Cpath d=%27M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8%27 fill=%27%235EE1A0%27/%3E%3C/svg%3E';">
        <div class="about-modal-who">
          <b>Wedley</b>
          <span>Creator &amp; maintainer of Droidwright</span>
          <a href="https://github.com/monomixs" target="_blank" rel="noopener noreferrer">github.com/monomixs ↗</a>
        </div>
      </div>
      <div class="about-modal-section">
        <b>Droidwright</b> is a local-first editor for building Android <b>vector drawable</b> icons on a real dp grid — draw shapes, arcs, curves and paths, then export clean, ready-to-use XML. Everything is saved straight to this device; nothing is uploaded anywhere.
      </div>
      <div class="about-modal-meta">
        <span>No account needed</span>
        <span>Runs 100% locally</span>
        <span>Exports Android VectorDrawable XML</span>
      </div>
    </div>`;
  DOM.modalFoot.innerHTML = '';
  const close = document.createElement('button');
  close.className = 'btn primary';
  close.textContent = 'Close';
  close.addEventListener('click', closeModal);
  DOM.modalFoot.append(close);
  DOM.modalBackdrop.classList.add('show');
}
function showCreateProjectModal(){
  DOM.modalTitle.textContent = 'New project';
  DOM.modalBody.innerHTML = '<label class="modal-input-label" for="newProjectName">Project name</label><input id="newProjectName" class="modal-input" type="text" value="Untitled icon" maxlength="80" autocomplete="off">';
  DOM.modalFoot.innerHTML = '';
  const cancel = document.createElement('button');
  cancel.className = 'btn ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeModal);
  const create = document.createElement('button');
  create.className = 'btn primary';
  create.textContent = 'Create project';
  create.addEventListener('click', () => {
    const input = document.getElementById('newProjectName');
    startProject(input ? input.value : 'Untitled icon');
    closeModal();
  });
  DOM.modalFoot.append(cancel, create);
  DOM.modalBackdrop.classList.add('show');
  const input = document.getElementById('newProjectName');
  input.focus();
  input.select();
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create.click(); });
}
function newProjectFlow(){
  createProjectFlow();
}
function createProjectFlow(){
  if (state.dirty && !confirm('This project has unsaved changes. Start a new project anyway?')) return;
  showCreateProjectModal();
}
function startProject(name){
  const cleanName = String(name || '').trim() || 'Untitled icon';
  const id = 'dw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,6);
  state.projectId = id;
  state.projectName = cleanName;
  state.dirty = false;
  state.doc.name = sanitizeResourceName(cleanName);
  state.shapes = [];
  state.selectedIds = [];
  state.history.past = [];
  state.history.future = [];
  document.body.classList.remove('home-visible');
  syncDocSettingsUI();
  fitZoom();
  renderAll();
}
function resetProject(){
  doAction(() => {
    state.doc = { name:'ic_custom_icon', width:24, height:24, viewportWidth:24, viewportHeight:24, linkSize:true, tint:'', alpha:1, autoMirrored:false };
    state.shapes = [];
    state.selectedIds = [];
  });
  syncDocSettingsUI();
  fitZoom();
  renderAll();
}

/* =====================================================================================
   Part 12: doc settings panel wiring + global sync
   ===================================================================================== */
function syncDocSettingsUI(){
  const d = state.doc;
  const setVal = (id, val) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = val; };
  setVal('docWidth', fmtAttr(d.width));
  setVal('docHeight', fmtAttr(d.height));
  setVal('docVpWidth', fmtAttr(d.viewportWidth));
  setVal('docVpHeight', fmtAttr(d.viewportHeight));
  const linkEl = document.getElementById('docLink'); if (linkEl) linkEl.checked = d.linkSize;
  const tintEl = document.getElementById('docTint'); if (tintEl && document.activeElement!==tintEl) tintEl.value = d.tint || '#000000';
  const tintSwatch = document.getElementById('tintSwatch'); if (tintSwatch) tintSwatch.style.background = d.tint || 'transparent';
  const alphaEl = document.getElementById('docAlpha'); if (alphaEl && document.activeElement!==alphaEl) alphaEl.value = Math.round(d.alpha*100);
  const alphaVal = document.getElementById('docAlphaVal'); if (alphaVal) alphaVal.textContent = Math.round(d.alpha*100) + '%';
  const autoMirrorEl = document.getElementById('docAutoMirror'); if (autoMirrorEl) autoMirrorEl.checked = d.autoMirrored;

  // Sync background settings
  const bgEnabledEl = document.getElementById('docBgEnabled');
  const bgControls = document.getElementById('docBgControls');
  const bgColorEl = document.getElementById('docBgColor');
  const bgHexEl = document.getElementById('docBgHex');
  const bgSwatch = document.getElementById('docBgSwatch');
  const bgAlphaEl = document.getElementById('docBgAlpha');
  const bgAlphaVal = document.getElementById('docBgAlphaVal');
  const bgExportEl = document.getElementById('docBgExport');

  if (bgEnabledEl) bgEnabledEl.checked = Boolean(d.backgroundEnabled);
  if (bgControls) bgControls.style.display = d.backgroundEnabled ? 'flex' : 'none';
  const bgCol = d.backgroundColor || '#1E222B';
  if (bgColorEl && document.activeElement !== bgColorEl) bgColorEl.value = bgCol;
  if (bgHexEl && document.activeElement !== bgHexEl) bgHexEl.value = bgCol;
  if (bgSwatch) bgSwatch.style.background = bgCol;
  const bgAlpha = d.backgroundOpacity != null ? Math.round(d.backgroundOpacity * 100) : 100;
  if (bgAlphaEl && document.activeElement !== bgAlphaEl) bgAlphaEl.value = bgAlpha;
  if (bgAlphaVal) bgAlphaVal.textContent = bgAlpha + '%';
  if (bgExportEl) bgExportEl.checked = d.backgroundExport !== false;

  if (DOM.docNameInput && document.activeElement !== DOM.docNameInput) DOM.docNameInput.value = d.name;
  DOM.viewportReadout.textContent = `${fmtAttr(d.viewportWidth)} × ${fmtAttr(d.viewportHeight)} viewport · ${fmtAttr(d.width)} × ${fmtAttr(d.height)} dp`;
}
function wireDocSettings(){
  const widthEl=document.getElementById('docWidth'), heightEl=document.getElementById('docHeight');
  const vpwEl=document.getElementById('docVpWidth'), vphEl=document.getElementById('docVpHeight');
  const linkEl=document.getElementById('docLink');
  const tintEl=document.getElementById('docTint'), tintSwatch=document.getElementById('tintSwatch');
  const alphaEl=document.getElementById('docAlpha'), alphaVal=document.getElementById('docAlphaVal');
  const autoMirrorEl=document.getElementById('docAutoMirror');

  function liveSync(){
    DOM.viewportReadout.textContent = `${fmtAttr(state.doc.viewportWidth)} × ${fmtAttr(state.doc.viewportHeight)} viewport · ${fmtAttr(state.doc.width)} × ${fmtAttr(state.doc.height)} dp`;
    renderStage();
    renderPreviewStrip();
  }
  widthEl.addEventListener('input', () => {
    beginEdit();
    const v = Math.max(1, parseFloat(widthEl.value)||1);
    state.doc.width = v;
    if (state.doc.linkSize){ state.doc.viewportWidth = v; if (document.activeElement!==vpwEl) vpwEl.value = fmtAttr(v); }
    liveSync();
  });
  heightEl.addEventListener('input', () => {
    beginEdit();
    const v = Math.max(1, parseFloat(heightEl.value)||1);
    state.doc.height = v;
    if (state.doc.linkSize){ state.doc.viewportHeight = v; if (document.activeElement!==vphEl) vphEl.value = fmtAttr(v); }
    liveSync();
  });
  vpwEl.addEventListener('input', () => {
    beginEdit();
    const v = Math.max(1, parseFloat(vpwEl.value)||1);
    state.doc.viewportWidth = v;
    if (state.doc.linkSize){ state.doc.width = v; if (document.activeElement!==widthEl) widthEl.value = fmtAttr(v); }
    liveSync();
  });
  vphEl.addEventListener('input', () => {
    beginEdit();
    const v = Math.max(1, parseFloat(vphEl.value)||1);
    state.doc.viewportHeight = v;
    if (state.doc.linkSize){ state.doc.height = v; if (document.activeElement!==heightEl) heightEl.value = fmtAttr(v); }
    liveSync();
  });
  [widthEl,heightEl,vpwEl,vphEl].forEach(el => el.addEventListener('change', () => { commitEdit(); fitZoom(); renderAll(); }));

  linkEl.addEventListener('change', () => {
    doAction(() => {
      state.doc.linkSize = linkEl.checked;
      if (state.doc.linkSize){ state.doc.width = state.doc.viewportWidth; state.doc.height = state.doc.viewportHeight; }
    });
    syncDocSettingsUI();
  });
  document.querySelectorAll('[data-size]').forEach(btn => {
    btn.addEventListener('click', () => {
      const n = parseFloat(btn.dataset.size);
      doAction(() => { state.doc.width=n; state.doc.height=n; state.doc.viewportWidth=n; state.doc.viewportHeight=n; state.doc.linkSize=true; });
      syncDocSettingsUI(); fitZoom(); renderAll();
    });
  });
  tintEl.addEventListener('input', () => { beginEdit(); state.doc.tint = tintEl.value; tintSwatch.style.background = tintEl.value; renderPreviewStrip(); });
  tintEl.addEventListener('change', () => { commitEdit(); renderAll(); });
  document.getElementById('btnClearTint').addEventListener('click', () => { doAction(() => { state.doc.tint = ''; }); syncDocSettingsUI(); });

  alphaEl.addEventListener('input', () => {
    beginEdit();
    state.doc.alpha = clamp(parseFloat(alphaEl.value)/100, 0, 1);
    alphaVal.textContent = Math.round(state.doc.alpha*100) + '%';
    renderPreviewStrip();
  });
  alphaEl.addEventListener('change', () => { commitEdit(); renderAll(); });
  autoMirrorEl.addEventListener('change', () => { doAction(() => { state.doc.autoMirrored = autoMirrorEl.checked; }); });

  // Background layer event handlers
  const bgEnabledEl = document.getElementById('docBgEnabled');
  const bgControls = document.getElementById('docBgControls');
  const bgColorEl = document.getElementById('docBgColor');
  const bgHexEl = document.getElementById('docBgHex');
  const bgSwatch = document.getElementById('docBgSwatch');
  const bgAlphaEl = document.getElementById('docBgAlpha');
  const bgAlphaVal = document.getElementById('docBgAlphaVal');
  const bgExportEl = document.getElementById('docBgExport');

  if (bgEnabledEl){
    bgEnabledEl.addEventListener('change', () => {
      doAction(() => {
        state.doc.backgroundEnabled = bgEnabledEl.checked;
        if (state.doc.backgroundColor == null) state.doc.backgroundColor = '#1E222B';
        if (state.doc.backgroundOpacity == null) state.doc.backgroundOpacity = 1;
        if (state.doc.backgroundExport == null) state.doc.backgroundExport = true;
      });
      syncDocSettingsUI();
      renderStage();
      renderPreviewStrip();
      renderXmlPreview();
    });
  }

  function setBgColor(hex){
    beginEdit();
    state.doc.backgroundColor = hex;
    if (bgColorEl && document.activeElement !== bgColorEl) bgColorEl.value = hex;
    if (bgHexEl && document.activeElement !== bgHexEl) bgHexEl.value = hex;
    if (bgSwatch) bgSwatch.style.background = hex;
    renderStage();
    renderPreviewStrip();
    renderXmlPreview();
  }

  if (bgColorEl){
    bgColorEl.addEventListener('input', () => setBgColor(bgColorEl.value));
    bgColorEl.addEventListener('change', () => { commitEdit(); renderAll(); });
  }

  if (bgHexEl){
    bgHexEl.addEventListener('input', () => {
      let val = bgHexEl.value.trim();
      if (!val.startsWith('#')) val = '#' + val;
      if (/^#[0-9A-Fa-f]{6}$/.test(val)){
        setBgColor(val);
      }
    });
    bgHexEl.addEventListener('change', () => { commitEdit(); renderAll(); });
  }

  document.querySelectorAll('[data-bg-color]').forEach(dot => {
    dot.addEventListener('click', () => {
      setBgColor(dot.dataset.bgColor);
      commitEdit();
      renderAll();
    });
  });

  if (bgAlphaEl){
    bgAlphaEl.addEventListener('input', () => {
      beginEdit();
      const val = clamp(parseFloat(bgAlphaEl.value) / 100, 0, 1);
      state.doc.backgroundOpacity = val;
      if (bgAlphaVal) bgAlphaVal.textContent = Math.round(val * 100) + '%';
      renderStage();
      renderPreviewStrip();
      renderXmlPreview();
    });
    bgAlphaEl.addEventListener('change', () => { commitEdit(); renderAll(); });
  }

  if (bgExportEl){
    bgExportEl.addEventListener('change', () => {
      doAction(() => {
        state.doc.backgroundExport = bgExportEl.checked;
      });
      renderXmlPreview();
    });
  }

  DOM.docNameInput.addEventListener('input', () => {
    beginEdit();
    const enteredName = DOM.docNameInput.value.trim();
    state.projectName = enteredName || 'Untitled icon';
    state.doc.name = sanitizeResourceName(enteredName || 'Untitled icon');
    renderXmlPreview();
  });
  DOM.docNameInput.addEventListener('change', () => { commitEdit(); renderAll(); });
}

function wirePresetShapesPopover(){
  const btn = document.getElementById('btnPresetShapes');
  const popover = document.getElementById('presetsPopover');
  if (!btn || !popover) return;

  function togglePopover(){
    if (!popover.hidden){
      popover.hidden = true;
      btn.classList.remove('active');
      return;
    }
    const rect = btn.getBoundingClientRect();
    popover.hidden = false;
    btn.classList.add('active');
    popover.style.left = (rect.right + 8) + 'px';
    popover.style.top = Math.max(10, Math.min(rect.top - 20, window.innerHeight - 420)) + 'px';
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePopover();
  });

  document.addEventListener('click', (e) => {
    const presetBtn = e.target.closest('[data-insert-preset]');
    if (presetBtn){
      const presetId = presetBtn.dataset.insertPreset;
      if (presetId){
        popover.hidden = true;
        btn.classList.remove('active');
        insertPresetShape(presetId);
      }
    }
  });

  window.addEventListener('pointerdown', (e) => {
    if (!popover.hidden && !popover.contains(e.target) && e.target !== btn && !btn.contains(e.target)){
      popover.hidden = true;
      btn.classList.remove('active');
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.hidden){
      popover.hidden = true;
      btn.classList.remove('active');
    }
  });
}

/* =====================================================================================
   Part 13: remaining wiring + bootstrap
   ===================================================================================== */
function switchTab(name){
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab===name));
  document.querySelectorAll('.tabpanel').forEach(p => p.classList.toggle('active', p.id === 'tab-'+name));
}
function wireTabs(){ document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab))); }
function wireXmlEditor(){
  DOM.xmlout.addEventListener('input', () => { updateXmlHighlight(); updateXmlLineNumbers(); validateXmlEditor(); });
  DOM.xmlout.addEventListener('scroll', () => {
    DOM.xmlLines.scrollTop = DOM.xmlout.scrollTop;
    DOM.xmlHighlight.scrollTop = DOM.xmlout.scrollTop;
    DOM.xmlHighlight.scrollLeft = DOM.xmlout.scrollLeft;
  });
  DOM.xmlout.addEventListener('keydown', (e) => {
    if (e.key === 'Tab'){
      e.preventDefault();
      const start = DOM.xmlout.selectionStart, end = DOM.xmlout.selectionEnd;
      DOM.xmlout.setRangeText('    ', start, end, 'end');
      updateXmlLineNumbers();
    }
  });
  document.getElementById('btnApplyXml').addEventListener('click', applyEditedXml);
}
function wirePanelResize(){
  const handle = DOM.panelResizeHandle;
  if (!handle) return;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    document.body.classList.add('panel-resizing');
    if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId);
    function onMove(ev){
      const maxWidth = Math.min(720, window.innerWidth - 72);
      const width = clamp(window.innerWidth - ev.clientX, 260, Math.max(260, maxWidth));
      DOM.rightpanel.style.width = width + 'px';
      DOM.rightpanel.style.minWidth = width + 'px';
      layoutStage();
    }
    function onUp(){
      handle.classList.remove('dragging');
      document.body.classList.remove('panel-resizing');
      if (handle.releasePointerCapture) handle.releasePointerCapture(e.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}
function wireTopbar(){
  DOM.btnHome.addEventListener('click', showHome);
  DOM.btnUndo.addEventListener('click', undo);
  DOM.btnRedo.addEventListener('click', redo);
  document.getElementById('btnNew').addEventListener('click', createProjectFlow);
  document.getElementById('btnImportSvg').addEventListener('click', () => document.getElementById('fileImportSvg').click());
  document.getElementById('fileImportSvg').addEventListener('change', (e) => { if (e.target.files[0]) importSvgFile(e.target.files[0]); e.target.value=''; });
  document.getElementById('btnSaveProject').addEventListener('click', saveProjectFile);
  document.getElementById('btnLoadProject').addEventListener('click', () => document.getElementById('fileLoadProject').click());
  document.getElementById('fileLoadProject').addEventListener('change', (e) => { if (e.target.files[0]) loadProjectFromFile(e.target.files[0]); e.target.value=''; });
  document.getElementById('btnCopyXml').addEventListener('click', copyXmlToClipboard);
  document.getElementById('btnCopyXml2').addEventListener('click', copyXmlToClipboard);
  document.getElementById('btnExportXml').addEventListener('click', downloadXmlFile);
  document.getElementById('btnExportXml2').addEventListener('click', downloadXmlFile);
}
function wireRail(){
  document.querySelectorAll('#rail [title]').forEach(button => {
    if (!button.dataset.tip) button.dataset.tip = button.getAttribute('title');
    button.removeAttribute('title');
  });
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => btn.addEventListener('click', () => {
    // Point editing is an explicit mode: pressing it again returns to normal handles.
    setTool(btn.dataset.tool === 'node' && state.tool === 'node' ? 'select' : btn.dataset.tool);
  }));
  const moreBtn = document.getElementById('btnMoreTools');
  const moreActions = document.getElementById('railMoreActions');
  if (moreBtn){
    moreBtn.addEventListener('click', () => {
      const open = DOM.rail.classList.toggle('more-open');
      moreBtn.classList.toggle('active', open);
      moreBtn.setAttribute('aria-expanded', String(open));
      if (open && moreActions){
        const rect = moreBtn.getBoundingClientRect();
        moreActions.style.left = (rect.right + 10) + 'px';
        moreActions.style.top = Math.max(10, Math.min(rect.top - 8, window.innerHeight - 230)) + 'px';
      }
      layoutStage();
    });
  }
  document.getElementById('btnZoomIn').addEventListener('click', () => applyZoomAt(state.view.zoom*1.25));
  document.getElementById('btnZoomOut').addEventListener('click', () => applyZoomAt(state.view.zoom/1.25));
  document.getElementById('btnZoomFit').addEventListener('click', fitZoom);
}
function wirePanelVisibility(){
  const body = document.getElementById('body');
  const railBtn = document.getElementById('btnToggleRail');
  const inspectorBtn = document.getElementById('btnToggleRightPanel');
  const previewBtn = document.getElementById('btnTogglePreview');
  const focusBtn = document.getElementById('btnFocusCanvas');
  if (!body || !railBtn || !inspectorBtn || !previewBtn || !focusBtn) return;

  function sync(){
    const railHidden = body.classList.contains('rail-collapsed');
    const inspectorHidden = body.classList.contains('inspector-collapsed');
    const previewHidden = DOM.canvasArea.classList.contains('preview-collapsed');
    const allHidden = railHidden && inspectorHidden && previewHidden;
    railBtn.classList.toggle('active', railHidden);
    inspectorBtn.classList.toggle('active', inspectorHidden);
    previewBtn.classList.toggle('active', previewHidden);
    focusBtn.classList.toggle('active', allHidden);
    railBtn.setAttribute('aria-pressed', String(railHidden));
    inspectorBtn.setAttribute('aria-pressed', String(inspectorHidden));
    previewBtn.setAttribute('aria-pressed', String(previewHidden));
    focusBtn.setAttribute('aria-pressed', String(allHidden));
    railBtn.dataset.tip = railHidden ? 'Show left tools' : 'Hide left tools';
    inspectorBtn.dataset.tip = inspectorHidden ? 'Show inspector' : 'Hide inspector';
    previewBtn.dataset.tip = previewHidden ? 'Show icon previews' : 'Hide icon previews';
    focusBtn.dataset.tip = allHidden ? 'Restore all panels' : 'Focus canvas — hide all panels';
    layoutStage();
  }

  railBtn.addEventListener('click', () => {
    const hiding = !body.classList.contains('rail-collapsed');
    body.classList.toggle('rail-collapsed', hiding);
    if (hiding){
      DOM.rail.classList.remove('more-open');
      document.getElementById('btnMoreTools')?.setAttribute('aria-expanded', 'false');
    }
    sync();
  });
  inspectorBtn.addEventListener('click', () => { body.classList.toggle('inspector-collapsed'); sync(); });
  previewBtn.addEventListener('click', () => { DOM.canvasArea.classList.toggle('preview-collapsed'); sync(); });
  focusBtn.addEventListener('click', () => {
    const restore = body.classList.contains('rail-collapsed') && body.classList.contains('inspector-collapsed') && DOM.canvasArea.classList.contains('preview-collapsed');
    body.classList.toggle('rail-collapsed', !restore);
    body.classList.toggle('inspector-collapsed', !restore);
    DOM.canvasArea.classList.toggle('preview-collapsed', !restore);
    if (!restore) DOM.rail.classList.remove('more-open');
    sync();
  });
  sync();
}
function wireCanvasEvents(){
  DOM.stage.addEventListener('pointerdown', stagePointerDown);
  DOM.stage.addEventListener('pointermove', penMouseMove);
  DOM.stage.addEventListener('dblclick', () => { if (state.tool==='pen' && state.penActive) finalizePen(false); });
  DOM.stage.addEventListener('dblclick', () => { if (state.tool==='cut' && state.cutActive) finalizeCut(); });
  DOM.canvasScroll.addEventListener('pointerdown', (e) => {
    if (e.target === DOM.stage || e.target.namespaceURI === NS_SVG || (e.target.closest && e.target.closest('#stage-svg'))) return;
    if (state.lineDraft){ state.lineDraft = null; state.lineHoverPoint = null; state.lineStartSnap = null; state.activeEndpointSnap = null; renderStage(); }
    else if (state.penActive) cancelPen();
    else if (state.cutActive) cancelCut();
    else if (state.selectedIds.length){ clearSelection(); renderAll(); }
  });
  DOM.canvasScroll.addEventListener('wheel', stageWheel, { passive:false });
  const chkGrid=document.getElementById('chkGrid'), chipGrid=document.getElementById('chipGrid');
  const chkKeyline=document.getElementById('chkKeyline'), chipKeyline=document.getElementById('chipKeyline');
  const chkGuides=document.getElementById('chkGuides'), chipGuides=document.getElementById('chipGuides');
  const chkSnap=document.getElementById('chkSnap'), chipSnap=document.getElementById('chipSnap');
  chkGrid.addEventListener('change', () => { state.grid.show = chkGrid.checked; chipGrid.classList.toggle('on', chkGrid.checked); renderStage(); });
  chkKeyline.addEventListener('change', () => { state.grid.keyline = chkKeyline.checked; chipKeyline.classList.toggle('on', chkKeyline.checked); renderStage(); });
  if (chkGuides && chipGuides){
    chkGuides.addEventListener('change', () => { state.grid.guides = chkGuides.checked; chipGuides.classList.toggle('on', chkGuides.checked); });
  }
  chkSnap.addEventListener('change', () => { state.grid.snap = chkSnap.checked; chipSnap.classList.toggle('on', chkSnap.checked); });
}
function wireSelectionPanels(){
  DOM.selectionPanels.addEventListener('input', onSelectionPanelsInput);
  DOM.selectionPanels.addEventListener('change', onSelectionPanelsChange);
  DOM.selectionPanels.addEventListener('click', onSelectionPanelsClick);
}
function wireMisc(){
  document.getElementById('rightpanel').addEventListener('click', (e) => {
    const head = e.target.closest('.section-head');
    if (head && head.closest('.section')) head.closest('.section').classList.toggle('collapsed');
  });
  DOM.modalBackdrop.addEventListener('click', (e) => { if (e.target === DOM.modalBackdrop) closeModal(); });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('beforeunload', (e) => {
    if (!state.dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
  window.addEventListener('resize', debounce(() => layoutStage(), 120));

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]){
      const file = e.dataTransfer.files[0];
      if (file.name.toLowerCase().endsWith('.svg') || file.type === 'image/svg+xml'){
        importSvgFile(file);
      } else if (file.name.toLowerCase().endsWith('.json')){
        loadProjectFromFile(file);
      }
    }
  });
}
function debounce(fn, ms){ let t; return function(){ clearTimeout(t); const args = arguments; t = setTimeout(() => fn.apply(null, args), ms); }; }

function wireContextMenu(){
  const menu = document.getElementById('canvasContextMenu');
  if (!menu) return;

  function hideContextMenu(){
    menu.hidden = true;
  }

  DOM.canvasScroll.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const target = e.target;
    const shapeNode = target.closest ? target.closest('.shape-node') : null;
    if (shapeNode){
      const id = shapeNode.dataset.id;
      if (!state.selectedIds.includes(id) && !e.shiftKey){
        selectOnly(id);
        renderAll();
      }
    }

    const selCount = state.selectedIds.length;
    const shapes = selectedShapes();
    const hasGroup = shapes.some(s => s.groupId);
    const hasClipboard = Boolean(state.clipboard && state.clipboard.length);

    // Check if any selected shape is a path or connected line that can be disconnected
    const canDisconnect = shapes.some(s => {
      if (s.type === 'path' && s.rawD){
        const sub = parseSvgPathToSubpaths(s.rawD);
        return sub.length > 1 || (sub.length === 1 && sub[0].points.length >= 2);
      }
      return false;
    });

    const linesOrPaths = shapes.filter(s => isLineShape(s) || (s.type === 'path' && !s.locked));

    // Update disabled states
    menu.querySelectorAll('[data-ctx]').forEach(btn => {
      const act = btn.dataset.ctx;
      if (act === 'paste'){
        btn.disabled = !hasClipboard;
      } else if (act === 'cut' || act === 'copy' || act === 'duplicate' || act === 'delete' || act === 'bringFront' || act === 'sendBack' || act === 'bringForward' || act === 'sendBackward' || act === 'flipH' || act === 'flipV' || act === 'resetTransform'){
        btn.disabled = selCount < 1;
      } else if (act === 'disconnectLines'){
        btn.disabled = !canDisconnect;
      } else if (act === 'connectLines'){
        btn.disabled = linesOrPaths.length < 2;
      } else if (act.startsWith('align') || act.startsWith('distribute') || act.startsWith('bool')){
        btn.disabled = selCount < 2;
      } else if (act === 'group'){
        btn.disabled = selCount < 2;
      } else if (act === 'ungroup'){
        btn.disabled = !hasGroup;
      }
    });

    menu.hidden = false;
    const menuWidth = 230, menuHeight = Math.min(500, window.innerHeight - 30);
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 12);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 12);
    menu.style.left = Math.max(10, x) + 'px';
    menu.style.top = Math.max(10, y) + 'px';
  });

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ctx]');
    if (!btn || btn.disabled) return;
    const action = btn.dataset.ctx;
    hideContextMenu();
    handlePropertiesAction(action);
  });

  window.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target)){
      hideContextMenu();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden){
      hideContextMenu();
    }
  });
}

function wireBooleanPopover(){
  const btn = document.getElementById('btnBoolean');
  const popover = document.getElementById('booleanMenuPopover');
  if (!btn || !popover) return;

  function togglePopover(){
    if (!popover.hidden){
      popover.hidden = true;
      btn.classList.remove('active');
      return;
    }

    const selCount = state.selectedIds.length;
    const hint = document.getElementById('boolSelectionHint');
    if (hint){
      hint.textContent = selCount >= 2 
        ? `${selCount} shapes selected — ready to merge or cut`
        : 'Select 2 or more shapes on canvas';
      hint.style.color = selCount >= 2 ? 'var(--accent)' : 'var(--text-2)';
    }

    popover.querySelectorAll('[data-bool]').forEach(b => {
      b.disabled = selCount < 2;
    });

    const rect = btn.getBoundingClientRect();
    popover.hidden = false;
    btn.classList.add('active');
    popover.style.left = (rect.right + 8) + 'px';
    popover.style.top = Math.max(10, Math.min(rect.top - 20, window.innerHeight - 300)) + 'px';
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePopover();
  });

  popover.addEventListener('click', (e) => {
    const boolBtn = e.target.closest('[data-bool]');
    if (boolBtn && !boolBtn.disabled){
      popover.hidden = true;
      btn.classList.remove('active');
      performBooleanOp(boolBtn.dataset.bool);
      return;
    }
  });

  window.addEventListener('pointerdown', (e) => {
    if (!popover.hidden && !popover.contains(e.target) && e.target !== btn && !btn.contains(e.target)){
      popover.hidden = true;
      btn.classList.remove('active');
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.hidden){
      popover.hidden = true;
      btn.classList.remove('active');
    }
  });
}

/* ---------------- hover outline for unselected shapes ---------------- */
function updateHoverOutline(shapeId){
  if (!gHoverOutline) return;
  gHoverOutline.innerHTML = '';
  if (!shapeId) return;
  if (!(state.tool === 'select' || state.tool === 'node')) return;
  if (state.selectedIds.includes(shapeId)) return;
  const shape = findShapeById(shapeId);
  if (!shape || !shape.visible || shape.locked) return;

  // Trace the shape's TRUE visible silhouette — fill unioned with the stroke's own
  // expanded outline (the same geometry the boolean/cut engine uses) — so the outline
  // sits around the outside of a thick stroke instead of the underlying fill path.
  // getShapeVisualRings already returns absolute stage coordinates, so this renders
  // directly with no extra per-shape transform.
  let d = null;
  try {
    const rings = getShapeVisualRings(shape);
    if (rings && rings.length) d = polygonRingsToPath(rings);
  } catch (err){ /* fall back below */ }
  if (!d) d = getShapeTransformedPath(shape);
  if (!d) return;

  gHoverOutline.appendChild(svgEl('path', { d, class: 'hover-outline-path' }));
}
function wireCanvasHoverOutline(){
  if (!gShapes) return;
  gShapes.addEventListener('pointerover', (e) => {
    const node = e.target.closest ? e.target.closest('.shape-node') : null;
    if (!node) return;
    state.hoveredShapeId = node.dataset.id;
    updateHoverOutline(state.hoveredShapeId);
  });
  gShapes.addEventListener('pointerout', (e) => {
    const node = e.target.closest ? e.target.closest('.shape-node') : null;
    if (!node) return;
    if (e.relatedTarget && node.contains && node.contains(e.relatedTarget)) return;
    state.hoveredShapeId = null;
    if (gHoverOutline) gHoverOutline.innerHTML = '';
  });
  DOM.stage.addEventListener('pointerleave', () => {
    state.hoveredShapeId = null;
    if (gHoverOutline) gHoverOutline.innerHTML = '';
  });
}

function init(){
  cacheDom();
  buildStageSkeleton();
  wireTopbar();
  wireRail();
  wirePanelVisibility();
  wireTabs();
  wireXmlEditor();
  wirePanelResize();
  wireCanvasEvents();
  wireCanvasHoverOutline();
  wireContextMenu();
  wireBooleanPopover();
  wirePresetShapesPopover();
  wireDocSettings();
  wireSelectionPanels();
  wireLayerList();
  wireMisc();
  wireHome();
  syncDocSettingsUI();
  fitZoom();
  renderAll();
  document.body.classList.add('home-visible');
  renderHome();
  wireMobileBlock();
  wireReferencePanel();
}
if (document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
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
    renderAll();
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}