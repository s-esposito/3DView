// Unit tests for the NumPy reader and the 3D-track builder. Pure data + geometry,
// so they run under plain `node --test` (DecompressionStream is a Node global too).
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import * as THREE from "three";
import type { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";

import { readNpy, readNpz, type NpyArray } from "../src/webview/npz";
import {
  decodeTracks,
  buildTrackLines,
  DEFAULT_TRACK_WIDTH,
  setTrackTrail,
  setTrackOpacity,
  setTrackWidth,
  smoothTracks,
  trackSteps,
} from "../src/webview/tracks";

// --- fixture builders (mirroring what numpy writes) -------------------------

/** A .npy buffer: v1 header padded to a 64-byte boundary, then C-order data. */
function npy(dtype: string, shape: number[], data: ArrayBufferView): Uint8Array {
  const dict = `{'descr': '${dtype}', 'fortran_order': False, 'shape': (${shape
    .map((d) => `${d},`)
    .join(" ")}), }`;
  const unpadded = 10 + dict.length + 1;
  const header = dict.padEnd(dict.length + ((64 - (unpadded % 64)) % 64), " ") + "\n";
  const out = new Uint8Array(10 + header.length + data.byteLength);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]); // \x93NUMPY v1.0
  new DataView(out.buffer).setUint16(8, header.length, true);
  for (let i = 0; i < header.length; i++) {
    out[10 + i] = header.charCodeAt(i);
  }
  out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 10 + header.length);
  return out;
}

/** A ZIP holding the given members, stored or raw-deflated like np.savez[_compressed]. */
function zip(members: Array<{ name: string; data: Uint8Array }>, compress = false): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const { name, data } of members) {
    const body = compress ? new Uint8Array(deflateRawSync(data)) : data;
    const method = compress ? 8 : 0;
    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, body.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    for (let i = 0; i < name.length; i++) {
      local[30 + i] = name.charCodeAt(i);
    }
    local.set(body, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    for (let i = 0; i < name.length; i++) {
      central[46 + i] = name.charCodeAt(i);
    }
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, members.length, true);
  ev.setUint16(10, members.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, eocd];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Two tracks over three steps: one moving along +x, one along +y. */
const XYZ = new Float32Array([
  0, 0, 0, 0, 0, 0, // step 0: track A at origin, track B at origin
  1, 0, 0, 0, 1, 0, // step 1
  2, 0, 0, 0, 2, 0, // step 2
]);
const VIS = new Uint8Array([1, 1, 1, 1, 1, 1]);

// --- npy / npz --------------------------------------------------------------

test("readNpy parses a float32 array's dtype, shape and values", () => {
  const array = readNpy(npy("<f4", [3, 2, 3], XYZ));
  assert.equal(array.dtype, "f4");
  assert.deepEqual(array.shape, [3, 2, 3]);
  assert.deepEqual([...(array.data as Float32Array)], [...XYZ]);
});

test("readNpy handles bool, int64 and 0-d arrays", () => {
  const bools = readNpy(npy("|b1", [3, 2], VIS));
  assert.equal(bools.dtype, "b1");
  assert.deepEqual([...(bools.data as Uint8Array)], [...VIS]);

  const ints = readNpy(npy("<i8", [2], new BigInt64Array([7n, 9n])));
  assert.deepEqual([...(ints.data as BigInt64Array)], [7n, 9n]);

  const scalar = readNpy(npy("<i8", [], new BigInt64Array([294n])));
  assert.deepEqual(scalar.shape, []);
  assert.equal((scalar.data as BigInt64Array)[0], 294n);
});

test("readNpy rejects what it cannot read, with a readable reason", () => {
  assert.throws(() => readNpy(new Uint8Array([1, 2, 3])), /bad magic/);

  // Flip the header's fortran_order in place (same length, so nothing else moves).
  const fortran = npy("<f4", [2], new Float32Array([1, 2]));
  const header = String.fromCharCode(...fortran.subarray(10, 128));
  const at = 10 + header.indexOf("'fortran_order': False");
  [..."'fortran_order': True "].forEach((c, i) => (fortran[at + i] = c.charCodeAt(0)));
  assert.throws(() => readNpy(fortran), /Fortran-order/);
  assert.throws(() => readNpy(npy(">f4", [1], new Float32Array([1]))), /Big-endian/);
});

test("readNpz reads stored and deflated members alike", async () => {
  const members = [
    { name: "obj_1_xyz.npy", data: npy("<f4", [3, 2, 3], XYZ) },
    { name: "obj_1_vis.npy", data: npy("|b1", [3, 2], VIS) },
  ];
  for (const compressed of [false, true]) {
    const arrays = await readNpz(zip(members, compressed));
    assert.deepEqual([...arrays.keys()].sort(), ["obj_1_vis", "obj_1_xyz"]);
    assert.deepEqual(arrays.get("obj_1_xyz")!.shape, [3, 2, 3]);
    assert.deepEqual([...(arrays.get("obj_1_xyz")!.data as Float32Array)], [...XYZ]);
  }
});

// --- track decoding ---------------------------------------------------------

function arrays(entries: Record<string, NpyArray>): Map<string, NpyArray> {
  return new Map(Object.entries(entries));
}

const f4 = (shape: number[], data: Float32Array): NpyArray => ({ dtype: "f4", shape, data });
const b1 = (shape: number[], data: Uint8Array): NpyArray => ({ dtype: "b1", shape, data });

test("decodeTracks pairs an xyz array with its visibility mask", () => {
  const set = decodeTracks(
    arrays({
      frames: { dtype: "i8", shape: [3], data: new BigInt64Array([0n, 1n, 2n]) },
      obj_1_uv: f4([3, 2, 2], new Float32Array(12)), // 2D tracks: not 3D, ignored
      obj_1_xyz: f4([3, 2, 3], XYZ),
      obj_1_vis: b1([3, 2], VIS),
    })
  );
  assert.equal(set.steps, 3);
  assert.equal(set.count, 2);
  assert.deepEqual(set.groups, [{ name: "obj_1_xyz", start: 0, count: 2 }]);
  assert.deepEqual(set.bounds.max, [2, 2, 0]);
});

test("decodeTracks concatenates several object groups", () => {
  const set = decodeTracks(
    arrays({
      obj_1_xyz: f4([3, 2, 3], XYZ),
      obj_1_vis: b1([3, 2], VIS),
      obj_2_xyz: f4([3, 2, 3], XYZ.map((v) => v + 10) as Float32Array),
      obj_2_vis: b1([3, 2], VIS),
    })
  );
  assert.equal(set.count, 4);
  assert.deepEqual(
    set.groups.map((g) => [g.name, g.start, g.count]),
    [
      ["obj_1_xyz", 0, 2],
      ["obj_2_xyz", 2, 2],
    ]
  );
  // Group 2 sits at tracks 2..3 of every step: step 0 starts at (10, 10, 10).
  assert.deepEqual([...set.positions.slice(6, 9)], [10, 10, 10]);
});

test("decodeTracks explains itself when there are no 3D tracks", () => {
  assert.throws(() => decodeTracks(arrays({ uv: f4([3, 2, 2], new Float32Array(12)) })), /steps, tracks, 3/);
});

// --- geometry ---------------------------------------------------------------

/** Segments a built track object draws — a fat line is instanced, one per segment. */
const segments = (lines: LineSegments2) => lines.geometry.attributes.instanceStart.count;

/** One track over five steps along +x, with a sideways spike at step 2. */
function spikeSet(vis = new Uint8Array(5).fill(1)) {
  const xyz = new Float32Array(5 * 3);
  for (let s = 0; s < 5; s++) {
    xyz[s * 3] = s;
  }
  xyz[2 * 3 + 1] = 10;
  return decodeTracks(arrays({ xyz: f4([5, 1, 3], xyz), vis: b1([5, 1], vis) }));
}

test("buildTrackLines draws one segment per consecutive visible pair", () => {
  const set = decodeTracks(arrays({ xyz: f4([3, 2, 3], XYZ), vis: b1([3, 2], VIS) }));
  const lines = buildTrackLines(set);
  // 2 steps of motion x 2 tracks = 4 segments.
  assert.equal(segments(lines), 4);
  assert.equal(trackSteps(lines), 3);
  assert.ok(lines.geometry.boundingSphere != null, "bounding sphere is preset");
});

test("buildTrackLines breaks the trail where a point is hidden or non-finite", () => {
  const hidden = new Uint8Array([1, 1, 0, 1, 1, 1]); // track A invisible at step 1
  const set = decodeTracks(arrays({ xyz: f4([3, 2, 3], XYZ), vis: b1([3, 2], hidden) }));
  // Track A loses both of its segments (steps 0-1 and 1-2); track B keeps two.
  assert.equal(segments(buildTrackLines(set)), 2);

  const nan = Float32Array.from(XYZ);
  nan[3] = Number.NaN; // track B, step 0
  const withNan = decodeTracks(arrays({ xyz: f4([3, 2, 3], nan), vis: b1([3, 2], VIS) }));
  assert.equal(segments(buildTrackLines(withNan)), 3);
});

test("density thins to a stable, nested subset of the tracks", () => {
  // 400 tracks over 2 steps, all visible: one segment each at full density.
  const count = 400;
  const xyz = new Float32Array(2 * count * 3);
  for (let s = 0; s < 2; s++) {
    for (let i = 0; i < count; i++) {
      xyz[(s * count + i) * 3] = i + s; // every track moves, so every one has a segment
    }
  }
  const set = decodeTracks(
    arrays({ xyz: f4([2, count, 3], xyz), vis: b1([2, count], new Uint8Array(2 * count).fill(1)) })
  );
  const segmentsAt = (density: number) => segments(buildTrackLines(set, density));

  assert.equal(segmentsAt(1), count);
  const half = segmentsAt(0.5);
  assert.ok(Math.abs(half - count / 2) < count * 0.1, `expected ~200 tracks, drew ${half}`);
  assert.equal(segmentsAt(0.5), half, "the same density must draw the same subset");

  // Nested: every track kept at 0.25 is still kept at 0.5 (raising density only adds).
  const drawnX = (density: number) => {
    const start = buildTrackLines(set, density).geometry.attributes.instanceStart;
    return new Set(Array.from({ length: start.count }, (_, k) => start.getX(k)));
  };
  const quarter = drawnX(0.25);
  const halfSet = drawnX(0.5);
  for (const x of quarter) {
    assert.ok(halfSet.has(x), `track at x=${x} disappeared when density rose`);
  }
});

test("setTrackOpacity fades the lines and only then pays for transparency", () => {
  const set = decodeTracks(arrays({ xyz: f4([3, 2, 3], XYZ), vis: b1([3, 2], VIS) }));
  const lines = buildTrackLines(set);
  const material = lines.material;

  setTrackOpacity(lines, 0.4);
  assert.equal(material.opacity, 0.4);
  assert.equal(material.transparent, true);
  assert.equal(material.depthWrite, false);
  assert.equal(material.alphaToCoverage, false, "blending and coverage must not stack");

  setTrackOpacity(lines, 1);
  assert.equal(material.transparent, false, "opaque lines must not take the blended path");
  assert.equal(material.depthWrite, true);
  assert.equal(material.alphaToCoverage, true, "opaque fat lines keep their smooth edge");

  setTrackOpacity(new THREE.Mesh(new THREE.BufferGeometry()), 0.5); // no-op, no throw
});

test("setTrackTrail reveals the trajectory up to a step, and clamps", () => {
  const set = decodeTracks(arrays({ xyz: f4([3, 2, 3], XYZ), vis: b1([3, 2], VIS) }));
  const lines = buildTrackLines(set);

  setTrackTrail(lines, 1); // one step in: nothing has moved yet
  assert.equal(lines.geometry.instanceCount, 0);
  setTrackTrail(lines, 2); // one step of motion for both tracks
  assert.equal(lines.geometry.instanceCount, 2);
  setTrackTrail(lines, 3);
  assert.equal(lines.geometry.instanceCount, 4);
  setTrackTrail(lines, 99); // beyond the end: the whole trail, not an empty draw
  assert.equal(lines.geometry.instanceCount, 4);

  // Non-track objects are left alone.
  const mesh = new THREE.Mesh(new THREE.BufferGeometry());
  setTrackTrail(mesh, 2);
  assert.equal(mesh.geometry.drawRange.count, Infinity);
  assert.equal(trackSteps(mesh), 0);
});

test("setTrackWidth thickens the trails without rebuilding them", () => {
  const set = decodeTracks(arrays({ xyz: f4([3, 2, 3], XYZ), vis: b1([3, 2], VIS) }));
  const lines = buildTrackLines(set);
  const geometry = lines.geometry;

  assert.equal(lines.material.linewidth, DEFAULT_TRACK_WIDTH, "built at the default width");
  setTrackWidth(lines, 4.5);
  assert.equal(lines.material.linewidth, 4.5);
  assert.equal(lines.geometry, geometry, "width is a uniform — the geometry is untouched");
  // Screen pixels, not world units: a trail keeps its thickness at any zoom.
  assert.equal(lines.material.worldUnits, false);

  setTrackWidth(new THREE.Mesh(new THREE.BufferGeometry()), 3); // no-op, no throw
});

test("smoothTracks averages along time over the visible samples only", () => {
  const set = spikeSet();
  const steps = set.steps;

  assert.equal(smoothTracks(set, 0), set.positions, "sigma 0 is off — the same buffer");
  const smoothed = smoothTracks(set, 1);
  assert.notEqual(smoothed, set.positions, "smoothing never writes in place");
  assert.ok(smoothed[2 * 3 + 1] < 10 && smoothed[2 * 3 + 1] > 0, "the spike is pulled in");
  assert.ok(smoothed[1 * 3 + 1] > 0, "and it drags its neighbours a little");
  // A convex combination of the inputs, so the set's bounds still hold.
  for (let s = 0; s < steps; s++) {
    assert.ok(smoothed[s * 3 + 1] <= 10 && smoothed[s * 3 + 1] >= 0);
  }
});

test("smoothing ignores hidden samples and never changes what is drawn", () => {
  const vis = new Uint8Array(5).fill(1);
  vis[2] = 0; // the spike lands on a step the tracker had lost
  const set = spikeSet(vis);

  const smoothed = smoothTracks(set, 1);
  assert.equal(smoothed[1 * 3 + 1], 0, "an occluded sample must not drag its neighbours");
  assert.equal(smoothed[2 * 3 + 1], 10, "the hidden sample itself is passed through");
  // The hidden step still breaks the trail in exactly the same place.
  assert.equal(segments(buildTrackLines(set, 1, 1)), segments(buildTrackLines(set, 1, 0)));
});
