// A chunked object as a viewer asset: what GenerativeReconstruction's export_chunks.py writes as
// one .npz — arrays `physics_scene` (the PhysicsScene, UTF-8 JSON; each chunk's `splats` =
// [start, count] rows) and `physics_splats` (float32 rows of 14: centre (3) in the chunk's body
// frame, scales (3), rotation (4, x y z w), opacity (1), colour (3, 0..1)). Those two keys tell
// it apart from point tracks, as a .ply's header tells a splat cloud from a mesh.
//
// At rest it is one SplatObject per chunk, placed where its body starts, so the physics (P3)
// only has to move them.
import * as THREE from "three";
import { PackedSplats } from "@sparkjsdev/spark";
import type { Bounds } from "../../shared/messages";
import { computeBounds } from "../../colmap/bounds";
import type { NpyArray } from "../npz";
import { SplatObject } from "../splats";
import type { PhysicsScene } from "./sim";

/** Floats per splat row in `physics_splats`. */
export const SPLAT_FLOATS = 14;

/** A decoded chunked object: its scene, each chunk's splat rows, and the splats. */
export interface ChunkedObject {
  scene: PhysicsScene;
  /** Each chunk's [start, count] rows of `splats`. */
  ranges: [number, number][];
  splats: Float32Array;
}

/** Whether a NumPy archive holds a chunked object (rather than point tracks). */
export function isChunkedObject(arrays: Map<string, NpyArray>): boolean {
  return arrays.has("physics_scene") && arrays.has("physics_splats");
}

export function decodeChunkedObject(arrays: Map<string, NpyArray>): ChunkedObject {
  const sceneArray = arrays.get("physics_scene"), splatArray = arrays.get("physics_splats");
  if (!sceneArray || !(sceneArray.data instanceof Uint8Array)) {
    throw new Error("physics_scene must be the scene's JSON as uint8");
  }
  if (!splatArray || !(splatArray.data instanceof Float32Array) || splatArray.shape[1] !== SPLAT_FLOATS) {
    throw new Error(`physics_splats must be float32 (N, ${SPLAT_FLOATS})`);
  }
  const scene = JSON.parse(new TextDecoder().decode(sceneArray.data)) as PhysicsScene;
  const rows = splatArray.shape[0];
  const ranges = scene.chunks.map((c, i) => {
    const range = c.splats;
    if (!range || !(range[0] >= 0 && range[1] >= 0 && range[0] + range[1] <= rows)) {
      throw new Error(`chunk ${i}: splat rows ${range} missing or outside the ${rows} rows`);
    }
    return range;
  });
  return { scene, ranges, splats: splatArray.data };
}

/**
 * The object at rest: one SplatObject per chunk at its rest position and the scene's rotation,
 * under a group turned 180° about x. The physics runs y-up (gravity -y); the viewer's data frame
 * is COLMAP's (y down), which its root's Upright flip turns back, so the group's turn makes the
 * object stand upright like everything else in the scene. Bounds are in that data frame.
 */
export function buildChunkedObject({ scene, ranges, splats }: ChunkedObject):
  { object: THREE.Group; chunks: SplatObject[]; bounds: Bounds } {
  const group = new THREE.Group();
  group.rotation.x = Math.PI;
  const r = scene.rotation ?? [0, 0, 0, 1];
  const rest = new THREE.Quaternion(r[0], r[1], r[2], r[3]);
  const center = new THREE.Vector3(), scales = new THREE.Vector3(), quat = new THREE.Quaternion();
  const color = new THREE.Color();
  const centers = new Float32Array(3 * splats.length / SPLAT_FLOATS);
  const chunks = scene.chunks.map((chunk, i) => {
    const [start, count] = ranges[i];
    const position = new THREE.Vector3(...chunk.position);
    const packed = new PackedSplats();
    for (let j = start; j < start + count; j++) {
      const f = SPLAT_FLOATS * j;
      center.set(splats[f], splats[f + 1], splats[f + 2]);
      scales.set(splats[f + 3], splats[f + 4], splats[f + 5]);
      quat.set(splats[f + 6], splats[f + 7], splats[f + 8], splats[f + 9]);
      color.r = splats[f + 11]; color.g = splats[f + 12]; color.b = splats[f + 13]; // as stored
      packed.pushSplat(center, scales, quat, splats[f + 10], color);
      // Its world centre, in the data frame (the group's turn: y and z negated), for the bounds.
      center.applyQuaternion(rest).add(position);
      centers.set([center.x, -center.y, -center.z], 3 * j);
    }
    const object = new SplatObject(packed.packedArray ?? new Uint32Array(0), packed.numSplats, packed.splatEncoding);
    object.position.copy(position);
    object.quaternion.copy(rest);
    group.add(object);
    return object;
  });
  return { object: group, chunks, bounds: computeBounds(centers) };
}
