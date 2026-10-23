// Unit tests for the camera path a "Render video" flies (webview/cameraPath).
// Pure math, no WebGL — these run under plain `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { cameraPose, orderCameras, samplePath } from "../src/webview/cameraPath";
import type { PathPose } from "../src/webview/cameraPath";
import type { CameraView } from "../src/shared/messages";

const IDENTITY = new THREE.Matrix4();

function cam(name: string, center: [number, number, number], fy = 500): CameraView {
  return {
    imageId: 1,
    cameraId: 1,
    name,
    model: "PINHOLE",
    center,
    worldFromCamera: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    fx: fy,
    fy,
    cx: 320,
    cy: 240,
    width: 640,
    height: 480,
  };
}

function pose(x: number, yawDeg = 0, fov = 50): PathPose {
  return {
    position: new THREE.Vector3(x, 0, 0),
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(yawDeg)),
    fov,
  };
}

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

test("orderCameras visits cameras in natural image-name order", () => {
  const names = orderCameras([cam("frame_10.jpg", [0, 0, 0]), cam("frame_2.jpg", [0, 0, 0]), cam("frame_1.jpg", [0, 0, 0])]).map((c) => c.name);
  assert.deepEqual(names, ["frame_1.jpg", "frame_2.jpg", "frame_10.jpg"]);
});

test("cameraPose looks where the COLMAP camera does, image-up as up", () => {
  const p = cameraPose(cam("a", [1, 2, 3]), IDENTITY, 60);
  assert.deepEqual(p.position.toArray(), [1, 2, 3]);
  // COLMAP looks down +z with image +y down; a Three camera looks down its -Z, +Y up.
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(p.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(p.quaternion);
  assert.ok(forward.distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-6, `forward ${forward.toArray()}`);
  assert.ok(up.distanceTo(new THREE.Vector3(0, -1, 0)) < 1e-6, `up ${up.toArray()}`);
  // Vertical FOV from the intrinsics: 2·atan(240 / 500).
  assert.ok(near(p.fov, THREE.MathUtils.radToDeg(2 * Math.atan(240 / 500))), `fov ${p.fov}`);
});

test("cameraPose goes through the layer's world matrix", () => {
  const flip = new THREE.Matrix4().makeRotationX(Math.PI); // the upright toggle
  const p = cameraPose(cam("a", [0, 1, 0]), flip, 60);
  assert.ok(p.position.distanceTo(new THREE.Vector3(0, -1, 0)) < 1e-6);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(p.quaternion);
  assert.ok(forward.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-6, `forward ${forward.toArray()}`);
});

test("cameraPose falls back when the intrinsics give no usable FOV", () => {
  assert.equal(cameraPose(cam("a", [0, 0, 0], 0), IDENTITY, 60).fov, 60);
});

test("samplePath with one frame per camera is exactly the cameras", () => {
  const keys = [pose(0), pose(1, 30), pose(3, 60)];
  const frames = samplePath(keys, 1, false);
  assert.equal(frames.length, 3);
  frames.forEach((f, i) => {
    assert.ok(f.position.distanceTo(keys[i].position) < 1e-9);
    assert.ok(f.quaternion.angleTo(keys[i].quaternion) < 1e-9);
  });
});

test("samplePath interpolates between cameras and ends on the last", () => {
  const keys = [pose(0, 0, 40), pose(1, 90, 60), pose(2, 90, 60)];
  const frames = samplePath(keys, 4, false);
  assert.equal(frames.length, 2 * 4 + 1);
  assert.ok(frames[4].position.distanceTo(keys[1].position) < 1e-9, "segment starts on its camera");
  assert.ok(frames[8].position.distanceTo(keys[2].position) < 1e-9, "path ends on the last camera");
  // Halfway along the first segment: halfway turned and halfway zoomed.
  assert.ok(near(frames[2].quaternion.angleTo(keys[0].quaternion), Math.PI / 4), "slerped orientation");
  assert.ok(near(frames[2].fov, 50), `lerped fov ${frames[2].fov}`);
  assert.ok(frames[2].position.x > 0 && frames[2].position.x < 1, "position between the cameras");
});

test("samplePath with loop closes back toward the first camera", () => {
  const keys = [pose(0), pose(1), pose(2)];
  const frames = samplePath(keys, 2, true);
  assert.equal(frames.length, 3 * 2, "one segment per camera, no duplicate end frame");
  // The last frame is halfway along the closing segment, from camera 2 back to 0.
  assert.ok(frames[5].position.x > 0 && frames[5].position.x < 2, `x ${frames[5].position.x}`);
});

test("samplePath of a single camera is that camera", () => {
  const frames = samplePath([pose(5)], 4, true);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].position.x, 5);
});
