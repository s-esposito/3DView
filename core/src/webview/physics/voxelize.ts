// Any asset's collision shape (roadmap R1): its geometry — a mesh's triangles, a cloud's points,
// a 3DGS asset's splat centres — voxelized at a voxel size, stray clumps dropped, the inside
// filled where the surface closes, and the voxels merged into boxes (the shape model the chunked
// objects use, so a rigid asset is a PhysicsScene of one chunk). No DOM: node tests run it.
// R0 measured the costs these defaults come from (TODO.md): 32 voxels across a dynamic object is
// 140-400 boxes filled, ~1 ms a step; static boxes are nearly free.
import type { Box, V3 } from "./sim";

/** An occupancy grid: ``size`` voxels per axis of side ``voxel``, voxel (x, y, z) at
 *  ``origin + voxel * (x, y, z)``, occupied where ``occ[x + nx * (y + ny * z)]`` is 1. */
export interface Grid {
  origin: V3;
  voxel: number;
  size: V3;
  occ: Uint8Array;
}

/** Defaults: a dynamic object is 32 voxels across and filled; a static one keeps its surface. */
export const SHAPE_DEFAULTS = {
  dynamic: { across: 32, fill: true, maxBoxes: 1500 },
  static: { across: 64, fill: false, maxBoxes: 10000 },
};

/** Voxels holding fewer than this share of the occupied voxels, as a connected clump, are dropped
 *  (a stray splat or a far-off noise point must not become an invisible wall). */
const MIN_CLUMP = 0.01;

/** The empty grid covering ``points`` (xyz, flat) at ``voxel``, with a margin of 1.5 voxels: a
 *  free layer all round (fillInside floods from it), and the bounding box's faces mid-voxel, so an
 *  axis-aligned face does not round to either side of a voxel boundary. */
function gridAround(points: ArrayLike<number>, voxel: number): Grid {
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], points[i + a]);
      hi[a] = Math.max(hi[a], points[i + a]);
    }
  }
  const origin = lo.map((v) => v - 1.5 * voxel) as V3;
  const size = hi.map((v, a) => Math.floor((v - origin[a]) / voxel) + 2) as V3;
  return { origin, voxel, size, occ: new Uint8Array(size[0] * size[1] * size[2]) };
}

const cell = (g: Grid, x: number, y: number, z: number): number =>
  Math.floor((x - g.origin[0]) / g.voxel) + g.size[0] * (Math.floor((y - g.origin[1]) / g.voxel)
    + g.size[1] * Math.floor((z - g.origin[2]) / g.voxel));

/** Points (xyz, flat; splat centres or a cloud) as voxels: a voxel is occupied when at least
 *  ``minCount`` points fall in it. */
export function voxelizePoints(points: ArrayLike<number>, voxel: number, minCount = 1): Grid {
  const g = gridAround(points, voxel);
  const counts = new Uint16Array(g.occ.length);
  for (let i = 0; i < points.length; i += 3) {
    const c = cell(g, points[i], points[i + 1], points[i + 2]);
    if (counts[c] < 65535) counts[c]++;
  }
  for (let c = 0; c < counts.length; c++) g.occ[c] = counts[c] >= minCount ? 1 : 0;
  return g;
}

/** A mesh's surface as voxels: every triangle (``positions`` xyz flat, ``index`` three a triangle,
 *  or none: consecutive) sampled on a barycentric lattice finer than half a voxel. */
export function voxelizeTriangles(positions: ArrayLike<number>, index: ArrayLike<number> | null, voxel: number): Grid {
  const g = gridAround(positions, voxel);
  const n = index ? index.length : positions.length / 3;
  const at = (k: number) => 3 * (index ? index[k] : k);
  for (let t = 0; t < n; t += 3) {
    const a = at(t), b = at(t + 1), c = at(t + 2);
    const edge = Math.max(
      Math.hypot(positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]),
      Math.hypot(positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]),
      Math.hypot(positions[c] - positions[b], positions[c + 1] - positions[b + 1], positions[c + 2] - positions[b + 2]));
    const steps = Math.max(1, Math.ceil((2 * edge) / voxel));
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps - i; j++) {
        const u = i / steps, v = j / steps, w = 1 - u - v;
        g.occ[cell(g,
          w * positions[a] + u * positions[b] + v * positions[c],
          w * positions[a + 1] + u * positions[b + 1] + v * positions[c + 1],
          w * positions[a + 2] + u * positions[b + 2] + v * positions[c + 2])] = 1;
      }
    }
  }
  return g;
}

/** Drop every connected clump (26 neighbours) holding under ``minShare`` of the occupied voxels. */
export function dropStrays(g: Grid, minShare = MIN_CLUMP): void {
  const [nx, ny, nz] = g.size;
  const label = new Int32Array(g.occ.length).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < g.occ.length; start++) {
    if (!g.occ[start] || label[start] >= 0) continue;
    const id = sizes.length;
    let count = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const c = stack.pop()!;
      count++;
      const x = c % nx, y = Math.floor(c / nx) % ny, z = Math.floor(c / (nx * ny));
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
        const d = X + nx * (Y + ny * Z);
        if (g.occ[d] && label[d] < 0) {
          label[d] = id;
          stack.push(d);
        }
      }
    }
    sizes.push(count);
  }
  const total = sizes.reduce((s, n) => s + n, 0);
  for (let c = 0; c < g.occ.length; c++) if (g.occ[c] && sizes[label[c]] < minShare * total) g.occ[c] = 0;
}

/** Fill what the surface encloses: every empty voxel the outside (the grid's margin) cannot reach
 *  through empty face neighbours. A surface open at voxel scale fills nothing. Returns how many. */
export function fillInside(g: Grid): number {
  const [nx, ny, nz] = g.size;
  const outside = new Uint8Array(g.occ.length);
  const stack: number[] = [];
  const visit = (c: number) => {
    if (!g.occ[c] && !outside[c]) {
      outside[c] = 1;
      stack.push(c);
    }
  };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) visit(x + nx * (y + ny * z));
  }
  while (stack.length) {
    const c = stack.pop()!;
    const x = c % nx, y = Math.floor(c / nx) % ny, z = Math.floor(c / (nx * ny));
    if (x > 0) visit(c - 1);
    if (x < nx - 1) visit(c + 1);
    if (y > 0) visit(c - nx);
    if (y < ny - 1) visit(c + nx);
    if (z > 0) visit(c - nx * ny);
    if (z < nz - 1) visit(c + nx * ny);
  }
  let filled = 0;
  for (let c = 0; c < g.occ.length; c++) {
    if (!g.occ[c] && !outside[c]) {
      g.occ[c] = 1;
      filled++;
    }
  }
  return filled;
}

/** The occupied voxels merged into boxes ``[lo, hi)`` (voxel coordinates) that cover exactly
 *  them, greedily: each unclaimed voxel, in z, y, x order, grows along x, then y, then z while the
 *  whole face is unclaimed. On the flat grid, so 100k+ voxels take milliseconds. */
export function mergeGrid(g: Grid): [V3, V3][] {
  const [nx, ny, nz] = g.size;
  const free = g.occ.slice();
  const has = (x: number, y: number, z: number) => x < nx && y < ny && z < nz && free[x + nx * (y + ny * z)] === 1;
  const boxes: [V3, V3][] = [];
  for (let z0 = 0; z0 < nz; z0++) for (let y0 = 0; y0 < ny; y0++) for (let x0 = 0; x0 < nx; x0++) {
    if (!has(x0, y0, z0)) continue;
    let x1 = x0 + 1, y1 = y0 + 1, z1 = z0 + 1;
    while (has(x1, y0, z0)) x1++;
    const rowFree = (y: number, z: number) => {
      for (let x = x0; x < x1; x++) if (!has(x, y, z)) return false;
      return true;
    };
    while (rowFree(y1, z0)) y1++;
    const slabFree = (z: number) => {
      for (let y = y0; y < y1; y++) if (!rowFree(y, z)) return false;
      return true;
    };
    while (slabFree(z1)) z1++;
    for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) free.fill(0, x0 + nx * (y + ny * z), x1 + nx * (y + ny * z));
    boxes.push([[x0, y0, z0], [x1, y1, z1]]);
  }
  return boxes;
}

/** A collision shape: boxes (centre, half extents) in the geometry's own frame, their centre of
 *  mass (boxes weighed by volume), and the voxel size it settled on. */
export interface Shape {
  boxes: Box[];
  centre: V3;
  voxel: number;
}

/**
 * The collision shape of some geometry: voxelized ``across`` voxels over its longest side (or at
 * ``voxel``), stray clumps dropped, filled (``fill``), merged into boxes — coarsened by 1.25x
 * until there are at most ``maxBoxes``. ``voxelize`` turns a voxel size into a grid (the caller's
 * choice of points or triangles).
 */
export function collisionShape(
  extent: number,
  voxelize: (voxel: number) => Grid,
  { across = SHAPE_DEFAULTS.dynamic.across, voxel, fill = true, maxBoxes = SHAPE_DEFAULTS.dynamic.maxBoxes }:
    { across?: number; voxel?: number; fill?: boolean; maxBoxes?: number } = {}
): Shape {
  for (let size = voxel ?? extent / across; ; size *= 1.25) {
    const g = voxelize(size);
    dropStrays(g);
    if (fill) fillInside(g);
    const merged = mergeGrid(g);
    if (merged.length > maxBoxes) continue;
    let mass = 0;
    const centre: V3 = [0, 0, 0];
    const boxes = merged.map(([lo, hi]) => {
      const c = lo.map((l, a) => g.origin[a] + ((l + hi[a]) / 2) * size) as V3;
      const half = lo.map((l, a) => ((hi[a] - l) / 2) * size) as V3;
      const m = half[0] * half[1] * half[2];
      mass += m;
      for (let a = 0; a < 3; a++) centre[a] += m * c[a];
      return [...c, ...half] as Box;
    });
    return { boxes, centre: centre.map((c) => c / mass) as V3, voxel: size };
  }
}
