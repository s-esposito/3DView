// Rasterize the 3DView cube into the PNG icons the installable web app needs: the
// manifest's 192/512 px icons (plus a "maskable" one, whose art sits inside the
// central safe zone Android crops launcher icons to) and iOS's 180 px
// apple-touch-icon. Re-run after changing the art (`node scripts/make-icons.mjs` from
// demo/); the PNGs under icons/ are committed, as Pages serves demo/ as-is.
//
// The cube is vscode/media/icon.svg's — three straight-edged polygons — on the demo
// favicon's blue plate. Pure Node like vscode/scripts/make-icon.mjs: a scanline fill
// at 4x, box-downsampled for the antialiasing, written with node:zlib.
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SVG = path.join(HERE, "..", "..", "vscode", "media", "icon.svg");
const OUT = path.join(HERE, "..", "icons");

const SS = 4; // supersampling factor
const BG = [0x0e, 0x63, 0x9c]; // the favicon's plate
const FG = [0xff, 0xff, 0xff];

// name, edge in px, and the share of the edge the cube spans (maskable: inside the
// 80% safe circle, with margin).
const ICONS = [
  ["icon-192.png", 192, 0.72],
  ["icon-512.png", 512, 0.72],
  ["icon-maskable-512.png", 512, 0.56],
  ["apple-touch-icon.png", 180, 0.68],
];

/** Every <path d> of the SVG as a polygon (absolute M/L pairs closed with Z). */
function parsePaths(svg) {
  const polygons = [];
  for (const m of svg.matchAll(/\sd="([^"]+)"/g)) {
    const n = m[1].match(/-?\d*\.?\d+/g).map(Number);
    const points = [];
    for (let i = 0; i + 1 < n.length; i += 2) points.push([n[i], n[i + 1]]);
    polygons.push(points);
  }
  return polygons;
}

/** Even-odd scanline coverage of `polygons` (already in pixel units) at dim×dim. */
function coverage(polygons, dim) {
  const alpha = new Uint8Array(dim * dim);
  for (let y = 0; y < dim; y++) {
    const sy = y + 0.5;
    for (const points of polygons) {
      const xs = [];
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % points.length];
        if (y1 !== y2 && sy >= Math.min(y1, y2) && sy < Math.max(y1, y2)) {
          xs.push(x1 + ((sy - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = Math.max(0, Math.ceil(xs[i] - 0.5));
        const to = Math.min(dim - 1, Math.floor(xs[i + 1] - 0.5));
        for (let x = from; x <= to; x++) alpha[y * dim + x] = 255;
      }
    }
  }
  return alpha;
}

function render(polygons, size, span) {
  const big = size * SS;
  // Fit the art's bounding box to `span` of the edge, centered.
  const all = polygons.flat();
  const [minX, maxX] = [Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0]))];
  const [minY, maxY] = [Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[1]))];
  const scale = (span * big) / Math.max(maxX - minX, maxY - minY);
  const ox = big / 2 - ((minX + maxX) / 2) * scale;
  const oy = big / 2 - ((minY + maxY) / 2) * scale;
  const placed = polygons.map((poly) => poly.map(([x, y]) => [x * scale + ox, y * scale + oy]));
  const alpha = coverage(placed, big);

  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) sum += alpha[(y * SS + dy) * big + (x * SS + dx)];
      }
      const a = sum / (SS * SS) / 255;
      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(BG[c] * (1 - a) + FG[c] * a);
      rgba[o + 3] = 255; // opaque: launchers apply their own shape
    }
  }
  return rgba;
}

function png(rgba, size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride); // each row: filter byte 0 (None) + pixels
  for (let y = 0; y < size; y++) rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
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
const polygons = parsePaths(svg);
fs.mkdirSync(OUT, { recursive: true });
for (const [name, size, span] of ICONS) {
  fs.writeFileSync(path.join(OUT, name), png(render(polygons, size, span), size));
  console.log(`make-icons: wrote icons/${name} (${size}x${size})`);
}
