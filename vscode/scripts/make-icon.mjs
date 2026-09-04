// Rasterize media/icon.svg into the 128x128 PNG the marketplace listing needs.
//
// The activity-bar icon is an SVG so it can take the theme's `currentColor`, but a
// marketplace icon is a standalone raster: hence two files, with the SVG staying the
// source and this script the only way the PNG is made. Re-run it after editing the
// SVG (`node scripts/make-icon.mjs` from vscode/).
//
// Pure Node, no deps — the icon is three straight-edged polygons, so a scanline fill
// is the whole renderer. It draws at 4x and box-downsamples, which is where the
// antialiasing comes from.
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SVG = path.join(HERE, "..", "media", "icon.svg");
const PNG = path.join(HERE, "..", "media", "icon.png");

const SIZE = 128;
const SS = 4; // supersampling factor
const BG = [0x1e, 0x1e, 0x22]; // the dark plate the listing shows the icon on
const FG = [0xf0, 0xf2, 0xf5]; // the cube, light on that plate

/** The `d` of every <path>, as a list of polygons in the SVG's 24x24 viewBox.
 *  Only the subset the icon uses: absolute M/L pairs closed with Z. */
function parsePaths(svg) {
  const polygons = [];
  for (const m of svg.matchAll(/\sd="([^"]+)"/g)) {
    const numbers = m[1].match(/-?\d*\.?\d+/g);
    if (!numbers || numbers.length < 6) continue;
    const points = [];
    for (let i = 0; i + 1 < numbers.length; i += 2) {
      points.push([Number(numbers[i]), Number(numbers[i + 1])]);
    }
    polygons.push(points);
  }
  return polygons;
}

/** Even-odd scanline fill of `polygons` (in viewBox units) into an alpha coverage
 *  map, sampled at pixel centers. */
function coverage(polygons, viewBox, dim) {
  const alpha = new Uint8Array(dim * dim);
  const scale = dim / viewBox;
  for (let y = 0; y < dim; y++) {
    const sy = (y + 0.5) / scale;
    for (const points of polygons) {
      // x of every edge crossing this scanline, then fill between pairs.
      const xs = [];
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % points.length];
        if (y1 === y2) continue;
        if (sy >= Math.min(y1, y2) && sy < Math.max(y1, y2)) {
          xs.push(x1 + ((sy - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = Math.max(0, Math.ceil(xs[i] * scale - 0.5));
        const to = Math.min(dim - 1, Math.floor(xs[i + 1] * scale - 0.5));
        for (let x = from; x <= to; x++) alpha[y * dim + x] = 255;
      }
    }
  }
  return alpha;
}

/** Box-downsample the supersampled coverage to SIZE, then composite FG over BG. */
function compose(alpha, big) {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let sum = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          sum += alpha[(y * SS + dy) * big + (x * SS + dx)];
        }
      }
      const a = sum / (SS * SS) / 255;
      const o = (y * SIZE + x) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[o + c] = Math.round(BG[c] * (1 - a) + FG[c] * a);
      }
      rgba[o + 3] = 255; // opaque: the listing has no transparency to blend with
    }
  }
  return rgba;
}

function png(rgba) {
  // Each row is prefixed with filter byte 0 (None), then the lot is deflated.
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const svg = fs.readFileSync(SVG, "utf8");
const viewBox = Number(svg.match(/viewBox="0 0 (\d+)/)?.[1] ?? 24);
const polygons = parsePaths(svg);
if (polygons.length === 0) {
  console.error(`make-icon: no <path d="..."> found in ${path.relative(HERE, SVG)}`);
  process.exit(1);
}
fs.writeFileSync(PNG, png(compose(coverage(polygons, viewBox, SIZE * SS), SIZE * SS)));
console.log(`make-icon: wrote media/icon.png (${SIZE}x${SIZE}) from ${polygons.length} paths`);
