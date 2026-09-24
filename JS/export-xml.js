/* =====================================================================================
   Part 8: Android XML generation, syntax highlight, copy / export, save & load project
   ===================================================================================== */
/* Android carries gradients as an inline <aapt:attr> child of <path> rather than as an
   attribute value — it's the AAPT2 mechanism for giving an attribute a whole nested
   resource. Requires the aapt namespace on <vector>, and minSdk 24. */
function gradientXmlLines(gradient, bbox, attrName, indent){
  const g = normalizeGradient(gradient);
  const geo = gradientUserGeometry(g, bbox);
  const out = [];
  const inner = indent + '    ';
  const deep = inner + '    ';
  out.push(`${indent}<aapt:attr name="android:${attrName}">`);
  let gAttrs = `android:type="${g.type}"`;
  if (g.type === 'linear'){
    gAttrs += `\n${deep}android:startX="${fmtAttr(geo.startX)}"`;
    gAttrs += `\n${deep}android:startY="${fmtAttr(geo.startY)}"`;
    gAttrs += `\n${deep}android:endX="${fmtAttr(geo.endX)}"`;
    gAttrs += `\n${deep}android:endY="${fmtAttr(geo.endY)}"`;
  } else {
    gAttrs += `\n${deep}android:centerX="${fmtAttr(geo.centerX)}"`;
    gAttrs += `\n${deep}android:centerY="${fmtAttr(geo.centerY)}"`;
    if (g.type === 'radial') gAttrs += `\n${deep}android:gradientRadius="${fmtAttr(geo.radius)}"`;
  }
  if (g.tileMode !== 'clamp') gAttrs += `\n${deep}android:tileMode="${g.tileMode}"`;
  out.push(`${inner}<gradient ${gAttrs}>`);
  for (const stop of g.stops){
    out.push(`${deep}<item android:offset="${fmtAttr(stop.offset)}" android:color="${androidColorWithAlpha(stop.color, stop.opacity)}"/>`);
  }
  out.push(`${inner}</gradient>`);
  out.push(`${indent}</aapt:attr>`);
  return out;
}
function docUsesGradients(){
  return state.shapes.some(s => s.visible && shapeUsesGradient(s));
}
function generateXmlString(){
  const d = state.doc;
  const lines = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  const needsAapt = docUsesGradients();
  let vecAttrs = 'xmlns:android="http://schemas.android.com/apk/res/android"';
  if (needsAapt) vecAttrs += '\n    xmlns:aapt="http://schemas.android.com/aapt"';
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
    const fillGradient = activeGradient(shape, 'fill');
    const strokeGradient = activeGradient(shape, 'stroke');
    const gradientChildren = [];
    const paintBox = paintBBoxForShape(shape);
    let pAttrs = `android:name="${uniqueName(baseName)}"`;
    pAttrs += `\n${pindent}    android:pathData="${shapePathData(shape)}"`;
    if (shape.fillEnabled){
      if (shape.fillEnabled && fillGradient) gradientChildren.push(...gradientXmlLines(fillGradient, paintBox, 'fillColor', pindent + '    '));
      else pAttrs += `\n${pindent}    android:fillColor="${shape.fillColor}"`;
      if (shape.fillOpacity !== 1) pAttrs += `\n${pindent}    android:fillAlpha="${fmtAttr(shape.fillOpacity)}"`;
      if (shape.fillType === 'evenOdd') pAttrs += `\n${pindent}    android:fillType="evenOdd"`;
    }
    if (shape.strokeEnabled){
      if (strokeGradient) gradientChildren.push(...gradientXmlLines(strokeGradient, paintBox, 'strokeColor', pindent + '    '));
      else pAttrs += `\n${pindent}    android:strokeColor="${shape.strokeColor}"`;
      pAttrs += `\n${pindent}    android:strokeWidth="${fmtAttr(shape.strokeWidth)}"`;
      if (shape.strokeOpacity !== 1) pAttrs += `\n${pindent}    android:strokeAlpha="${fmtAttr(shape.strokeOpacity)}"`;
      if (shape.strokeLineCap !== 'butt') pAttrs += `\n${pindent}    android:strokeLineCap="${shape.strokeLineCap}"`;
      if (shape.strokeLineJoin !== 'miter') pAttrs += `\n${pindent}    android:strokeLineJoin="${shape.strokeLineJoin}"`;
      if (shape.strokeLineJoin === 'miter' && shape.strokeMiterLimit !== 4) pAttrs += `\n${pindent}    android:strokeMiterLimit="${fmtAttr(shape.strokeMiterLimit)}"`;
    }
    if (gradientChildren.length){
      lines.push(`${pindent}<path ${pAttrs}>`);
      lines.push(...gradientChildren);
      lines.push(`${pindent}</path>`);
    } else {
      lines.push(`${pindent}<path ${pAttrs}/>`);
    }
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
const AAPT_NS = 'http://schemas.android.com/aapt';
function androidXmlAttr(el, name){
  return el.getAttributeNS(ANDROID_NS, name) || el.getAttribute('android:' + name) || '';
}
/* Finds the <gradient> nested under <aapt:attr name="android:fillColor"> (or strokeColor)
   and converts it back into the normalized model. The inverse of gradientXmlLines(). */
function parseAaptGradient(pathEl, attrName, bbox){
  let gradientEl = null;
  for (const child of Array.from(pathEl.children)){
    if (child.localName !== 'attr') continue;
    const name = child.getAttributeNS(AAPT_NS, 'name') || child.getAttribute('name') || child.getAttribute('aapt:name') || '';
    if (name !== 'android:' + attrName && name !== attrName) continue;
    gradientEl = Array.from(child.children).find(n => n.localName === 'gradient') || null;
    break;
  }
  if (!gradientEl) return null;
  const type = (androidXmlAttr(gradientEl, 'type') || 'linear').toLowerCase();
  const g = makeGradient(GRADIENT_TYPES.indexOf(type) >= 0 ? type : 'linear');
  const w = Math.max(bbox.width, 1e-4), h = Math.max(bbox.height, 1e-4);
  const num = (name) => { const v = parseXmlNumber(androidXmlAttr(gradientEl, name)); return isFinite(v) ? v : null; };

  if (g.type === 'linear'){
    const sx = num('startX'), sy = num('startY'), ex = num('endX'), ey = num('endY');
    if (sx != null && sy != null && ex != null && ey != null){
      const dx = ex - sx, dy = ey - sy;
      // Recover the authored angle from the endpoints; the magnitude is implied by the box.
      if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9){
        g.angle = ((Math.atan2(dy, dx) * 180 / Math.PI) % 360 + 360) % 360;
      }
    }
  } else {
    const cx = num('centerX'), cy = num('centerY');
    if (cx != null) g.cx = clamp((cx - bbox.x) / w, -1, 2);
    if (cy != null) g.cy = clamp((cy - bbox.y) / h, -1, 2);
    const r = num('gradientRadius');
    if (r != null) g.radius = clamp(r / Math.max(w, h), 0.01, 3);
  }
  const tile = (androidXmlAttr(gradientEl, 'tileMode') || 'clamp').toLowerCase();
  if (TILE_MODES.indexOf(tile) >= 0) g.tileMode = tile;

  const items = Array.from(gradientEl.children).filter(n => n.localName === 'item');
  const stops = [];
  for (const item of items){
    const parsed = parseAndroidColor(androidXmlAttr(item, 'color'));
    if (!parsed) continue;
    const offset = parseXmlNumber(androidXmlAttr(item, 'offset'));
    stops.push(makeGradientStop(isFinite(offset) ? offset : stops.length, parsed.hex, parsed.opacity));
  }
  // Android also accepts the shorthand start/center/end color trio instead of <item>s.
  if (stops.length < 2){
    const trio = [['startColor', 0], ['centerColor', 0.5], ['endColor', 1]];
    for (const [attr, offset] of trio){
      const parsed = parseAndroidColor(androidXmlAttr(gradientEl, attr));
      if (parsed) stops.push(makeGradientStop(offset, parsed.hex, parsed.opacity));
    }
  }
  if (stops.length < 2) return null;
  g.stops = stops.slice(0, MAX_GRADIENT_STOPS);
  return sortGradientStops(g);
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
      const localBox = { x:bbox.x, y:bbox.y, width:Math.max(bbox.width, 1e-3), height:Math.max(bbox.height, 1e-3) };
      const fillGradient = parseAaptGradient(child, 'fillColor', localBox);
      const strokeGradient = parseAaptGradient(child, 'strokeColor', localBox);
      shape.fillEnabled = fillGradient ? true : androidXmlAttr(child, 'fillColor') !== 'none';
      shape.fillColor = androidXmlAttr(child, 'fillColor') || (fillGradient ? fillGradient.stops[0].color : '#000000');
      shape.fillOpacity = parseXmlNumber(androidXmlAttr(child, 'fillAlpha')) || 1;
      shape.fillType = androidXmlAttr(child, 'fillType') === 'evenOdd' ? 'evenOdd' : 'nonZero';
      shape.fillPaint = fillGradient ? 'gradient' : 'solid';
      shape.fillGradient = fillGradient;
      shape.strokeEnabled = strokeGradient ? true : (!!androidXmlAttr(child, 'strokeColor') && androidXmlAttr(child, 'strokeColor') !== 'none');
      shape.strokeColor = androidXmlAttr(child, 'strokeColor') || (strokeGradient ? strokeGradient.stops[0].color : '#000000');
      shape.strokePaint = strokeGradient ? 'gradient' : 'solid';
      shape.strokeGradient = strokeGradient;
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
function updateTextPortabilityBadge(){
  const badge = document.getElementById('xmlTextBadge');
  if (!badge) return;
  const hasVisibleText = state.shapes.some(s => s.type === 'text' && s.visible);
  badge.hidden = !hasVisibleText;
}
function renderXmlPreview(){
  const xml = generateXmlString();
  state.lastXml = xml;
  if (DOM.xmlout && document.activeElement !== DOM.xmlout){ DOM.xmlout.value = xml; validateXmlEditor(); }
  updateXmlHighlight();
  updateXmlLineNumbers();
  updateTextPortabilityBadge();
}
function applyEditedXml(){
  if (!validateXmlEditor()) return showToast('Fix the XML warning before applying it');
  const result = parseEditedAndroidXml(DOM.xmlout.value);
  doAction(() => {
    state.doc = Object.assign({}, state.doc, result.doc);
    state.shapes = result.shapes;
    state.groups = {};
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

// Builds a standalone <svg> element that mirrors what the editor and Android XML export
// show: shapes clipped to the true viewport (the bleed working-area is cropped away, same
// as canvas_clip in the XML), with the doc background layer included only when it's both
// enabled and marked for export. Used for the export-popover preview, the .svg download,
// and as the source image rasterized for the .png download.
function buildExportSvgRoot(pxWidth, pxHeight){
  const d = state.doc;
  const vw = d.viewportWidth, vh = d.viewportHeight;
  const w = pxWidth != null ? pxWidth : d.width;
  const h = pxHeight != null ? pxHeight : d.height;
  const svg = svgEl('svg', {
    xmlns: NS_SVG,
    viewBox: `0 0 ${fmtAttr(vw)} ${fmtAttr(vh)}`,
    width: fmtAttr(w),
    height: fmtAttr(h),
  });
  const clipId = 'exportClip_' + Math.random().toString(36).slice(2, 9);
  const defs = svgEl('defs');
  const clip = svgEl('clipPath', { id: clipId });
  clip.appendChild(svgEl('rect', { x:0, y:0, width: fmtAttr(vw), height: fmtAttr(vh) }));
  defs.appendChild(clip);
  svg.appendChild(defs);

  const content = svgEl('g', { 'clip-path': `url(#${clipId})` });
  if (d.alpha != null && d.alpha !== 1) content.setAttribute('opacity', fmtAttr(d.alpha));
  if (d.backgroundEnabled && d.backgroundExport){
    content.appendChild(svgEl('rect', {
      x:0, y:0, width: fmtAttr(vw), height: fmtAttr(vh),
      fill: d.backgroundColor || '#1E222B',
      opacity: fmtAttr(d.backgroundOpacity != null ? d.backgroundOpacity : 1),
    }));
  }
  for (const shape of state.shapes){
    if (!shape.visible) continue;
    content.appendChild(buildShapeVisualGroup(shape));
  }
  svg.appendChild(content);
  return svg;
}
function generateSvgString(pxWidth, pxHeight){
  return new XMLSerializer().serializeToString(buildExportSvgRoot(pxWidth, pxHeight));
}
function downloadSvgFile(){
  const svgStr = '<?xml version="1.0" encoding="UTF-8"?>\n' + generateSvgString();
  const blob = new Blob([svgStr], { type:'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitizeResourceName(state.doc.name) + '.svg';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast('Downloaded ' + a.download);
}
function downloadPngFile(longEdgePx){
  const d = state.doc;
  const vw = d.viewportWidth, vh = d.viewportHeight;
  const size = longEdgePx || 512;
  // Keep the export's aspect ratio matching the doc's viewport even if it isn't square.
  const pxWidth = vw >= vh ? size : Math.max(1, Math.round(size * (vw / vh)));
  const pxHeight = vh >= vw ? size : Math.max(1, Math.round(size * (vh / vw)));
  const svgStr = generateSvgString(pxWidth, pxHeight);
  const svgBlob = new Blob([svgStr], { type:'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = pxWidth;
    canvas.height = pxHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, pxWidth, pxHeight);
    URL.revokeObjectURL(svgUrl);
    canvas.toBlob((blob) => {
      if (!blob){ showToast('PNG export failed'); return; }
      const pngUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = pngUrl;
      a.download = sanitizeResourceName(state.doc.name) + '.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(pngUrl), 2000);
      showToast('Downloaded ' + a.download);
    }, 'image/png');
  };
  img.onerror = () => {
    URL.revokeObjectURL(svgUrl);
    showToast('PNG export failed — could not render the preview image');
  };
  img.src = svgUrl;
}
const PROJECTS_KEY = 'droidwright.projects.v1';
const HOME_GROUPS_KEY = 'droidwright.home-groups.v1';
const RECENT_CANVAS_SIZES_KEY = 'droidwright.recent-canvas-sizes.v1';
const DATA_EXPORT_FORMAT = 'droidwright-data-export';
const DATA_EXPORT_VERSION = 1;
const MAX_RECENT_CANVAS_SIZES = 6;
const CANVAS_PRESETS = [
  { label:'Material icon', detail:'24 × 24 dp', width:24, height:24 },
  { label:'Standard icon', detail:'48 × 48 dp', width:48, height:48 },
  { label:'Launcher layer', detail:'108 × 108 dp', width:108, height:108 },
  { label:'Large square', detail:'512 × 512 dp', width:512, height:512 },
  { label:'Wide canvas', detail:'192 × 108 dp', width:192, height:108 },
];
function validCanvasDimension(value){
  const n = Number(value);
  return isFinite(n) && n >= 1 && n <= 4096 ? Math.round(n) : null;
}
function readRecentCanvasSizes(){
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_CANVAS_SIZES_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    const seen = new Set();
    return saved.map((item) => ({ width:validCanvasDimension(item && item.width), height:validCanvasDimension(item && item.height) }))
      .filter((item) => item.width && item.height && !seen.has(item.width + 'x' + item.height) && seen.add(item.width + 'x' + item.height))
      .slice(0, MAX_RECENT_CANVAS_SIZES);
  } catch (err){ return []; }
}
function writeRecentCanvasSizes(sizes){
  try { localStorage.setItem(RECENT_CANVAS_SIZES_KEY, JSON.stringify(sizes)); } catch (err){ /* storage unavailable */ }
}
function rememberCanvasSize(width, height){
  const w = validCanvasDimension(width), h = validCanvasDimension(height);
  if (!w || !h) return;
  const recent = readRecentCanvasSizes().filter((item) => item.width !== w || item.height !== h);
  recent.unshift({ width:w, height:h });
  writeRecentCanvasSizes(recent.slice(0, MAX_RECENT_CANVAS_SIZES));
}
function droidwrightOtherLocalData(){
  const out = {};
  const excluded = new Set([PROJECTS_KEY, RECENT_CANVAS_SIZES_KEY, 'droidwright.settings.v1', 'droidwright.boot.v1']);
  try {
    for (let i = 0; i < localStorage.length; i++){
      const key = localStorage.key(i);
      if (!key || !key.startsWith('droidwright.') || excluded.has(key)) continue;
      out[key] = localStorage.getItem(key);
    }
  } catch (err){ /* storage unavailable */ }
  return out;
}
function dataExportFilename(){
  const date = new Date().toISOString().slice(0, 10);
  return `droidwright-data-${date}.json`;
}
function downloadDataExport(){
  // A manual save is not required before a transfer: the open dirty project is included too.
  if (state.projectId && state.dirty) persistActiveProject();
  const payload = {
    format: DATA_EXPORT_FORMAT,
    version: DATA_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    projects: readProjects(),
    settings: deepClone(settings),
    recentCanvasSizes: readRecentCanvasSizes(),
    otherLocalData: droidwrightOtherLocalData(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = dataExportFilename();
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast('Downloaded ' + anchor.download);
}
function normalizeExportProjects(rawProjects){
  if (!Array.isArray(rawProjects)) throw new Error('Projects are missing');
  const usedIds = new Set();
  return rawProjects.reduce((projects, rawProject, index) => {
    if (!rawProject || typeof rawProject !== 'object' || !rawProject.doc || !Array.isArray(rawProject.shapes)) return projects;
    const shapes = normalizeLoadedShapes(deepClone(rawProject.shapes));
    const groups = normalizeLoadedGroups(rawProject.groups, shapes);
    let id = String(rawProject.id || `dw-import-${Date.now().toString(36)}-${index}`);
    while (usedIds.has(id)) id += '-copy';
    usedIds.add(id);
    projects.push({
      id,
      name: String(rawProject.name || rawProject.doc.name || 'Untitled icon').slice(0, 80),
      doc: deepClone(rawProject.doc),
      shapes,
      groups,
      createdAt: Number(rawProject.createdAt) || Date.now(),
      updatedAt: Number(rawProject.updatedAt) || Date.now(),
    });
    return projects;
  }, []);
}
function normalizeExportOtherData(raw){
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)){
    if (key.startsWith('droidwright.') && typeof value === 'string') out[key] = value;
  }
  return out;
}
function importDroidwrightDataPayload(payload){
  if (!payload || payload.format !== DATA_EXPORT_FORMAT || Number(payload.version) !== DATA_EXPORT_VERSION) throw new Error('Not a Droidwright data export');
  const projects = normalizeExportProjects(payload.projects);
  const recentCanvasSizes = Array.isArray(payload.recentCanvasSizes) ? payload.recentCanvasSizes
    .map((item) => ({ width:validCanvasDimension(item && item.width), height:validCanvasDimension(item && item.height) }))
    .filter((item) => item.width && item.height)
    .slice(0, MAX_RECENT_CANVAS_SIZES) : [];
  const importedSettings = normalizeSettingsObject(payload.settings);
  const otherData = normalizeExportOtherData(payload.otherLocalData);
  const existingCount = readProjects().length;
  showConfirmModal({
    title: 'Replace local data?',
    message: `Replace this browser's Droidwright data with ${projects.length} imported project${projects.length === 1 ? '' : 's'}? Your current ${existingCount} project${existingCount === 1 ? '' : 's'} and settings will be replaced.`,
    confirmLabel: 'Replace data',
    danger: true,
    onConfirm: () => {
      try {
        const keysToClear = [];
        for (let i = 0; i < localStorage.length; i++){
          const key = localStorage.key(i);
          if (key && key.startsWith('droidwright.')) keysToClear.push(key);
        }
        keysToClear.forEach((key) => localStorage.removeItem(key));
        for (const [key, value] of Object.entries(otherData)) localStorage.setItem(key, value);
        writeProjects(projects);
        writeRecentCanvasSizes(recentCanvasSizes);
        settings = importedSettings;
        persistSettings();
        Object.keys(SETTING_DEFS).forEach(applySetting);
        state.projectId = null;
        state.projectName = '';
        state.dirty = false;
        state.shapes = [];
        state.groups = {};
        state.selectedIds = [];
        state.history.past = [];
        state.history.future = [];
        document.body.classList.add('home-visible');
        renderHome();
        syncSettingsRows();
        updateSettingRowStates();
        showToast(`Imported ${projects.length} project${projects.length === 1 ? '' : 's'} and settings`);
      } catch (err){
        showToast('Could not import that data file');
      }
    },
  });
}
function importDroidwrightDataFile(file){
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try { importDroidwrightDataPayload(JSON.parse(String(reader.result))); }
    catch (err){ showToast('Could not read that Droidwright data export'); }
  };
  reader.onerror = () => showToast('Could not read that data file');
  reader.readAsText(file);
}
function readProjects(){
  try { const data = JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]'); return Array.isArray(data) ? data : []; }
  catch (err) { return []; }
}
function writeProjects(projects){ localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects)); }
function readHomeGroups(){
  try {
    const data = JSON.parse(localStorage.getItem(HOME_GROUPS_KEY) || '{}');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (err){ return {}; }
}
function writeHomeGroups(groups){
  try { localStorage.setItem(HOME_GROUPS_KEY, JSON.stringify(groups)); } catch (err){ /* storage unavailable */ }
}
function normalizedHomeGroups(rawGroups, projects){
  const validIds = new Set((projects || []).map(project => project.id));
  const claimedIds = new Set();
  const normalized = {};
  if (!rawGroups || typeof rawGroups !== 'object') return normalized;
  for (const [rawId, rawGroup] of Object.entries(rawGroups)){
    if (!rawGroup || typeof rawGroup !== 'object' || !Array.isArray(rawGroup.projectIds)) continue;
    const projectIds = rawGroup.projectIds.map(String).filter((id) => validIds.has(id) && !claimedIds.has(id));
    if (!projectIds.length) continue;
    projectIds.forEach((id) => claimedIds.add(id));
    const id = String(rawId);
    normalized[id] = {
      id,
      name: String(rawGroup.name || 'Untitled group').trim().slice(0, 80) || 'Untitled group',
      projectIds,
      expanded: rawGroup.expanded !== false,
      updatedAt: Number(rawGroup.updatedAt) || Date.now(),
    };
  }
  return normalized;
}
function homeGroupsForProjects(projects){
  return normalizedHomeGroups(readHomeGroups(), projects);
}
function persistNormalizedHomeGroups(groups, projects){
  writeHomeGroups(normalizedHomeGroups(groups, projects));
}
function projectPreviewSvg(project){
  const d = project.doc || {};
  const vw = d.viewportWidth || 24, vh = d.viewportHeight || 24;
  const svg = svgEl('svg', { viewBox:`0 0 ${vw} ${vh}` });
  svg.style.opacity = d.alpha == null ? 1 : d.alpha;

  // Clip to the artboard so shapes parked in the bleed area don't spill across the card —
  // this matters much more now that a background can be painted behind them.
  const clipId = 'dwPreviewClip-' + Math.random().toString(36).slice(2, 9);
  const defs = svgEl('defs');
  const clip = svgEl('clipPath', { id: clipId });
  clip.appendChild(svgEl('rect', { x:0, y:0, width:vw, height:vh }));
  defs.appendChild(clip);
  svg.appendChild(defs);

  const content = svgEl('g', { 'clip-path': `url(#${clipId})` });
  // The background layer is part of how the icon looks, so the preview shows it whenever
  // it's switched on — independent of whether it's set to be included in the XML export.
  if (d.backgroundEnabled){
    content.appendChild(svgEl('rect', {
      x:0, y:0, width:vw, height:vh,
      fill: d.backgroundColor || '#1E222B',
      opacity: d.backgroundOpacity != null ? d.backgroundOpacity : 1,
    }));
    svg.classList.add('has-bg');
  }
  for (const shape of project.shapes || []) if (shape.visible) content.appendChild(buildShapeVisualGroup(shape));
  svg.appendChild(content);
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
    removeGroup:'<path d="M3 6h18M6 6l1 15h10l1-15M9 11h6"/><path d="M9 3h6"/>',
    delete:'<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 10v7M14 10v7"/>'
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[type]}</svg>`;
}
