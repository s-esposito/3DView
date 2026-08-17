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
  assert.ok(Math.abs(scale - 0.6) < 1e-6, `expected 0.15 * 4, got ${scale}`);
});

test("frustumScaleFromDepth ignores points behind the camera or outside the image", () => {
  // Nearer than the wall, but neither is imaged: one is behind, one is far off
  // to the side (x = 10 at z = 2 projects to u = 300, past the 100px width).
  const wall = Array.from({ length: 40 }, (_, i) => [(i - 20) / 40, 0, 8]);
  const data = modelOf([...wall, [0, 0, -1], [10, 0, 2]], [cameraAtOrigin()]);
  assert.ok(Math.abs(frustumScaleFromDepth(data) - 1.2) < 1e-6); // 0.15 * 8
});

test("frustumScaleFromDepth follows the tightest camera", () => {
  // Same wall at z = 8, seen by a second camera standing at z = 6 — 2 units out.
  const wall = Array.from({ length: 40 }, (_, i) => [(i - 20) / 40, 0, 8]);
  const data = modelOf(wall, [cameraAtOrigin(), cameraAtOrigin([0, 0, 6])]);
  assert.ok(Math.abs(frustumScaleFromDepth(data) - 0.3) < 1e-6); // 0.15 * 2
});

test("frustumScaleFromDepth reports 0 when there is nothing to measure", () => {
  // 0, not a guess: the caller owns what to fall back to (one slider step).
  assert.equal(frustumScaleFromDepth(modelOf([], [cameraAtOrigin()])), 0, "no cloud");
  assert.equal(frustumScaleFromDepth(modelOf([[0, 0, 4]], [])), 0, "no cameras");
  // Cameras that see nothing: the cloud sits behind this one.
  assert.equal(frustumScaleFromDepth(modelOf([[0, 0, -4]], [cameraAtOrigin()])), 0, "out of view");
});
