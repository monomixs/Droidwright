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
    inheritPaintFrom(newShape, primary);

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
    inheritPaintFrom(newShape, primary);

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

/* Signed area of a polygon ring (shoelace formula) — sign tells us which way it winds. */
function ringSignedArea(ring){
  let area = 0;
  for (let i = 0; i < ring.length; i++){
    const p1 = ring[i], p2 = ring[(i + 1) % ring.length];
    area += (p1.x * p2.y - p2.x * p1.y);
  }
  return area / 2;
}

/* Merge — unlike Union, this does NOT recompute geometry (no clipping/overlap removal).
   It flattens every selected shape into simple polygon subpaths (the same representation
   the boolean engine uses, via getShapeVisualRings), normalizes them all to the SAME
   winding direction, and concatenates them into one path.
   That winding-normalization step matters: under the nonzero fill rule, two overlapping
   subpaths that wind in OPPOSITE directions cancel out where they overlap — which looks
   exactly like an accidental Exclude/XOR instead of a clean merge. This happens easily
   with freehand pen paths, since their winding depends on which way the points were
   clicked, and won't necessarily match a preset shape's winding. */
function mergeSelectedShapesIntoPath(){
  const shapes = selectedShapes().filter(s => s.visible && !s.locked);
  if (shapes.length < 2){
    showToast('Select 2 or more shapes to merge');
    return;
  }
  // Keep them in their current stacking order, not click/selection order.
  const ordered = state.shapes.filter(s => shapes.includes(s));
  const topmost = ordered[ordered.length - 1];

  let combinedD = null;
  try {
    const allRings = [];
    let referenceSign = null;
    for (const s of ordered){
      // Flatten just the FILL outline (not a fill+stroke union — Merge should keep each
      // shape's geometry exactly as drawn, not bake its stroke into solid fill).
      const rings = parseSvgPathToRings(getShapeTransformedPath(s));
      if (!rings || !rings.length) throw new Error('no rings for shape ' + s.id);
      for (const ring of rings){
        if (!ring || ring.length < 3) continue;
        const area = ringSignedArea(ring);
        if (referenceSign === null && area !== 0) referenceSign = area > 0;
        const isPositive = area > 0;
        const normalized = (referenceSign === null || isPositive === referenceSign) ? ring : ring.slice().reverse();
        allRings.push(normalized);
      }
    }
    if (!allRings.length) throw new Error('no rings produced');
    combinedD = polygonRingsToPath(allRings);
  } catch (err){
    // Fall back to raw path concatenation if flattening fails for some shape type
    combinedD = ordered.map(s => getShapeTransformedPath(s)).join(' ');
  }

  const fillCol = topmost.fillEnabled ? topmost.fillColor : (topmost.strokeEnabled ? topmost.strokeColor : '#5EE1A0');
  const fillOp = topmost.fillEnabled ? topmost.fillOpacity : (topmost.strokeEnabled ? topmost.strokeOpacity : 1);

  const newShape = createPathShape(combinedD, {
    name: 'Merged Path',
    fillEnabled: true,
    fillColor: fillCol,
    fillOpacity: fillOp,
    fillType: 'nonZero',
    strokeEnabled: !!topmost.strokeEnabled,
    strokeColor: topmost.strokeColor,
    strokeOpacity: topmost.strokeOpacity,
    strokeWidth: topmost.strokeWidth,
    strokeLineCap: topmost.strokeLineCap,
    strokeLineJoin: topmost.strokeLineJoin,
    strokeMiterLimit: topmost.strokeMiterLimit,
  });
  inheritPaintFrom(newShape, topmost);

  doAction(() => {
    const idx = shapeIndex(topmost.id);
    deleteShapesByIds(ordered.map(s => s.id));
    state.shapes.splice(Math.max(0, idx), 0, newShape);
    state.selectedIds = [newShape.id];
  });
  showToast(`Merged ${ordered.length} shapes into one path — if it should have a hole where they overlap, try switching Fill rule to Even-Odd`);
}

