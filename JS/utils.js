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


/* =====================================================================================
   Part 1b: Google Fonts browsing + text-to-outline conversion
   Android Vector Drawables have no <text> element — everything has to be static path data.
   So a text shape keeps its live properties (content/family/weight/size/...) as the source
   of truth, but is actually drawn/exported using a real vector outline traced from the
   actual Google Font file, regenerated any time those properties change. This is also why
   the exported XML/SVG/PNG can't be edited as text again afterward — see the note wired up
   near renderXmlPreview().
   ===================================================================================== */
let __googleFontsList = null;
let __googleFontsListPromise = null;
// One in-memory cache entry per family+weight+italic combo actually used this session, so
// repeated edits (or several text shapes sharing a font) don't refetch/reparse the same
// font file. Not persisted — a fresh session re-fetches from Google Fonts on first use.
const __opentypeFontCache = new Map();
let __bundledDefaultFontPromise = null;

function getBundledDefaultFont(){
  if (__bundledDefaultFontPromise) return __bundledDefaultFontPromise;
  __bundledDefaultFontPromise = fetch('/default-font/Roboto-VariableFont_wdth,wght.ttf')
    .then(r => { if (!r.ok) throw new Error(`Default font request failed (${r.status})`); return r.arrayBuffer(); })
    .then(buf => opentype.parse(buf))
    .catch(err => { __bundledDefaultFontPromise = null; throw err; });
  return __bundledDefaultFontPromise;
}

function fetchGoogleFontsList(){
  if (__googleFontsListPromise) return __googleFontsListPromise;
  // Routed through this app's own backend (see app.py) rather than calling Google
  // directly — the real API key lives only in the server's environment, never in
  // anything shipped to the browser. The proxy returns the same { items: [...] } shape
  // Google's own endpoint does, so nothing below this line needed to change.
  __googleFontsListPromise = fetch('/api/google-fonts')
    .then(r => { if (!r.ok) throw new Error('Google Fonts list request failed (' + r.status + ')'); return r.json(); })
    .then(data => { __googleFontsList = data.items || []; return __googleFontsList; })
    .catch(err => { __googleFontsListPromise = null; throw err; });
  return __googleFontsListPromise;
}
// Google's webfonts API keys each family's downloadable files by a "variant" string:
// 'regular' / 'italic' for weight 400, otherwise the numeric weight optionally suffixed
// with 'italic' (e.g. '700', '700italic'). Falls back progressively toward whatever the
// family actually ships if the exact weight/style isn't available.
function fontVariantKey(weight, italic){
  const w = Math.round(weight) || 400;
  if (w === 400) return italic ? 'italic' : 'regular';
  return String(w) + (italic ? 'italic' : '');
}
function findFontVariantFileUrl(familyMeta, weight, italic){
  if (!familyMeta || !familyMeta.files) return null;
  const files = familyMeta.files;
  const tryKeys = [
    fontVariantKey(weight, italic),
    fontVariantKey(weight, false),
    italic ? 'italic' : 'regular',
    'regular',
  ];
  for (const key of tryKeys){
    if (files[key]) return files[key];
  }
  const anyKey = Object.keys(files)[0];
  return anyKey ? files[anyKey] : null;
}
function getOpentypeFont(family, weight, italic){
  const key = family + '|' + (Math.round(weight) || 400) + '|' + (italic ? 'i' : 'n');
  if (__opentypeFontCache.has(key)) return __opentypeFontCache.get(key);
  if (family === 'Roboto'){
    const promise = getBundledDefaultFont();
    __opentypeFontCache.set(key, promise);
    return promise;
  }
  const promise = fetchGoogleFontsList().then(list => {
    const meta = list.find(f => f.family === family);
    if (!meta) throw new Error(`"${family}" isn't a recognized Google Font`);
    const w = Math.round(weight) || 400;
    const style = italic ? '1' : '0';
    const params = new URLSearchParams({ family, weight: String(w), italic: style });
    return fetch(`/api/google-font-file?${params}`).then(r => {
      if (!r.ok) throw new Error(`Font file request failed (${r.status})`);
      return r.arrayBuffer();
    });
  }).then(buf => {
    return opentype.parse(buf);
  }).then(r => {
    return r;
  })
    .catch(err => { __opentypeFontCache.delete(key); throw err; });
  __opentypeFontCache.set(key, promise);
  return promise;
}
function applyTextOutline(shape, font){
  const text = shape.text != null ? String(shape.text) : '';
  const size = Math.max(0.01, shape.fontSize || 10);
  const align = shape.textAlign || 'left';
  const lineHeight = size * 1.2;
  const lines = text.length ? text.split('\n') : [''];
  const opts = { kerning: true, letterSpacing: (shape.letterSpacing || 0) / size };
  const dParts = [];
  lines.forEach((line, i) => {
    const content = line.length ? line : ' ';
    const advance = font.getAdvanceWidth(content, size, opts);
    const xOffset = align === 'center' ? -advance/2 : align === 'right' ? -advance : 0;
    const path = font.getPath(content, shape.anchorX + xOffset, shape.anchorY + i*lineHeight, size, opts);
    const d = path.toPathData(3);
    if (d) dParts.push(d);
  });
  const d = dParts.join(' ') || 'M0,0';
  const bbox = measurePathBBox(d);
  const maxExtent = Math.max(state.doc.viewportWidth, state.doc.viewportHeight, 24) * 100;
  if (!isFinite(bbox.x) || !isFinite(bbox.y) || !isFinite(bbox.width) || !isFinite(bbox.height) ||
      bbox.width <= 0 || bbox.height <= 0 || bbox.width > maxExtent || bbox.height > maxExtent ||
      Math.abs(bbox.x) > maxExtent * 10 || Math.abs(bbox.y) > maxExtent * 10) {
    throw new Error('Font produced an unusable outline');
  }
  shape.rawD = d;
  shape.pivotX = bbox.x + bbox.width/2;
  shape.pivotY = bbox.y + bbox.height/2;
  shape.nativeWidth = Math.max(0.0001, bbox.width);
  shape.nativeHeight = Math.max(0.0001, bbox.height);
}
// Regenerates a text shape's baked outline (rawD + pivot/nativeWidth/nativeHeight) from its
// live text/font properties. Async (font list + font file are both fetched over the
// network, once per combo, then cached) — callers re-render once the returned promise
// settles. Leaves the shape's previous outline in place while loading/on error, and records
// __textLoading/__textError so the properties panel can show a status inline.
function regenerateTextPath(shape){
  if (!shape || shape.type !== 'text') return Promise.resolve();
  const weight = shape.fontWeight || 400;
  const italic = !!shape.fontItalic;
  shape.__textLoading = true;
  shape.__textError = null;
  const fallback = getBundledDefaultFont().then(font => {
    applyTextOutline(shape, font);
    renderStage();
    return font;
  });
  const requested = shape.fontFamily === 'Roboto'
    ? fallback
    : getOpentypeFont(shape.fontFamily, weight, italic);
  return fallback.catch(() => null).then(() => requested).then(font => {
    applyTextOutline(shape, font);
    shape.__textLoading = false;
    renderStage();
  }).catch(err => {
    shape.__textLoading = false;
    shape.__textError = (err && err.message) || 'Could not load this font';
    throw err;
  });
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
// Re-derive a curve shape's cached pivot/native-size fields from its current control
// points. Needed after directly editing x1/y1/cp1x/cp1y/cp2x/cp2y/x2/y2 (node-tool drags),
// since those fields are what the generic scale/resize handles (visualHandleBBox) read —
// without this, the resize handles keep showing the curve's bounding box from whenever it
// was first created, instead of adapting to its current, edited size. Also resets any
// existing rotation/scale/translate to identity: the node-tool drag writes the new point
// straight from the stage-space pointer position into these "local" fields, so baking that
// in as the new untransformed geometry (like line-endpoint editing already does) keeps the
// shape's transform and its raw points consistent instead of double-applying an old scale.
function recomputeCurveBounds(shape){
  shape.rotation = 0;
  shape.scaleX = 1;
  shape.scaleY = 1;
  shape.translateX = 0;
  shape.translateY = 0;
  const d = `M${fmt(shape.x1)},${fmt(shape.y1)} C${fmt(shape.cp1x)},${fmt(shape.cp1y)} ${fmt(shape.cp2x)},${fmt(shape.cp2y)} ${fmt(shape.x2)},${fmt(shape.y2)}`;
  shape.rawD = d;
  const bbox = measurePathBBox(d);
  shape.pivotX = (shape.x1 + shape.x2) / 2;
  shape.pivotY = (shape.y1 + shape.y2) / 2;
  shape.nativeWidth = Math.max(0.0001, bbox.width);
  shape.nativeHeight = Math.max(0.0001, bbox.height);
}
function insertPresetShape(presetKey, targetBounds = null){
  const def = PRESET_SHAPES[presetKey];
  if (!def) return null;
  const vw = state.doc.viewportWidth, vh = state.doc.viewportHeight;
  let x, y, w, h;
  if (targetBounds){
    x = targetBounds.x; y = targetBounds.y; w = targetBounds.width; h = targetBounds.height;
  } else {
    // Proportional size (2/3 of viewport min dimension, capped at 200) centered in viewport
    const base = Math.min(vw, vh);
    const size = Math.max(1, Math.min(200, Math.round(base * (2 / 3))));
    w = size;
    h = size;
    x = (vw - w) / 2;
    y = (vh - h) / 2;
  }
  let shape;
  if (def.isArc){
    // Real Arc shape (not a flattened path) — opens straight into the Arc/Pie panel and
    // the on-canvas angle handles so the "opening" is adjustable right away.
    shape = createArcShape(x, y, w, h, -90, 270, true, 0);
    shape.name = def.name;
    shape.fillColor = '#5EE1A0';
    shape.strokeColor = '#5EE1A0';
  } else {
    const d = def.generate(x, y, w, h);
    shape = createPathShape(d);
    shape.name = def.name;
    shape.fillColor = '#5EE1A0';
    shape.strokeColor = '#5EE1A0';
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
  if (shape.type === 'path' || shape.type === 'curve' || shape.type === 'text') return { x: shape.pivotX, y: shape.pivotY };
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
  if (shape.type === 'path' || shape.type === 'curve' || shape.type === 'text') return { x: shape.translateX||0, y: shape.translateY||0 };
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
  } else if (shape.type === 'path' || shape.type === 'curve' || shape.type === 'text'){
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
  if (shape.type === 'path' || shape.type === 'curve' || shape.type === 'text') return { width: shape.nativeWidth, height: shape.nativeHeight };
  return { width: shape.width, height: shape.height };
}
function shapeHasFillOrStroke(shape){
  return shape.fillEnabled || shape.strokeEnabled || (shape.strokeInnerWidth || 0) > 0 || (shape.strokeOuterWidth || 0) > 0;
}


