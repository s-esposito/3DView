// R1: any asset's collision shape — geometry voxelized, strays dropped, the inside filled, merged
// into boxes under a budget (physics/voxelize.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collisionShape, dropStrays, fillInside, mergeGrid, voxelizePoints, voxelizeTriangles,
} from "../src/webview/physics/voxelize";
import { mergeBoxes } from "../src/webview/physics/voxelScene";
import type { V3 } from "../src/webview/physics/sim";

/** A unit cube's 12 triangles, centred on the origin. */
function cube(): { positions: Float32Array; index: Uint32Array } {
  const p: number[] = [];
  for (let i = 0; i < 8; i++) p.push(i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0.5 : -0.5);
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const index = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  return { positions: new Float32Array(p), index: new Uint32Array(index) };
}

/** Points on a sphere of radius ``r`` (a Fibonacci lattice), xyz flat. */
function spherePoints(r: number, n: number): Float32Array {
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n, s = Math.sqrt(1 - y * y), t = i * Math.PI * (3 - Math.sqrt(5));
    out.set([r * s * Math.cos(t), r * y, r * s * Math.sin(t)], 3 * i);
  }
  return out;
}
const count = (occ: Uint8Array) => occ.reduce((s, v) => s + v, 0);

test("a cube's surface fills to a solid that merges into one box of the cube's size", () => {
  const { positions, index } = cube();
  const shape = collisionShape(1, (v) => voxelizeTriangles(positions, index, v), { across: 16 });
  assert.equal(shape.boxes.length, 1);
  const [cx, cy, cz, hx, hy, hz] = shape.boxes[0];
  assert.ok(Math.abs(cx) < 0.05 && Math.abs(cy) < 0.05 && Math.abs(cz) < 0.05, `centre ${[cx, cy, cz]}`);
  for (const h of [hx, hy, hz]) assert.ok(Math.abs(h - 0.5) <= shape.voxel, `half extent ${h}`);
});

test("an open surface (a cube without its top) fills nothing", () => {
  const { positions, index } = cube();
  const open = index.filter((_, k) => Math.floor(k / 6) !== 3); // drop the +y face's two triangles
  const g = voxelizeTriangles(positions, open, 1 / 16);
  assert.equal(fillInside(g), 0);
});

test("a stray clump of points is dropped, the object kept", () => {
  const sphere = spherePoints(1, 20000);
  const stray = new Float32Array([5, 5, 5, 5.01, 5, 5, 5, 5.01, 5]);
  const g = voxelizePoints(Float32Array.from([...sphere, ...stray]), 0.1);
  const before = count(g.occ);
  dropStrays(g);
  assert.equal(before - count(g.occ), 1, "the stray voxel went");
});

test("the box budget coarsens the voxel until it holds", () => {
  const pts = spherePoints(1, 50000);
  const fine = collisionShape(2, (v) => voxelizePoints(pts, v), { across: 64, fill: false, maxBoxes: 1e9 });
  const capped = collisionShape(2, (v) => voxelizePoints(pts, v), { across: 64, fill: false, maxBoxes: 300 });
  assert.ok(fine.boxes.length > 300 && capped.boxes.length <= 300, `${fine.boxes.length} -> ${capped.boxes.length}`);
  assert.ok(capped.voxel > fine.voxel);
  assert.ok(Math.hypot(...capped.centre) < 0.05, "a sphere's centre of mass is its centre");
});

test("the grid merge covers exactly the occupied voxels, as the old voxel-list merge did", () => {
  const voxels: V3[] = [];
  for (let x = -6; x <= 6; x++) for (let y = -6; y <= 6; y++) for (let z = -6; z <= 6; z++) {
    if (Math.hypot(x, y, z) <= 6 && (x + 2 * y + 3 * z) % 7 !== 0) voxels.push([x, y, z]);
  }
  const boxes = mergeBoxes(voxels);
  const covered = new Set<string>();
  for (const [lo, hi] of boxes) for (let x = lo[0]; x < hi[0]; x++) for (let y = lo[1]; y < hi[1]; y++) for (let z = lo[2]; z < hi[2]; z++) {
    const k = `${x},${y},${z}`;
    assert.ok(!covered.has(k), "no overlap");
    covered.add(k);
  }
  assert.equal(covered.size, voxels.length);
  assert.ok(voxels.every((v) => covered.has(v.join(","))));
  // Same as merging the grid directly.
  const g = voxelizePoints(new Float32Array(voxels.flat().map((c) => c + 0.5)), 1);
  assert.equal(mergeGrid(g).length, boxes.length);
});
