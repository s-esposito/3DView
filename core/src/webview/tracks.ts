// 3D point tracks: a set of points followed over time (TAP-style trajectories),
// loaded from a NumPy `.npz`/`.npy` and drawn as one polyline per track.
//
// Layout expected in the archive — matching what tracking pipelines save:
//   <name>_xyz : (steps, tracks, 3) float  — the trajectories, world space
//   <name>_vis : (steps, tracks)    bool   — per-step visibility (optional)
// Several groups (e.g. `obj_1_xyz`, `obj_2_xyz`) are concatenated into one asset;
// anything else in the archive (image size, frame indices, 2D `uv` tracks) is
// ignored. A bare `.npy` holding a single (steps, tracks, 3) array also works.
//
// Rendering: every trajectory becomes a run of line segments in a single
// `THREE.LineSegments` (one draw call). A step where a point is invisible — or
// where its position isn't finite — breaks the line rather than drawing through it.
// Segments are ordered time-major, so trimming the draw range reveals the tracks up
// to a chosen frame without touching the buffers.
import * as THREE from "three";
import type { Bounds } from "../shared/messages";
import { sphereFromBounds } from "./builders";
import type { NpyArray } from "./npz";

/** Where one source array's tracks landed in the concatenated set. */
export interface TrackGroup {
  name: string;
  start: number;
  count: number;
}

/** Decoded trajectories, time-major: point `i` at step `s` is at `3 * (s * count + i)`. */
export interface TrackSet {
  steps: number;
  count: number;
  positions: Float32Array;
  /** 1 = visible, 0 = not; one byte per (step, track). All 1 when the file has no mask. */
  visible: Uint8Array;
  groups: TrackGroup[];
  bounds: Bounds;
}

/** Saturation/lightness of the per-track colors; lightness ramps along the trail. */
const TRACK_SATURATION = 0.7;
const TRACK_LIGHTNESS_START = 0.3;
const TRACK_LIGHTNESS_END = 0.75;

/** Golden-ratio hue step: consecutive tracks get maximally distinct colors. */
const HUE_STEP = 0.618033988749895;

/**
 * Pick the trajectory arrays out of a loaded archive and concatenate them.
 * Throws with a readable message when the archive holds no usable tracks.
 */
export function decodeTracks(arrays: Map<string, NpyArray>): TrackSet {
  const candidates = [...arrays.entries()]
    .filter(([, a]) => a.shape.length === 3 && a.shape[2] === 3 && isFloat(a))
    .sort(([a], [b]) => a.localeCompare(b));
  if (candidates.length === 0) {
    throw new Error(
      "No 3D tracks in this file — expected an array shaped (steps, tracks, 3)" +
        (arrays.size > 0 ? `; found ${[...arrays.keys()].join(", ")}` : "")
    );
  }

  const steps = candidates[0][1].shape[0];
  const used = candidates.filter(([name, a]) => {
    if (a.shape[0] === steps) {
      return true;
    }
    console.warn(`3DView: skipping tracks "${name}" — ${a.shape[0]} steps, expected ${steps}`);
    return false;
  });

  const count = used.reduce((n, [, a]) => n + a.shape[1], 0);
  const positions = new Float32Array(steps * count * 3);
  const visible = new Uint8Array(steps * count).fill(1);
  const groups: TrackGroup[] = [];
  let start = 0;
  for (const [name, array] of used) {
    const tracks = array.shape[1];
    copyPositions(array, positions, steps, count, start);
    const vis = findVisibility(arrays, name, steps, tracks, used.length === 1);
    if (vis) {
      for (let s = 0; s < steps; s++) {
        for (let i = 0; i < tracks; i++) {
          visible[s * count + start + i] = vis.data[s * tracks + i] ? 1 : 0;
        }
      }
    }
    groups.push({ name, start, count: tracks });
    start += tracks;
  }

  return { steps, count, positions, visible, groups, bounds: trackBounds(positions, visible) };
}

/** Copy one (steps, tracks, 3) array into the concatenated buffer at track `start`. */
function copyPositions(
  array: NpyArray,
  out: Float32Array,
  steps: number,
  count: number,
  start: number
): void {
  const tracks = array.shape[1];
  const source = array.data as Float32Array | Float64Array;
  for (let s = 0; s < steps; s++) {
    const from = s * tracks * 3;
    const to = (s * count + start) * 3;
    // Both are C-order, so a step's tracks are contiguous in each: one block copy
    // (float64 sources narrow to float32 element-wise inside `set`).
    out.set(source.subarray(from, from + tracks * 3), to);
  }
}

/**
 * The visibility mask that goes with a trajectory array: same shape prefix and a
 * name mentioning "vis". When the archive holds exactly one track array, a single
 * unambiguous (steps, tracks) mask is accepted whatever it is called.
 */
function findVisibility(
  arrays: Map<string, NpyArray>,
  tracksName: string,
  steps: number,
  tracks: number,
  soleGroup: boolean
): NpyArray | undefined {
  const shaped = [...arrays.entries()].filter(
    ([, a]) => a.shape.length === 2 && a.shape[0] === steps && a.shape[1] === tracks
  );
  const prefix = tracksName.replace(/[_-]?(xyz|points|pts|tracks)$/i, "");
  const byName = shaped.filter(
    ([name]) => name.startsWith(prefix) && /vis|valid|occl/i.test(name)
  );
  if (byName.length === 1) {
    return byName[0][1];
  }
  if (byName.length === 0 && soleGroup && shaped.length === 1) {
    return shaped[0][1];
  }
  if (byName.length > 1) {
    console.warn(`3DView: ambiguous visibility for "${tracksName}" — drawing every step`);
  }
  return undefined;
}

/** Bounds over the points actually drawn (visible and finite). */
function trackBounds(positions: Float32Array, visible: Uint8Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let p = 0; p < visible.length; p++) {
    if (!visible[p]) {
      continue;
    }
    const x = positions[p * 3];
    const y = positions[p * 3 + 1];
    const z = positions[p * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }
    min[0] = Math.min(min[0], x);
    max[0] = Math.max(max[0], x);
    min[1] = Math.min(min[1], y);
    max[1] = Math.max(max[1], y);
    min[2] = Math.min(min[2], z);
    max[2] = Math.max(max[2], z);
  }
  return Number.isFinite(min[0]) ? { min, max } : { min: [-1, -1, -1], max: [1, 1, 1] };
}

/**
 * Build the drawable trajectories. Segments run time-major, and the per-step vertex
 * totals are stashed on the object so `setTrackTrail` can reveal a prefix of them.
 *
 * `density` (0..1) thins the set to a stable pseudo-random subset of the tracks —
 * stable so that raising it only ever adds tracks back, and per-track colors don't
 * shuffle underneath the viewer. Thinning is a rebuild because it changes which
 * segments exist; trail and opacity are not.
 */
export function buildTrackLines(set: TrackSet, density = 1): THREE.LineSegments {
  const { steps, count, positions, visible } = set;
  const drawn = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    drawn[i] = density >= 1 || hash01(i) < density ? 1 : 0;
  }
  const maxSegments = Math.max(0, steps - 1) * count;
  const vertices = new Float32Array(maxSegments * 6);
  const colors = new Uint8Array(maxSegments * 6);
  const stepVertexEnd = new Uint32Array(steps);
  const color = new THREE.Color();
  let v = 0; // vertex cursor (3 floats each)

  for (let s = 1; s < steps; s++) {
    const lightA = lightnessAt(s - 1, steps);
    const lightB = lightnessAt(s, steps);
    for (let i = 0; i < count; i++) {
      if (!drawn[i]) {
        continue; // thinned out by `density`
      }
      const a = (s - 1) * count + i;
      const b = s * count + i;
      if (!visible[a] || !visible[b]) {
        continue; // the point is hidden at one end — break the trail
      }
      if (!finiteAt(positions, a) || !finiteAt(positions, b)) {
        continue;
      }
      vertices[v * 3] = positions[a * 3];
      vertices[v * 3 + 1] = positions[a * 3 + 1];
      vertices[v * 3 + 2] = positions[a * 3 + 2];
      writeColor(colors, v, color.setHSL((i * HUE_STEP) % 1, TRACK_SATURATION, lightA));
      v++;
      vertices[v * 3] = positions[b * 3];
      vertices[v * 3 + 1] = positions[b * 3 + 1];
      vertices[v * 3 + 2] = positions[b * 3 + 2];
      writeColor(colors, v, color.setHSL((i * HUE_STEP) % 1, TRACK_SATURATION, lightB));
      v++;
    }
    stepVertexEnd[s] = v;
  }
  if (v === 0 && density >= 1) {
    throw new Error(
      `No drawable tracks — ${set.count} point(s) over ${set.steps} step(s), none visible in consecutive steps`
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices.slice(0, v * 3), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors.slice(0, v * 3), 3, true));
  geometry.boundingSphere = sphereFromBounds(set.bounds);
  // WebGL ignores line widths above 1px, so these are hairlines by construction.
  const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true }));
  lines.userData.trackStepVertexEnd = stepVertexEnd;
  return lines;
}

/**
 * Show the trajectories only up to `frames` time steps (1 = nothing drawn yet, the
 * full step count = the whole trail). A no-op on anything that isn't track lines.
 */
export function setTrackTrail(object: THREE.Object3D | undefined, frames: number): void {
  const ends = object?.userData?.trackStepVertexEnd as Uint32Array | undefined;
  if (!ends || ends.length === 0) {
    return;
  }
  const step = Math.min(Math.max(Math.round(frames), 1), ends.length) - 1;
  (object as THREE.LineSegments).geometry.setDrawRange(0, ends[step]);
}

/** Number of time steps in a track object, or 0 if it isn't one. */
export function trackSteps(object: THREE.Object3D | undefined): number {
  return (object?.userData?.trackStepVertexEnd as Uint32Array | undefined)?.length ?? 0;
}

/**
 * Fade the trajectories (1 = opaque). Overlapping hairlines read as a solid mat at
 * full opacity, so this is how a dense set becomes legible. Transparency is only
 * switched on below 1 — blended lines can't write depth, and paying that when
 * nothing is see-through would be pure loss.
 */
export function setTrackOpacity(object: THREE.Object3D | undefined, opacity: number): void {
  if (trackSteps(object) === 0) {
    return;
  }
  const material = (object as THREE.LineSegments).material as THREE.LineBasicMaterial;
  material.opacity = opacity;
  material.transparent = opacity < 1;
  material.depthWrite = opacity >= 1;
}

/**
 * Deterministic [0, 1) score per track index (an integer avalanche hash). Used to
 * pick which tracks survive thinning: the same index always scores the same, so the
 * subset is stable across rebuilds and nested as density grows.
 */
function hash01(index: number): number {
  let x = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function lightnessAt(step: number, steps: number): number {
  const t = steps > 1 ? step / (steps - 1) : 1;
  return TRACK_LIGHTNESS_START + t * (TRACK_LIGHTNESS_END - TRACK_LIGHTNESS_START);
}

function finiteAt(positions: Float32Array, point: number): boolean {
  return (
    Number.isFinite(positions[point * 3]) &&
    Number.isFinite(positions[point * 3 + 1]) &&
    Number.isFinite(positions[point * 3 + 2])
  );
}

function writeColor(colors: Uint8Array, vertex: number, color: THREE.Color): void {
  colors[vertex * 3] = Math.round(color.r * 255);
  colors[vertex * 3 + 1] = Math.round(color.g * 255);
  colors[vertex * 3 + 2] = Math.round(color.b * 255);
}

function isFloat(array: NpyArray): boolean {
  return array.dtype === "f4" || array.dtype === "f8";
}
