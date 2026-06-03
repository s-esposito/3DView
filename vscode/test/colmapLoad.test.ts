// Unit test for the VS Code host's COLMAP filesystem discovery/load
// (colmapLoad.ts). Runs under plain `node --test`; it writes a tiny binary model
// to a temp dir and round-trips detectFormat / findModelDirs / loadModel. The
// pure parser tests live in @3dviewer/core (core/test/colmap.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { detectFormat, findModelDirs, loadModel } from "../src/host/colmapLoad";

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
