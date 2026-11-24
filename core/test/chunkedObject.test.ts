// Physics P2-P4b: a chunked object (export_chunks.py's .npz) decoded and built at rest — one
// SplatObject per chunk where its body starts — and its physics run moving those chunks, alone or
// with another object in one World (PhysicsRuntime).
// The archive is made in memory from the synthetic blob, with SPV splats per voxel at its centre.
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
import { PhysicsRun, PhysicsRuntime } from "../src/webview/physics/run";
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

/** A chunked blob built in its item group (as AssetLayer holds it), placed at ``x`` metres along
 *  the data frame's x, with its run added to ``runtime``. */
function blobAt(runtime: PhysicsRuntime, x = 0): { run: PhysicsRun; chunks: SplatObject[] } {
  const decoded = decodeChunkedObject(archive());
  const { object, chunks } = buildChunkedObject(decoded);
  const item = new THREE.Group();
  item.add(object);
  item.position.x = x;
  const run = new PhysicsRun(decoded, chunks);
  runtime.add(run);
  return { run, chunks };
}
/** Run the clock at 60 fps until nothing moves (or ``seconds`` pass); whether it came to rest. */
function settle(runtime: PhysicsRuntime, seconds = 30): boolean {
  let now = 0;
  for (let frame = 0; frame < 60 * seconds; frame++) if (!runtime.tick((now += 1000 / 60))) return true;
  return false;
}
const meanY = (chunks: SplatObject[]): number => chunks.reduce((s, c) => s + c.position.y, 0) / chunks.length;

test("its physics: a drop calibrates first, then the chunks fall and the run says when it rests", async (t) => {
  const runtime = new PhysicsRuntime();
  const { run, chunks } = blobAt(runtime);
  const seen: boolean[] = [];
  runtime.onChange = () => seen.push(run.calibrating);
  const before = chunks.map((c) => c.position.y);
  await run.drop(1);
  assert.ok(seen.includes(true) && !run.calibrating && runtime.running && run.progress === 1, seen.join(","));
  assert.ok(chunks.every((c, i) => c.position.y > before[i] + 0.9), "lifted by the drop height");
  assert.ok(settle(runtime), "comes to rest");
  t.diagnostic(run.status);
  assert.match(run.status, /at rest$/);
  // It fell back down: the centroid, lifted 1 m, is near its resting height (it may lie on its side).
  assert.ok(meanY(chunks) < before.reduce((a, b) => a + b, 0) / before.length + 0.3, "it fell");
  runtime.resetAll();
  assert.ok(chunks.every((c, i) => Math.abs(c.position.y - before[i]) < 1e-6), "reset puts it back");
  assert.ok(!runtime.running);
  runtime.dispose();
});

test("two objects share one world: one dropped onto the other is stopped by it", async (t) => {
  /** Seconds the upper blob, dropped 1.5 m, takes to fall 1.2 m: with the other blob below it or not. */
  const fall = async (withBelow: boolean, gravity?: number): Promise<number> => {
    const runtime = new PhysicsRuntime();
    if (gravity !== undefined) runtime.setGravity(gravity);
    if (withBelow) blobAt(runtime);
    const above = blobAt(runtime);
    await above.run.drop(1.5);
    const start = meanY(above.chunks);
    let now = 0, frame = 0;
    for (; frame < 600 && meanY(above.chunks) > start - 1.2; frame++) runtime.tick((now += 1000 / 60));
    runtime.dispose();
    return frame / 60;
  };
  const free = await fall(false), blocked = await fall(true);
  t.diagnostic(`falls 1.2 m in ${free.toFixed(2)} s alone, ${blocked.toFixed(2)} s onto the other`);
  assert.ok(free < 0.6, "alone it falls freely");
  assert.ok(blocked > free + 0.2, "the other one is in the way");
  // At the Moon's gravity (1.62, against 9.81) a free fall takes sqrt(9.81 / 1.62) ~ 2.5x as long.
  const moon = await fall(false, 1.62);
  t.diagnostic(`at the Moon's gravity: ${moon.toFixed(2)} s`);
  assert.ok(Math.abs(moon / free - 2.46) < 0.25);
});

test("an object rests where its item is placed; a reset leaves the others alone", async () => {
  const runtime = new PhysicsRuntime();
  const a = blobAt(runtime, 0), b = blobAt(runtime, 3);
  const restB = b.chunks.map((c) => c.position.clone());
  await a.run.drop(1);
  settle(runtime);
  // Three metres apart they never touch, so b, placed by its item, stays where it was built.
  assert.ok(b.chunks.every((c, i) => c.position.distanceTo(restB[i]) < 0.01), "b stays put");
  const fallenA = a.chunks.map((c) => c.position.clone());
  b.run.reset();
  assert.ok(a.chunks.every((c, i) => c.position.equals(fallenA[i])), "resetting b leaves a as it lies");
  runtime.dispose();
});

test("a shot goes to the object whose chunk it meets first", async () => {
  const runtime = new PhysicsRuntime();
  const near = blobAt(runtime, 0), far = blobAt(runtime, 3);
  await runtime.prepared();
  // Along the data frame's +x from the left, at the blobs' mid-height (data y is down): `near` first.
  const group = near.chunks[0].parent!;
  group.updateWorldMatrix(true, false);
  const ray = new THREE.Ray(new THREE.Vector3(-5, -0.5, 0), new THREE.Vector3(1, 0, 0));
  assert.ok(await near.run.shoot(ray), "it hits");
  settle(runtime);
  assert.match(near.run.status, /pieces/);
  assert.match(far.run.status, /^whole/);
  runtime.dispose();
});
