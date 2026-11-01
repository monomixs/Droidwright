#!/usr/bin/env node
/* =====================================================================================
   make-icon.js  -  turns an SVG into a Windows icon (.ico) with every size Windows asks for.

   USAGE   (from this folder)
       node make-icon.js                      robot.svg  ->  ..\app.ico
       node make-icon.js logo.svg             logo.svg   ->  ..\app.ico
       node make-icon.js logo.svg my.ico      logo.svg   ->  my.ico

   Or just double-click  make-icon.bat  (it installs what it needs the first time).

   WHY SO MANY SIZES?  Windows shows the icon at different sizes depending on where it is and
   on your display scaling (taskbar, Alt+Tab, Explorer, title bar, 125% / 150% / 200% screens).
   If a size is missing, Windows stretches another one and it looks blurry. Each size here is
   drawn straight from the vector, so all of them are sharp.

   SIMPLER ARTWORK FOR THE TINY SIZES   Fine detail turns to mush at 16-32 px. If a file named like the
   input plus "-small" exists next to it (robot.svg -> robot-small.svg), sizes up to 32 are drawn from
   that simplified version instead. No such file = the main SVG is used everywhere.

   FORMAT   Sizes up to 128 are stored as classic 32-bit bitmaps (works everywhere, including
   Visual Studio's resource compiler and .NET's Icon class). 256 is stored as PNG, which is the
   standard way to keep the biggest size small.
   ===================================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

let Resvg;
try { ({ Resvg } = require('@resvg/resvg-js')); }
catch (e) { console.error('The SVG renderer is not installed yet.\nRun this once, in this folder:   npm install'); process.exit(1); }

// The sizes Windows uses at 100% - 400% scaling.
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

const input = path.resolve(process.argv[2] || path.join(__dirname, 'robot.svg'));
const output = path.resolve(process.argv[3] || path.join(__dirname, '..', 'app.ico'));
if (!fs.existsSync(input)) { console.error('Cannot find the SVG: ' + input); process.exit(1); }

const svg = fs.readFileSync(input, 'utf8');

const SMALL_MAX = 32;                                   // sizes up to this use the simplified artwork, if there is any
const smallInput = input.replace(/\.svg$/i, '-small.svg');
const smallSvg = smallInput !== input && fs.existsSync(smallInput) ? fs.readFileSync(smallInput, 'utf8') : null;

function render(size) {
  // fitTo width: the SVG is scaled to exactly `size` pixels wide (square icons stay square).
  const source = smallSvg && size <= SMALL_MAX ? smallSvg : svg;
  const image = new Resvg(source, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render();
  if (image.width !== size || image.height !== size) {
    throw new Error(`The SVG is not square (it rendered ${image.width}x${image.height}). Icons must be square: ` +
                    'give the SVG a square viewBox, e.g. viewBox="0 0 512 512".');
  }
  return image;
}

/** resvg gives premultiplied RGBA; an .ico bitmap wants straight (non-premultiplied) alpha, in BGRA order. */
function toStraightBgra(premultipliedRgba) {
  const out = Buffer.alloc(premultipliedRgba.length);
  for (let i = 0; i < premultipliedRgba.length; i += 4) {
    const a = premultipliedRgba[i + 3];
    const un = (c) => (a === 0 ? 0 : Math.min(255, Math.round((c * 255) / a)));
    out[i] = un(premultipliedRgba[i + 2]);       // B
    out[i + 1] = un(premultipliedRgba[i + 1]);   // G
    out[i + 2] = un(premultipliedRgba[i]);       // R
    out[i + 3] = a;                              // A
  }
  return out;
}

/** The classic icon image: a BITMAPINFOHEADER, the pixels bottom-to-top, then a (blank) 1-bit mask. */
function bitmapImage(size, premultipliedRgba) {
  const bgra = toStraightBgra(premultipliedRgba);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) bgra.copy(pixels, (size - 1 - y) * size * 4, y * size * 4, (y + 1) * size * 4);

  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);          // all zero = "opaque"; the alpha channel does the real work

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);                        // header size
  header.writeInt32LE(size, 4);                       // width
  header.writeInt32LE(size * 2, 8);                   // height (x2: bitmap + mask)
  header.writeUInt16LE(1, 12);                        // planes
  header.writeUInt16LE(32, 14);                       // bits per pixel
  header.writeUInt32LE(pixels.length + mask.length, 20);
  return Buffer.concat([header, pixels, mask]);
}

const images = SIZES.map((size) => {
  const rendered = render(size);
  const data = size >= 256 ? rendered.asPng() : bitmapImage(size, rendered.pixels);
  return { size, data, kind: size >= 256 ? 'PNG' : 'bitmap', simplified: !!smallSvg && size <= SMALL_MAX };
});

// ICONDIR (6 bytes) + one ICONDIRENTRY (16 bytes) per image, then the images themselves.
const directory = Buffer.alloc(6 + 16 * images.length);
directory.writeUInt16LE(0, 0);                        // reserved
directory.writeUInt16LE(1, 2);                        // type: icon
directory.writeUInt16LE(images.length, 4);
let offset = directory.length;
images.forEach((img, i) => {
  const e = 6 + 16 * i;
  directory.writeUInt8(img.size >= 256 ? 0 : img.size, e);       // 0 means 256
  directory.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1);
  directory.writeUInt8(0, e + 2);                                // palette colours
  directory.writeUInt8(0, e + 3);
  directory.writeUInt16LE(1, e + 4);                             // planes
  directory.writeUInt16LE(32, e + 6);                            // bits per pixel
  directory.writeUInt32LE(img.data.length, e + 8);
  directory.writeUInt32LE(offset, e + 12);
  offset += img.data.length;
});

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, Buffer.concat([directory, ...images.map((i) => i.data)]));

console.log('Made ' + output);
console.log('  from ' + input);
for (const img of images) console.log('  ' + String(img.size).padStart(3) + ' x ' + String(img.size).padEnd(3) + '  ' + img.kind.padEnd(6) + '  ' + (img.data.length / 1024).toFixed(1) + ' KB' + (img.simplified ? '  (simplified artwork)' : ''));
console.log('  total ' + (fs.statSync(output).size / 1024).toFixed(1) + ' KB');
