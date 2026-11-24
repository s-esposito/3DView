// Synthetic voxel objects cut into chunks (a blob, a tower, a wall), as a PhysicsScene: the
// physics' test objects, and the chunking an asset without voxels would go through. Pure (no
// DOM, no physics). Ported from GenerativeReconstruction's prototype
// (scripts/visualization/physics_demo/app/voxel_scene.js).
import type { Box, PhysicsScene, V3 } from "./sim";

export type Shape = "blob" | "tower" | "wall";

/** A seeded uniform [0, 1) generator (mulberry32), so a seed gives one chunk pattern. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer voxel coords of a preset shape, standing on y = 0. */
export function shapeVoxels(shape: Shape, n: number): V3[] {
  const out: V3[] = [];
  if (shape === "blob") { // a ball of radius n cut flat near its bottom, a bump on top
    const c = Math.round(0.6 * n); // the cut leaves a base of radius 0.8 n to stand on
    for (let x = -n; x <= n; x++)
      for (let y = 0; y <= c + 1.5 * n; y++)
        for (let z = -n; z <= n; z++) {
          const ball = x * x + (y - c) ** 2 + z * z <= n * n;
          const bump = x * x + (y - c - n) ** 2 + z * z <= (0.5 * n) ** 2;
          if (ball || bump) out.push([x, y, z]);
        }
  } else if (shape === "tower") { // a square pillar 4n tall, 0.6n wide
    const w = Math.max(1, Math.round(0.3 * n));
    for (let x = -w; x <= w; x++)
      for (let y = 0; y < 4 * n; y++)
        for (let z = -w; z <= w; z++) out.push([x, y, z]);
  } else { // a wall 3n wide, 2n tall, 2 voxels thick
    const w = Math.round(1.5 * n);
    for (let x = -w; x < w; x++)
      for (let y = 0; y < 2 * n; y++)
        for (let z = 0; z < 2; z++) out.push([x, y, z]);
  }
  return out;
}

/** Each voxel's chunk: K seeds by farthest-point sampling, each voxel to its nearest seed. */
export function chunkLabels(voxels: V3[], k: number, seed: number): Int32Array {
  const n = voxels.length;
  k = Math.min(k, n);
  const rand = rng(seed);
  const d2 = (i: number, s: number): number => {
    const a = voxels[i], b = voxels[s];
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  };
  const seeds = [Math.floor(rand() * n)];
  const nearest = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const label = new Int32Array(n);
  for (;;) {
    const s = seeds[seeds.length - 1];
    for (let i = 0; i < n; i++) {
      const d = d2(i, s);
      if (d < nearest[i]) { nearest[i] = d; label[i] = seeds.length - 1; }
    }
    if (seeds.length === k) break;
    let far = 0;
    for (let i = 1; i < n; i++) if (nearest[i] > nearest[far]) far = i;
    seeds.push(far);
  }
  return label;
}

/** The scene of ``voxels`` (integer coords) cut by ``labels``, voxel side ``size`` metres. */
export function buildScene(voxels: V3[], labels: Int32Array, size: number): PhysicsScene {
  const k = Math.max(...labels) + 1;
  const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
  voxels.forEach((v, i) => {
    const s = sums[labels[i]];
    s[0] += v[0]; s[1] += v[1]; s[2] += v[2]; s[3] += 1;
  });
  // Voxel (x, y, z) spans [x, x+1) * size, so its centre is (x + 0.5) * size.
  const centre = sums.map(([x, y, z, c]): V3 =>
    [(x / c + 0.5) * size, (y / c + 0.5) * size, (z / c + 0.5) * size]);
  const members: V3[][] = Array.from({ length: k }, () => []);
  voxels.forEach((v, i) => members[labels[i]].push(v));
  const chunks = centre.map((p, c) => ({
    position: p,
    voxels: members[c].map((v): V3 =>
      [(v[0] + 0.5) * size - p[0], (v[1] + 0.5) * size - p[1], (v[2] + 0.5) * size - p[2]]),
    boxes: mergeBoxes(members[c]).map(([lo, hi]): Box => [
      0.5 * (lo[0] + hi[0]) * size - p[0], 0.5 * (lo[1] + hi[1]) * size - p[1], 0.5 * (lo[2] + hi[2]) * size - p[2],
      0.5 * (hi[0] - lo[0]) * size, 0.5 * (hi[1] - lo[1]) * size, 0.5 * (hi[2] - lo[2]) * size]),
    color: hsl((c * 0.61803) % 1, 0.55, 0.6),
  }));
  // A weld per pair of chunks that share faces: each +x/+y/+z neighbour in another chunk is one face.
  const index = new Map(voxels.map((v, i) => [v.join(","), i]));
  const pairs = new Map<number, { a: number; b: number; sum: V3; faces: number }>();
  voxels.forEach((v, i) => {
    for (const axis of [0, 1, 2]) {
      const w = v.slice() as V3;
      w[axis] += 1;
      const j = index.get(w.join(","));
      if (j === undefined || labels[j] === labels[i]) continue;
      const a = Math.min(labels[i], labels[j]), b = Math.max(labels[i], labels[j]);
      const face: V3 = [(v[0] + 0.5) * size, (v[1] + 0.5) * size, (v[2] + 0.5) * size];
      face[axis] += 0.5 * size;
      const p = pairs.get(a * k + b) ?? { a, b, sum: [0, 0, 0], faces: 0 };
      p.sum[0] += face[0]; p.sum[1] += face[1]; p.sum[2] += face[2]; p.faces += 1;
      pairs.set(a * k + b, p);
    }
  });
  const welds = [...pairs.values()].map(({ a, b, sum, faces }) => ({
    a, b, anchor: sum.map((s) => s / faces) as V3, area: faces * size * size,
  }));
  return { voxelSize: size, chunks, welds };
}

/** Voxels (integer coords) merged into boxes ``[lo, hi)`` that cover exactly them, greedily:
 *  each unclaimed voxel grows along x, then y, then z while the whole face is unclaimed voxels. */
export function mergeBoxes(voxels: V3[]): [V3, V3][] {
  const free = new Set(voxels.map((v) => v.join(",")));
  const has = (x: number, y: number, z: number): boolean => free.has(`${x},${y},${z}`);
  const sorted = [...voxels].sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
  const boxes: [V3, V3][] = [];
  for (const [x0, y0, z0] of sorted) {
    if (!has(x0, y0, z0)) continue;
    let x1 = x0 + 1, y1 = y0 + 1, z1 = z0 + 1;
    while (has(x1, y0, z0)) x1++;
    const rowFree = (y: number, z: number): boolean => {
      for (let x = x0; x < x1; x++) if (!has(x, y, z)) return false;
      return true;
    };
    while (rowFree(y1, z0)) y1++;
    const slabFree = (z: number): boolean => {
      for (let y = y0; y < y1; y++) if (!rowFree(y, z)) return false;
      return true;
    };
    while (slabFree(z1)) z1++;
    for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) free.delete(`${x},${y},${z}`);
    boxes.push([[x0, y0, z0], [x1, y1, z1]]);
  }
  return boxes;
}

function hsl(h: number, s: number, l: number): V3 {
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** A preset object: ``shape`` of ``radius`` voxels, ``chunks`` chunks, ``height`` metres tall. */
export function presetScene({ shape = "blob" as Shape, radius = 10, chunks = 100, height = 1, seed = 1 } = {}): PhysicsScene {
  const voxels = shapeVoxels(shape, radius);
  const ys = voxels.map((v) => v[1]);
  const size = height / (Math.max(...ys) - Math.min(...ys) + 1);
  return buildScene(voxels, chunkLabels(voxels, chunks, seed), size);
}
