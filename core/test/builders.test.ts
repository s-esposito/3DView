// Unit tests for the scene-math helpers in webview/builders. Pure geometry, no
// WebGL — these run under plain `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { transformBounds, unionBounds, sphereFromBounds } from "../src/webview/builders";
import type { Bounds } from "../src/shared/messages";

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
