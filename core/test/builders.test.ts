// Unit tests for the scene-math helpers in webview/builders. Pure geometry, no
// WebGL — these run under plain `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import {
  transformBounds,
  unionBounds,
  sphereFromBounds,
  frustumScaleFromDepth,
  buildPlyPoints,
  setPointsSize,
  cloudColor,
  CLOUD_PALETTE,
  DEFAULT_POINT_SIZE,
  NEAR_FRACTION,
} from "../src/webview/builders";
import { computeBounds } from "../src/colmap";
import type { Bounds, CameraView, ModelData } from "../src/shared/messages";

const UNIT: Bounds = { min: [-1, -1, -1], max: [1, 1, 1] };

test("transformBounds leaves bounds alone under the identity", () => {
  const out = transformBounds(UNIT, new THREE.Matrix4());
  assert.deepEqual(out.min, [-1, -1, -1]);
  assert.deepEqual(out.max, [1, 1, 1]);
});

test("transformBounds follows a translation", () => {
  const out = transformBounds(UNIT, new THREE.Matrix4().makeTranslation(10, -2, 0.5));
  assert.deepEqual(out.min, [9, -3, -0.5]);
  assert.deepEqual(out.max, [11, -1, 1.5]);
});

test("transformBounds grows the box when a flat item is rotated", () => {
  // A 2x2 plate lying in XZ, tipped 45° about x: its y extent must open up.
  const plate: Bounds = { min: [-1, 0, -1], max: [1, 0, 1] };
  const out = transformBounds(plate, new THREE.Matrix4().makeRotationX(Math.PI / 4));
  assert.ok(Math.abs(out.max[1] - Math.SQRT1_2) < 1e-6, `max y ${out.max[1]}`);
  assert.ok(Math.abs(out.min[1] + Math.SQRT1_2) < 1e-6, `min y ${out.min[1]}`);
  assert.ok(Math.abs(out.max[0] - 1) < 1e-6, "the rotation axis extent is unchanged");
});

test("unionBounds spans placed items and falls back to a unit box", () => {
  const a = transformBounds(UNIT, new THREE.Matrix4().makeTranslation(5, 0, 0));
  const b = transformBounds(UNIT, new THREE.Matrix4().makeTranslation(-5, 0, 0));
  assert.deepEqual(unionBounds([a, b]).min, [-6, -1, -1]);
  assert.deepEqual(unionBounds([a, b]).max, [6, 1, 1]);
  assert.deepEqual(unionBounds([]).max, [1, 1, 1]);
});

test("sphereFromBounds encloses the box, plus any margin", () => {
  const sphere = sphereFromBounds(UNIT);
  assert.deepEqual(sphere.center.toArray(), [0, 0, 0]);
  // Radius is the half space diagonal, so the box's corners sit on the surface
  // (float-exact comparison would land a rounding step either side of it).
  assert.ok(Math.abs(sphere.radius - Math.sqrt(3)) < 1e-12, `radius ${sphere.radius}`);
  assert.ok(sphere.containsPoint(new THREE.Vector3(1, 1, 0.999)), "interior must be inside");
  assert.equal(sphereFromBounds(UNIT, 2).radius, sphere.radius + 2);
  // Degenerate (single point) bounds still get a usable, non-zero radius.
  assert.ok(sphereFromBounds({ min: [3, 3, 3], max: [3, 3, 3] }).radius > 0);
});

// --- frustumScaleFromDepth -------------------------------------------------
// A camera at the origin looking down +z, image 100x100, fx = fy = 50 (so the
// image spans ±1 unit at unit depth). `worldFromCamera` is the identity: camera
// axes and world axes coincide.
function cameraAtOrigin(center: [number, number, number] = [0, 0, 0]): CameraView {
  return {
    imageId: 1, cameraId: 1, name: "cam.png", model: "PINHOLE",
    center, worldFromCamera: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    fx: 50, fy: 50, cx: 50, cy: 50, width: 100, height: 100,
  };
}

function modelOf(points: number[][], cameras: CameraView[]): ModelData {
  const positions = Float32Array.from(points.flat());
  return {
    count: points.length,
    positions,
    colors: new Uint8Array(points.length * 3),
    cameras,
    bounds: computeBounds(positions),
  };
}

test("frustumScaleFromDepth sizes off what the camera sees, not the scene extent", () => {
  // A wall of points 4 units ahead, plus one far outlier that blows the scene
  // diagonal up to ~1000 — the value must follow the wall, not the outlier.
  const wall = Array.from({ length: 40 }, (_, i) => [(i - 20) / 40, 0, 4]);
  const data = modelOf([...wall, [0, 0, 1000]], [cameraAtOrigin()]);
  const scale = frustumScaleFromDepth(data);
  // The wall is 4 units out, so the scale is that depth, scaled down to taste.
  assert.ok(Math.abs(scale - NEAR_FRACTION * 4) < 1e-6, `got ${scale}`);
});

test("frustumScaleFromDepth ignores points behind the camera or outside the image", () => {
  // Nearer than the wall, but neither is imaged: one is behind, one is far off
  // to the side (x = 10 at z = 2 projects to u = 300, past the 100px width).
  const wall = Array.from({ length: 40 }, (_, i) => [(i - 20) / 40, 0, 8]);
  const data = modelOf([...wall, [0, 0, -1], [10, 0, 2]], [cameraAtOrigin()]);
  assert.ok(Math.abs(frustumScaleFromDepth(data) - NEAR_FRACTION * 8) < 1e-6);
});

test("frustumScaleFromDepth follows the tightest camera", () => {
  // Same wall at z = 8, seen by a second camera standing at z = 6 — 2 units out.
  const wall = Array.from({ length: 40 }, (_, i) => [(i - 20) / 40, 0, 8]);
  const data = modelOf(wall, [cameraAtOrigin(), cameraAtOrigin([0, 0, 6])]);
  assert.ok(Math.abs(frustumScaleFromDepth(data) - NEAR_FRACTION * 2) < 1e-6);
});

test("frustumScaleFromDepth reports 0 when there is nothing to measure", () => {
  // 0, not a guess: the caller owns what to fall back to (one slider step).
  assert.equal(frustumScaleFromDepth(modelOf([], [cameraAtOrigin()])), 0, "no cloud");
  assert.equal(frustumScaleFromDepth(modelOf([[0, 0, 4]], [])), 0, "no cameras");
  // Cameras that see nothing: the cloud sits behind this one.
  assert.equal(frustumScaleFromDepth(modelOf([[0, 0, -4]], [cameraAtOrigin()])), 0, "out of view");
});


/** A 3-point cloud geometry, optionally carrying its own per-vertex colors. */
function cloudGeometry(withColor: boolean): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 4, 0]);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (withColor) {
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(9).fill(0.5), 3));
  }
  return geometry;
}

test("cloudColor cycles the palette, giving neighbours different colors", () => {
  assert.equal(cloudColor(0), CLOUD_PALETTE[0]);
  assert.notEqual(cloudColor(0), cloudColor(1));
  // Wraps rather than running off the end, so item N always gets a color.
  assert.equal(cloudColor(CLOUD_PALETTE.length), CLOUD_PALETTE[0]);
  assert.equal(cloudColor(CLOUD_PALETTE.length + 3), CLOUD_PALETTE[3]);
});

test("buildPlyPoints keeps a cloud's own colors when it has them", () => {
  const material = buildPlyPoints(cloudGeometry(true), 0xff0000).material as THREE.PointsMaterial;
  assert.equal(material.vertexColors, true);
  // White base, so the per-vertex colors come through unmodulated.
  assert.equal(material.color.getHex(), 0xffffff);
  assert.equal(material.size, DEFAULT_POINT_SIZE);
});

test("buildPlyPoints gives an uncolored cloud the fallback color", () => {
  const material = buildPlyPoints(cloudGeometry(false), 0xa78bfa).material as THREE.PointsMaterial;
  assert.equal(material.vertexColors, false);
  assert.equal(material.color.getHex(), 0xa78bfa);
});

test("setPointsSize resizes point clouds and leaves other objects alone", () => {
  const group = new THREE.Group();
  const points = buildPlyPoints(cloudGeometry(false), 0x38bdf8);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  group.add(points, mesh);

  setPointsSize(group, 4);
  assert.equal((points.material as THREE.PointsMaterial).size, 4);
  assert.equal((mesh.material as THREE.MeshBasicMaterial & { size?: number }).size, undefined);
});
