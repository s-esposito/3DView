// Physics P2: a chunked object (export_chunks.py's .npz) decoded and built at rest — one
// SplatObject per chunk where its body starts. The archive is made in memory from the synthetic
// blob, with SPV splats per voxel at its centre.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import type { NpyArray } from "../src/webview/npz";
import { SplatObject } from "../src/webview/splats";
import {
  SPLAT_FLOATS,
  buildChunkedObject,
  decodeChunkedObject,
  isChunkedObject,
} from "../src/webview/physics/chunkedObject";
import { presetScene } from "../src/webview/physics/voxelScene";

const SPV = 2;

/** The blob as export_chunks.py would write it, turned by ``rotation`` (the grid's rest pose). */
function archive(rotation?: [number, number, number, number]): Map<string, NpyArray> {
  const scene = presetScene({ shape: "blob", radius: 6, chunks: 12, height: 1 });
  scene.rotation = rotation;
  const rows: number[] = [];
  scene.chunks.forEach((c) => {
    c.splats = [rows.length / SPLAT_FLOATS, SPV * c.voxels.length];
    for (const v of c.voxels)
      for (let k = 0; k < SPV; k++) rows.push(...v, 0.01, 0.01, 0.01, 0, 0, 0, 1, 0.9, 0.5, 0.4, 0.3);
  });
  const json = new TextEncoder().encode(JSON.stringify(scene));
  return new Map<string, NpyArray>([
    ["physics_scene", { dtype: "u1", shape: [json.length], data: json }],
    ["physics_splats", { dtype: "f4", shape: [rows.length / SPLAT_FLOATS, SPLAT_FLOATS], data: new Float32Array(rows) }],
  ]);
}

test("a chunked object is told apart from point tracks by its keys", () => {
  assert.ok(isChunkedObject(archive()));
  const tracks = new Map<string, NpyArray>([["tracks", { dtype: "f4", shape: [2, 1, 3], data: new Float32Array(6) }]]);
  assert.ok(!isChunkedObject(tracks));
});

test("decoding keeps the scene and each chunk's splat rows", () => {
  const { scene, ranges, splats } = decodeChunkedObject(archive());
  assert.equal(ranges.length, scene.chunks.length);
  const total = ranges.reduce((n, [, count]) => n + count, 0);
  assert.equal(total, splats.length / SPLAT_FLOATS);
});

test("a splat range outside the rows is refused", () => {
  const arrays = archive();
  const scene = JSON.parse(new TextDecoder().decode(arrays.get("physics_scene")!.data as Uint8Array));
  scene.chunks[0].splats = [0, 10 ** 9];
  const json = new TextEncoder().encode(JSON.stringify(scene));
  arrays.set("physics_scene", { dtype: "u1", shape: [json.length], data: json });
  assert.throws(() => decodeChunkedObject(arrays), /outside/);
});

test("at rest: one SplatObject per chunk, at its body's rest pose, under the y-up -> data-frame turn", () => {
  const rotation: [number, number, number, number] = [0, Math.sin(0.3), 0, Math.cos(0.3)];
  const decoded = decodeChunkedObject(archive(rotation));
  const { object, chunks, bounds } = buildChunkedObject(decoded);
  assert.equal(object.rotation.x, Math.PI);
  assert.equal(chunks.length, decoded.scene.chunks.length);
  chunks.forEach((chunk, i) => {
    assert.ok(chunk instanceof SplatObject);
    assert.equal(chunk.parent, object);
    assert.equal(chunk.data.count, decoded.ranges[i][1]);
    assert.deepEqual(chunk.position.toArray(), decoded.scene.chunks[i].position);
    assert.ok(chunk.quaternion.equals(new THREE.Quaternion(...rotation)));
  });
  // The splats sit at the voxel centres, so the bounds are the voxels' centres in the data frame:
  // the blob stands on y = 0 and is 1 m tall, so after the turn y runs from about -1 to 0.
  assert.ok(bounds.max[1] <= 0 && bounds.min[1] > -1.01, JSON.stringify(bounds));
});
