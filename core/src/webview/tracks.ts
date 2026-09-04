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
// `LineSegments2` — three's "fat line", one instanced quad per segment, so a width
// in screen pixels actually takes effect (plain WebGL clamps line widths to 1px).
// A step where a point is invisible — or where its position isn't finite — breaks
// the line rather than drawing through it. Segments are ordered time-major, so
// capping the instance count reveals the tracks up to a chosen frame without
// touching the buffers.
import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
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

/** Trail thickness in screen pixels a freshly built object starts at; the live value
 *  is applied by the layer on attach, exactly as point size is. Thick enough to read
 *  as a trajectory rather than a hairline. */
export const DEFAULT_TRACK_LINE_WIDTH = 3;

/** Smoothing a trail gets unless asked otherwise, in time steps. Half a step is a
 *  light touch: it takes the per-step jitter off tracker output while leaving the
 *  trajectory's real shape where it was. Slide it to 0 for the raw data. */
export const DEFAULT_TRACK_SMOOTHING = 0.5;

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
 * Per-set derived data, kept in a side table so a decoded `TrackSet` stays plain
 * data. Both entries are pure functions of a set that never changes after decoding,
 * and both are asked for again on every rebuild — a density drag rebuilds on every
 * tick — which is what makes caching them worth a WeakMap.
 */
interface Derived {
  /** Visible AND finite: the test the smoother and the draw loop both need. */
  valid: Uint8Array;
  /** Positions smoothed at `sigma`, once anything has asked for them. */
  smoothed?: Float32Array;
  sigma?: number;
}

const derived = new WeakMap<TrackSet, Derived>();

function derivedFor(set: TrackSet): Derived {
  let entry = derived.get(set);
  if (!entry) {
    const valid = new Uint8Array(set.visible.length);
    for (let p = 0; p < valid.length; p++) {
      valid[p] = set.visible[p] && finiteAt(set.positions, p) ? 1 : 0;
    }
    entry = { valid };
    derived.set(set, entry);
  }
  return entry;
}

/**
 * Build the drawable trajectories. Segments run time-major, and the per-step segment
 * totals are stashed on the object so `setTrackTrail` can reveal a prefix of them.
 *
 * `density` (0..1) thins the set to a stable pseudo-random subset of the tracks —
 * stable so that raising it only ever adds tracks back, and per-track colors don't
 * shuffle underneath the viewer. `smoothing` (in time steps) averages each
 * trajectory along time before any of this. Both are rebuilds because they change
 * which segments exist and where they are; trail, opacity and width are not.
 */
export function buildTrackLines(set: TrackSet, density = 1, smoothing = 0): LineSegments2 {
  const { steps, count } = set;
  const positions = smoothTracks(set, smoothing);
  // Computed from the raw positions, but right for the smoothed ones too: smoothing
  // averages finite samples (so a valid one stays finite) and passes every invalid
  // one through untouched.
  const { valid } = derivedFor(set);
  const drawn = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    drawn[i] = density >= 1 || hash01(i) < density ? 1 : 0;
  }
  const maxSegments = Math.max(0, steps - 1) * count;
  const vertices = new Float32Array(maxSegments * 6);
  const colors = new Float32Array(maxSegments * 6);
  const stepSegmentEnd = new Uint32Array(steps);
  const color = new THREE.Color();
  let v = 0; // vertex cursor (3 floats each); two vertices make one segment

  for (let s = 1; s < steps; s++) {
    const lightA = lightnessAt(s - 1, steps);
    const lightB = lightnessAt(s, steps);
    for (let i = 0; i < count; i++) {
      if (!drawn[i]) {
        continue; // thinned out by `density`
      }
      const a = (s - 1) * count + i;
      const b = s * count + i;
      if (!valid[a] || !valid[b]) {
        continue; // hidden or unplaced at one end — break the trail
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
    stepSegmentEnd[s] = v / 2;
  }
  if (v === 0 && density >= 1) {
    throw new Error(
      `No drawable tracks — ${set.count} point(s) over ${set.steps} step(s), none visible in consecutive steps`
    );
  }

  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(vertices.slice(0, v * 3));
  geometry.setColors(colors.slice(0, v * 3));
  // After setPositions: it computes a box and sphere of its own, which this replaces
  // with the set's own bounds (already known, and tighter to write than to derive).
  geometry.boundingSphere = sphereFromBounds(set.bounds);
  const material = new LineMaterial({
    vertexColors: true,
    linewidth: DEFAULT_TRACK_LINE_WIDTH,
    worldUnits: false, // width in screen px: constant thickness at any zoom
    alphaToCoverage: true, // smooth edges (the renderer is antialiased)
  });
  const lines = new LineSegments2(geometry, material);
  lines.userData.trackStepSegmentEnd = stepSegmentEnd;
  return lines;
}

/**
 * Average each trajectory along time with a Gaussian window of `sigma` steps
 * (0 or less = off, the set's own positions are returned untouched). Tracker output
 * jitters from step to step; this is the knob that turns a noisy trajectory into a
 * readable one without touching the file.
 *
 * Two rules come from how tracks are drawn. Only **visible and finite** samples
 * contribute, with the weights renormalized over the ones actually used — otherwise
 * a trail would be dragged toward the stale coordinates of a step where the tracker
 * had lost the point. And visibility itself is never touched: a hidden step stays
 * hidden, so trails still break exactly where they break unsmoothed. The result also
 * stays inside `set.bounds`, every point being a weighted average of points already
 * in there, so the caller's preset bounding sphere remains valid.
 */
export function smoothTracks(set: TrackSet, sigma: number): Float32Array {
  const { steps, count, positions } = set;
  if (!(sigma > 0) || steps < 2) {
    return positions;
  }
  const cache = derivedFor(set);
  if (cache.smoothed && cache.sigma === sigma) {
    return cache.smoothed; // a density drag rebuilds too, at an unchanged sigma
  }
  const { valid } = cache;
  const radius = Math.ceil(3 * sigma); // beyond 3σ the weights are noise
  const weights = new Float64Array(radius + 1);
  for (let d = 0; d <= radius; d++) {
    weights[d] = Math.exp(-(d * d) / (2 * sigma * sigma));
  }
  // A copy, so a sample this pass leaves alone is already the one it came in with —
  // and so the set's own positions are never smoothed in place.
  const out = positions.slice();
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < count; i++) {
      const p = s * count + i;
      if (!valid[p]) {
        continue; // not drawn anyway, and nothing to average toward
      }
      let x = 0;
      let y = 0;
      let z = 0;
      let total = 0;
      for (let d = -radius; d <= radius; d++) {
        const t = s + d;
        if (t < 0 || t >= steps) {
          continue;
        }
        const q = t * count + i;
        if (!valid[q]) {
          continue;
        }
        const w = weights[Math.abs(d)];
        x += w * positions[q * 3];
        y += w * positions[q * 3 + 1];
        z += w * positions[q * 3 + 2];
        total += w;
      }
      out[p * 3] = x / total; // total > 0: the sample itself always counts
      out[p * 3 + 1] = y / total;
      out[p * 3 + 2] = z / total;
    }
  }
  cache.smoothed = out;
  cache.sigma = sigma;
  return out;
}

/**
 * Show the trajectories only up to `frames` time steps (1 = nothing drawn yet, the
 * full step count = the whole trail). A no-op on anything that isn't track lines.
 */
export function setTrackTrail(object: THREE.Object3D | undefined, steps: number): void {
  const ends = object?.userData?.trackStepSegmentEnd as Uint32Array | undefined;
  if (!ends || ends.length === 0) {
    return;
  }
  const step = Math.min(Math.max(Math.round(steps), 1), ends.length) - 1;
  // A fat line draws one instance per segment, so the instance count is its draw range.
  (object as LineSegments2).geometry.instanceCount = ends[step];
}

/** Number of time steps in a track object, or 0 if it isn't one. */
export function trackSteps(object: THREE.Object3D | undefined): number {
  return (object?.userData?.trackStepSegmentEnd as Uint32Array | undefined)?.length ?? 0;
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
  const material = (object as LineSegments2).material;
  material.opacity = opacity;
  material.transparent = opacity < 1;
  material.depthWrite = opacity >= 1;
  // Alpha-to-coverage turns alpha into MSAA sample coverage, which is what gives an
  // opaque fat line its smooth edge — but stacked on real blending it masks samples a
  // second time and a faded trail comes out stippled and too thin.
  material.alphaToCoverage = opacity >= 1;
}

/**
 * Set the trail thickness in screen pixels (constant at any zoom — the material is
 * in screen units, not world ones). Live: a fat line's width is a uniform, so this
 * costs nothing and never rebuilds. A no-op on anything that isn't track lines.
 */
export function setTrackLineWidth(object: THREE.Object3D | undefined, width: number): void {
  if (trackSteps(object) === 0) {
    return;
  }
  (object as LineSegments2).material.linewidth = width;
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

function writeColor(colors: Float32Array, vertex: number, color: THREE.Color): void {
  colors[vertex * 3] = color.r;
  colors[vertex * 3 + 1] = color.g;
  colors[vertex * 3 + 2] = color.b;
}

function isFloat(array: NpyArray): boolean {
  return array.dtype === "f4" || array.dtype === "f8";
}
