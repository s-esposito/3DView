// Unit tests for the pure COLMAP layer. No VS Code needed — these run under
// plain `node --test` (the bundle is produced by `node esbuild.js --test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  parseCamerasBin,
  parseCamerasText,
  parseImagesBin,
  parseImagesText,
  parsePoints3DBin,
  parsePoints3DText,
  quaternionToRotation,
  imageToPose,
  detectFormat,
  findModelDirs,
  loadModel,
  intrinsicsFromParams,
} from "../src/colmap/index";

// --- little-endian byte writer, mirrors the COLMAP binary layout ------------
class ByteWriter {
  private bufs: Buffer[] = [];
  u8(v: number) { this.bufs.push(Buffer.from([v])); return this; }
  i32(v: number) { const b = Buffer.alloc(4); b.writeInt32LE(v); this.bufs.push(b); return this; }
  u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.bufs.push(b); return this; }
  u64(v: number) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.bufs.push(b); return this; }
  f64(v: number) { const b = Buffer.alloc(8); b.writeDoubleLE(v); this.bufs.push(b); return this; }
  cstr(s: string) { this.bufs.push(Buffer.from(s, "ascii"), Buffer.from([0])); return this; }
  bytes(): Uint8Array { return new Uint8Array(Buffer.concat(this.bufs)); }
}

// --- cameras ----------------------------------------------------------------
test("parseCamerasBin reads a PINHOLE camera", () => {
  // 1 camera: id 1, model 1 (PINHOLE, 4 params), 640x480, [fx,fy,cx,cy].
  const buf = new ByteWriter()
    .u64(1)
    .u32(1).i32(1).u64(640).u64(480)
    .f64(500).f64(510).f64(320).f64(240)
    .bytes();
  const cams = parseCamerasBin(buf);
  assert.equal(cams.size, 1);
  const c = cams.get(1)!;
  assert.equal(c.model, 1);
  assert.equal(c.width, 640);
  assert.equal(c.height, 480);
  assert.deepEqual([c.fx, c.fy, c.cx, c.cy], [500, 510, 320, 240]);
});

test("parseCamerasText matches binary and resolves single-focal intrinsics", () => {
  const text = [
    "# Camera list",
    "1 SIMPLE_PINHOLE 640 480 500 320 240",
    "2 PINHOLE 800 600 700 710 400 300",
  ].join("\n");
  const cams = parseCamerasText(text);
  assert.equal(cams.size, 2);
  const simple = cams.get(1)!;
  // SIMPLE_PINHOLE: fx == fy == params[0].
  assert.deepEqual([simple.fx, simple.fy, simple.cx, simple.cy], [500, 500, 320, 240]);
  const pinhole = cams.get(2)!;
  assert.deepEqual([pinhole.fx, pinhole.fy, pinhole.cx, pinhole.cy], [700, 710, 400, 300]);
});

test("intrinsicsFromParams distinguishes single vs dual focal models", () => {
  assert.deepEqual(intrinsicsFromParams(0, [500, 320, 240]), { fx: 500, fy: 500, cx: 320, cy: 240 });
  assert.deepEqual(intrinsicsFromParams(4, [500, 510, 320, 240, 0, 0, 0, 0]), { fx: 500, fy: 510, cx: 320, cy: 240 });
});

// --- images -----------------------------------------------------------------
test("parseImagesBin reads pose and skips 2D observations", () => {
  const buf = new ByteWriter()
    .u64(1)
    .u32(7) // image_id
    .f64(1).f64(0).f64(0).f64(0) // qvec (identity)
    .f64(1).f64(2).f64(3) // tvec
    .u32(2) // camera_id
    .cstr("frame_001.png")
    .u64(2) // num_points2D
    .f64(10).f64(20).u64(100) // obs 1 (skipped)
    .f64(30).f64(40).u64(0) // obs 2 (skipped)
    .bytes();
  const imgs = parseImagesBin(buf);
  assert.equal(imgs.length, 1);
  const im = imgs[0];
  assert.equal(im.imageId, 7);
  assert.equal(im.cameraId, 2);
  assert.equal(im.name, "frame_001.png");
  assert.deepEqual(im.qvec, [1, 0, 0, 0]);
  assert.deepEqual(im.tvec, [1, 2, 3]);
});

test("parseImagesText skips the observations line and keeps names with spaces", () => {
  const text = [
    "# Image list",
    "7 1 0 0 0 1 2 3 2 my frame.png",
    "10 20 100 30 40 -1", // observations, ignored
  ].join("\n");
  const imgs = parseImagesText(text);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].name, "my frame.png");
  assert.deepEqual(imgs[0].tvec, [1, 2, 3]);
});

// --- points3D ---------------------------------------------------------------
test("parsePoints3DBin reads xyz/rgb and skips tracks", () => {
  const buf = new ByteWriter()
    .u64(2)
    // point 1
    .u64(1000).f64(1.5).f64(-2.5).f64(3.5).u8(255).u8(128).u8(0).f64(0.4)
    .u64(1).u32(7).u32(3) // track len 1
    // point 2
    .u64(1001).f64(0).f64(0).f64(0).u8(10).u8(20).u8(30).f64(0.1)
    .u64(0) // track len 0
    .bytes();
  const pc = parsePoints3DBin(buf);
  assert.equal(pc.count, 2);
  assert.ok(Math.abs(pc.positions[0] - 1.5) < 1e-6);
  assert.ok(Math.abs(pc.positions[1] + 2.5) < 1e-6);
  assert.deepEqual(Array.from(pc.colors.slice(0, 3)), [255, 128, 0]);
  assert.deepEqual(Array.from(pc.colors.slice(3, 6)), [10, 20, 30]);
});

test("parsePoints3DText parses xyz/rgb columns", () => {
  const text = [
    "# 3D point list",
    "1000 1.5 -2.5 3.5 255 128 0 0.4 7 3",
    "1001 0 0 0 10 20 30 0.1",
  ].join("\n");
  const pc = parsePoints3DText(text);
  assert.equal(pc.count, 2);
  assert.deepEqual(Array.from(pc.colors.slice(0, 3)), [255, 128, 0]);
});

// --- pose math --------------------------------------------------------------
test("quaternionToRotation identity is the identity matrix", () => {
  const R = quaternionToRotation([1, 0, 0, 0]);
  assert.deepEqual(R, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test("imageToPose computes camera center -R^T t", () => {
  // Identity rotation => center = -t.
  const p = imageToPose({ imageId: 1, qvec: [1, 0, 0, 0], tvec: [1, 2, 3], cameraId: 1, name: "a" });
  assert.deepEqual(p.center, [-1, -2, -3]);
  assert.deepEqual(p.worldFromCamera, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test("imageToPose worldFromCamera is orthonormal for a 90-degree z rotation", () => {
  const s = Math.SQRT1_2; // sin/cos of 45deg
  const p = imageToPose({ imageId: 1, qvec: [s, 0, 0, s], tvec: [0, 0, 0], cameraId: 1, name: "a" });
  const m = p.worldFromCamera;
  // Columns are unit length and mutually orthogonal.
  const col = (i: number) => [m[i], m[i + 3], m[i + 6]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(dot(col(i), col(i)) - 1) < 1e-9);
  }
  assert.ok(Math.abs(dot(col(0), col(1))) < 1e-9);
});

// --- locate + load (filesystem orchestration) -------------------------------
test("detectFormat / findModelDirs / loadModel round-trip a binary model", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "colmap-test-"));
  try {
    const modelDir = path.join(root, "sparse", "0");
    fs.mkdirSync(modelDir, { recursive: true });

    fs.writeFileSync(path.join(modelDir, "cameras.bin"), new ByteWriter()
      .u64(1).u32(1).i32(1).u64(640).u64(480).f64(500).f64(500).f64(320).f64(240).bytes());
    fs.writeFileSync(path.join(modelDir, "images.bin"), new ByteWriter()
      .u64(1).u32(1).f64(1).f64(0).f64(0).f64(0).f64(0).f64(0).f64(0).u32(1).cstr("a.png").u64(0).bytes());
    fs.writeFileSync(path.join(modelDir, "points3D.bin"), new ByteWriter()
      .u64(1).u64(1).f64(0).f64(0).f64(0).u8(1).u8(2).u8(3).f64(0).u64(0).bytes());

    assert.equal(detectFormat(modelDir), "bin");
    const dirs = findModelDirs(root);
    assert.deepEqual(dirs, [modelDir]);

    const model = loadModel(modelDir);
    assert.equal(model.cameras.size, 1);
    assert.equal(model.images.length, 1);
    assert.equal(model.points.count, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
