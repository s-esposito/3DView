// Unit tests for the 3DGS render modes. Everything under test is CPU-side geometry
// (instance transforms, culling, budget), so it runs under plain `node --test` with
// no WebGL context. Decoding itself is Spark's job and needs a real file + WASM
// worker, so it is not covered here.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import {
  buildSplatObject,
  buildSplatMeshFrom,
  swapSplatCloud,
  MAX_ELLIPSOIDS,
  SplatCloud,
} from "../src/webview/splats";
import { disposeObject } from "../src/webview/builders";

/** A synthetic cloud: splat i sits at (i, 2i, -i), rotated 90° about z, orange. */
function makeCloud(
  count: number,
  opacityAt: (i: number) => number,
  scaleAt: (i: number) => number
): SplatCloud {
  const centers = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  const scales = new Float32Array(count * 3);
  const quats = new Float32Array(count * 4);
  const opacities = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    centers.set([i, 2 * i, -i], i * 3);
    colors.set([255, 128, 0], i * 3);
    scales.set([scaleAt(i), scaleAt(i) * 2, scaleAt(i) * 3], i * 3);
    quats.set([0, 0, Math.SQRT1_2, Math.SQRT1_2], i * 4);
    opacities[i] = opacityAt(i);
  }
  return {
    count,
    // Spark's packed buffer: not read by the modes below, but part of a cloud.
    packed: new Uint32Array(count * 4),
    packedCount: count,
    centers,
    colors,
    scales,
    quats,
    opacities,
    bounds: { min: [0, 0, -(count - 1)], max: [count - 1, 2 * (count - 1), 0] },
  };
}

/** A cloud whose packed buffer is filled with `fill`, so a swap is visible. Sized in
 *  whole splat-texture rows (2048): PackedSplats rounds its capacity down to a
 *  multiple of that, and a shorter buffer would hold zero splats. */
function packedCloud(rows: number, fill: number): SplatCloud {
  const count = rows * 2048;
  const cloud = makeCloud(1, () => 1, () => 0.1);
  cloud.packed = new Uint32Array(count * 4).fill(fill);
  cloud.packedCount = count;
  return cloud;
}

test("points mode draws every splat center", () => {
  const points = buildSplatObject(makeCloud(10, () => 1, () => 0.1), "points") as THREE.Points;
  assert.equal(points.isPoints, true);
  assert.equal(points.geometry.getAttribute("position").count, 10);
});

test("ellipsoid mode instances one oriented ellipsoid per splat", () => {
  const mesh = buildSplatObject(
    makeCloud(10, () => 1, () => 0.1),
    "ellipsoids"
  ) as THREE.InstancedMesh;
  assert.equal(mesh.isInstancedMesh, true);
  assert.equal(mesh.count, 10);

  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(3, matrix);
  matrix.decompose(position, quaternion, scale);
  assert.deepEqual(position.toArray(), [3, 6, -3]);
  // Radii are the per-axis σ at ELLIPSOID_SIGMA (2): 0.1/0.2/0.3 → 0.2/0.4/0.6.
  assert.ok(
    Math.abs(scale.x - 0.2) < 1e-6 && Math.abs(scale.y - 0.4) < 1e-6 && Math.abs(scale.z - 0.6) < 1e-6,
    `unexpected instance scale ${scale.toArray().join(",")}`
  );
  assert.ok(Math.abs(quaternion.z - Math.SQRT1_2) < 1e-6, "instance rotation not preserved");

  const color = new THREE.Color();
  mesh.getColorAt(3, color);
  assert.ok(Math.abs(color.r - 1) < 1e-6 && Math.abs(color.g - 128 / 255) < 1e-6 && color.b === 0);

  // Preset (not lazily rescanned per instance) and large enough to not cull the cloud.
  assert.ok(mesh.boundingSphere != null);
  assert.ok(
    mesh.boundingSphere.center.distanceTo(new THREE.Vector3(9, 18, 0)) <= mesh.boundingSphere.radius
  );
});

test("ellipsoid mode drops near-transparent splats", () => {
  const cloud = makeCloud(100, (i) => (i % 2 === 0 ? 0.9 : 0.01), () => 0.1);
  const mesh = buildSplatObject(cloud, "ellipsoids") as THREE.InstancedMesh;
  assert.equal(mesh.count, 50);
});

test("ellipsoid mode caps the count, keeping the most significant splats", () => {
  // Over budget, all opaque, with size growing by index — the largest must survive.
  const over = 100_000;
  const cloud = makeCloud(MAX_ELLIPSOIDS + over, () => 1, (i) => 1e-4 + i * 1e-9);
  const mesh = buildSplatObject(cloud, "ellipsoids") as THREE.InstancedMesh;
  assert.equal(mesh.count, MAX_ELLIPSOIDS);
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(0, matrix);
  // Centers encode the source index in x, so the first kept splat is the cutoff one:
  // everything below it (the smallest `over` splats) must have been dropped.
  assert.ok(
    new THREE.Vector3().setFromMatrixPosition(matrix).x >= over * 0.99,
    "budget kept low-significance splats"
  );
  // Tessellation drops with the count: detail 0 is 20 triangles, and the geometry
  // is welded down to the icosahedron's 12 shared vertices (60 unwelded) — the per-
  // instance vertex work is what this multiplies by 400k.
  assert.equal(mesh.geometry.getIndex()?.count, 60, "geometry should be indexed");
  assert.equal(mesh.geometry.getAttribute("position").count, 12);
  assert.equal(mesh.geometry.getAttribute("uv"), undefined, "UVs are unused ballast");
});

test("disposeObject frees an ellipsoid mesh's per-instance buffers", () => {
  const mesh = buildSplatObject(
    makeCloud(4, () => 1, () => 0.1),
    "ellipsoids"
  ) as THREE.InstancedMesh;
  let disposed = 0;
  mesh.addEventListener("dispose", () => disposed++);
  disposeObject(mesh);
  assert.equal(disposed, 1);
});

// --- swapping a sequence's frame under one mesh -----------------------------

test("swapping a frame writes into the mesh's buffer, not the frame's", () => {
  const a = packedCloud(1, 111);
  const b = packedCloud(1, 222);
  // What AssetLayer hands the mesh: a buffer of its own, seeded with frame A.
  const buffer = a.packed.slice();
  const mesh = buildSplatMeshFrom(buffer, a.packedCount);

  assert.equal(swapSplatCloud(mesh, b), true);
  assert.equal(buffer[0], 222, "the mesh now renders frame B");
  assert.equal(a.packed[0], 111, "frame A's decoded data is untouched");
  assert.equal(b.packed[0], 222, "and so is frame B's");
  // Writing into the same array is what makes the upload happen: repointing the
  // buffer sends the RGBA32UI texture a byte view, which WebGL2 rejects.
  const packed = (mesh as { packedSplats?: { packedArray?: Uint32Array; needsUpdate?: boolean } })
    .packedSplats;
  assert.equal(packed?.packedArray, buffer, "still the mesh's own array");
  assert.equal(packed?.needsUpdate, true, "flagged for re-upload");
});

test("a swap is accepted when the buffer holds a partial texture row", () => {
  // Spark clamps its splat count down to whole rows, so a capacity that isn't a
  // multiple of 2048 makes numSplats differ from the frame's own count. Frames still
  // match each other, and refusing them here would quietly disable the fast path.
  const a = packedCloud(1, 1);
  const b = packedCloud(1, 2);
  for (const cloud of [a, b]) {
    cloud.packed = new Uint32Array(3000 * 4).fill(cloud.packed[0]);
    cloud.packedCount = 3000;
  }
  const mesh = buildSplatMeshFrom(a.packed.slice(), a.packedCount);
  assert.equal(swapSplatCloud(mesh, b), true);
});

test("a swap is refused unless the frame fits the mesh exactly", () => {
  const mesh = buildSplatMeshFrom(packedCloud(1, 1).packed, 2048);
  assert.equal(swapSplatCloud(mesh, packedCloud(2, 9)), false, "different splat count");
  assert.equal(swapSplatCloud(new THREE.Group(), packedCloud(1, 9)), false, "not a splat mesh");
  assert.equal(swapSplatCloud(undefined, packedCloud(1, 9)), false, "nothing to swap");
});
