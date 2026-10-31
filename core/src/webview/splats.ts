// 3D Gaussian Splatting: decode a splat file into a plain CPU-side cloud (Spark
// parses the file with WASM in a worker), then build one of three render modes:
//   - "splatting"  — real Gaussian splatting, rendered by Radix (per-viewpoint
//                    sorted, alpha falloff). See `splatDrawer.ts`, which owns the
//                    one Radix renderer every SplatObject draws through.
//   - "ellipsoids" — each Gaussian as a solid oriented ellipsoid (the unit sphere
//                    transformed by T(center)·R(quat)·S(σ·scales)), drawn as one
//                    instanced icosphere per Gaussian. Opaque, so the z-buffer
//                    handles occlusion and no per-viewpoint work is needed.
//   - "points"     — one colored point per Gaussian center; cheap, scales to any file.
// The last two are self-built approximations, useful for seeing the Gaussians as
// data (and as a fallback where splatting is too slow).
//
// The decoded cloud is kept so switching modes rebuilds without re-decoding — and
// that includes Spark's own packed buffer, which `SplatObject` adopts as-is.
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { unpackSplat, PackedSplats } from "@sparkjsdev/spark";
import { ArrayData, Splats } from "@sparkjsdev/radix/core";
import type { Bounds } from "../shared/messages";
import { computeBounds } from "../colmap/bounds";
import { buildColoredPoints, DEFAULT_POINT_SIZE, PointCloud, sphereFromBounds } from "./builders";

/** How a decoded splat cloud is rendered, in decreasing fidelity — also the order
 *  the E key cycles and the control panel lists. */
export const SPLAT_RENDER_MODES = ["splatting", "ellipsoids", "points"] as const;
export type SplatRenderMode = (typeof SPLAT_RENDER_MODES)[number];

/**
 * Ellipsoid radii, in σ of the Gaussian. A rendered splat fades out well past 1σ,
 * so the 1σ isosurface reads gappy; 2σ approximates the extent an actual splat
 * covers. Purely a look knob — nothing downstream depends on it.
 */
const ELLIPSOID_SIGMA = 2;

/** Gaussians fainter than this contribute almost nothing but cost a full ellipsoid. */
const MIN_OPACITY = 0.05;

/**
 * Ellipsoid budget. Sized to draw a typical full 3DGS reconstruction (~1M
 * Gaussians) rather than quietly halving it: 20M triangles at the 20-triangle
 * (detail 0) icosphere, and ~76 MB of instance matrix + color buffers. Lower it if
 * a big scene drags while orbiting.
 */
export const MAX_ELLIPSOIDS = 1_000_000;

type SplatEncoding = PackedSplats["splatEncoding"];

/** A decoded 3DGS cloud, kept CPU-side so render modes rebuild without re-decoding. */
export interface SplatCloud {
  /**
   * Spark's own packed buffer, exactly as its decoder produced it — the source the
   * "splatting" mode renders from, adopted without a copy or a second parse. Unlike
   * the arrays below it still holds the non-finite "floater" Gaussians; Spark's
   * renderer deals with them, and dropping them here would mean rewriting the
   * buffer. Sized `packedCount`, which is >= `count`.
   */
  packed: Uint32Array;
  packedCount: number;
  /** How `packed` is quantized (color and log-scale ranges, SH maxima). The decoder
   *  picks it per file, so it travels with the buffer: reading or drawing the
   *  buffer under any other encoding gets colors and sizes wrong. */
  encoding: SplatEncoding;
  /** Number of finite Gaussians (the plain arrays below are all sized from this). */
  count: number;
  centers: Float32Array; // 3n — xyz
  colors: Uint8Array; // 3n — rgb, base (SH DC) color
  scales: Float32Array; // 3n — per-axis σ, in world units
  quats: Float32Array; // 4n — orientation, xyzw
  opacities: Float32Array; // n — 0..1
  bounds: Bounds; // AABB over the centers
}

/**
 * Decode a splat file with Spark into a `SplatCloud`.
 *
 * Spark stores centers as half-floats, so a Gaussian whose coordinate exceeds the
 * half-float range (~65504) — common "floater" splats in 3DGS files — decodes to
 * ±Infinity/NaN. We drop those: a single non-finite point would poison the bounds,
 * blowing up fit-to-view and the world grid.
 */
export async function decodeSplats(input: Uint8Array, name: string): Promise<SplatCloud> {
  // Decoding only: the PackedSplats is dropped once its arrays are taken, and it
  // allocates no GPU textures until something draws it.
  const { packedArray, numSplats, splatEncoding } = await new PackedSplats({
    fileBytes: input,
    fileName: name,
  }).initialized;
  if (!packedArray) {
    throw new Error(`Spark decoded no splats from ${name}`);
  }
  const centers = new Float32Array(numSplats * 3);
  const colors = new Uint8Array(numSplats * 3);
  const scales = new Float32Array(numSplats * 3);
  const quats = new Float32Array(numSplats * 4);
  const opacities = new Float32Array(numSplats);
  let n = 0; // count of finite splats kept
  for (let i = 0; i < numSplats; i++) {
    const s = unpackSplat(packedArray, i, splatEncoding); // reused output object; copy immediately
    const { x, y, z } = s.center;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }
    centers[n * 3] = x;
    centers[n * 3 + 1] = y;
    centers[n * 3 + 2] = z;
    colors[n * 3] = to255(s.color.r);
    colors[n * 3 + 1] = to255(s.color.g);
    colors[n * 3 + 2] = to255(s.color.b);
    scales[n * 3] = s.scales.x;
    scales[n * 3 + 1] = s.scales.y;
    scales[n * 3 + 2] = s.scales.z;
    quats[n * 4] = s.quaternion.x;
    quats[n * 4 + 1] = s.quaternion.y;
    quats[n * 4 + 2] = s.quaternion.z;
    quats[n * 4 + 3] = s.quaternion.w;
    opacities[n] = s.opacity;
    n++;
  }
  if (n < numSplats) {
    console.warn(`3DView: dropped ${numSplats - n} splat(s) with non-finite centers`);
  }
  const cloudCenters = trim(centers, n * 3);
  return {
    packed: packedArray,
    packedCount: numSplats,
    encoding: splatEncoding,
    count: n,
    centers: cloudCenters,
    colors: trim(colors, n * 3),
    scales: trim(scales, n * 3),
    quats: trim(quats, n * 4),
    opacities: trim(opacities, n),
    bounds: computeBounds(cloudCenters),
  };
}

/** Shrink an over-allocated array to `length`, without copying when it already fits
 *  — the usual case, and these arrays run to hundreds of MB on a big cloud. */
function trim<T extends Float32Array | Uint8Array>(array: T, length: number): T {
  return array.length === length ? array : (array.slice(0, length) as T);
}

/** Build the renderable object for a decoded cloud in the requested mode. */
export function buildSplatObject(cloud: SplatCloud, mode: SplatRenderMode): THREE.Object3D {
  if (mode === "splatting") {
    return new SplatObject(cloud.packed, cloud.packedCount, cloud.encoding);
  }
  return mode === "ellipsoids" ? buildSplatEllipsoids(cloud) : buildSplatPoints(cloud);
}

/**
 * The real thing: a splat object, drawn by the Viewer's Radix renderer (see
 * `splatDrawer.ts`) with a per-viewpoint sort and proper alpha falloff.
 *
 * It holds the packed buffer as Radix array data and nothing else. Radix's packed
 * layout is Spark's byte for byte, so the decoded buffer is adopted as-is and
 * switching into this mode neither re-fetches nor re-parses the file. No GPU state
 * lives here: the drawer uploads `data` the first time it draws this, and again
 * whenever `version` moves. It gathers the visible splat objects from the scene
 * before each frame and draws each through its own `matrixWorld`, so the Scene
 * list's show/hide and the per-item transform apply to splats like anything else.
 *
 * The buffer is taken by reference, not copied: a lone asset passes its cloud's own
 * array, while a sequence passes a buffer of its own that it writes each frame into
 * (see `swapSplatCloud`).
 */
export class SplatObject extends THREE.Object3D {
  /** Bumped whenever the buffer is rewritten in place, so the drawer re-uploads it. */
  version = 0;
  readonly data: ArrayData;

  constructor(packed: Uint32Array, count: number, encoding: SplatEncoding) {
    super();
    this.data = new ArrayData({ count, capacity: packed.length / 4 });
    this.data.addBundle("splats", Splats.PACKED, {
      data: { packed: packed as Uint32Array<ArrayBuffer> },
      meta: { encoding: radixEncoding(encoding) },
    });
  }

  /** The packed buffer the drawer uploads. */
  get packed(): Uint32Array {
    return this.data.bundles.splats.channels.packed.data as Uint32Array;
  }
}

/** The part of Spark's encoding a packed buffer is quantized with; Radix reads the
 *  same four ranges (the rest are Spark's spherical-harmonic and LoD settings). */
function radixEncoding({ rgbMin, rgbMax, lnScaleMin, lnScaleMax }: SplatEncoding) {
  return { rgbMin, rgbMax, lnScaleMin, lnScaleMax };
}

/**
 * Redraw an existing splat object from another frame of the same capture, in place.
 * True when it took; false when the object isn't a splat object (the ellipsoid and
 * point modes build their own geometry) or the frame's layout differs, and the
 * caller must rebuild instead.
 *
 * The point is what it avoids. A fresh object per frame changes the set the drawer
 * hands Radix, which then uploads new GPU arrays and, on the WebGL2 backend, keeps
 * showing the previous set until a worker sort for the new one lands — a slideshow.
 * Rewriting the same object keeps the set and its GPU arrays: the frame is uploaded
 * into them and shown at once, and the re-sort follows behind it (one frame of
 * slightly stale ordering, imperceptible when consecutive frames are the same
 * Gaussians in motion). Written INTO the object's own buffer, which is why it must
 * own one (`AssetLayer.buildFrameObject`) — each frame's decoded array stays intact.
 */
export function swapSplatCloud(object: THREE.Object3D | undefined, cloud: SplatCloud): boolean {
  if (!(object instanceof SplatObject)) {
    return false;
  }
  const packed = object.packed;
  if (packed.length !== cloud.packed.length || object.data.count !== cloud.packedCount) {
    return false;
  }
  packed.set(cloud.packed);
  object.data.bundles.splats.meta.encoding = radixEncoding(cloud.encoding);
  object.version++;
  return true;
}

/** Whether two decoded frames can be swapped for one another on the same mesh:
 *  same splat count, and the same bytes per splat (a differing spherical-harmonic
 *  degree changes the packed layout, and with it Spark's program). */
export function sameSplatLayout(a: SplatCloud, b: SplatCloud): boolean {
  return a.packedCount === b.packedCount && a.packed.length === b.packed.length;
}

/** The cloud's centers as a colored `PointCloud` — base color only, no covariance.
 *  3DGS clouds have no per-point size of their own, so they start at the shared
 *  default and follow the "Point size" slider from there, like any other cloud. */
function buildSplatPoints(cloud: SplatCloud): PointCloud {
  return buildColoredPoints(cloud.centers, cloud.colors, cloud.bounds, DEFAULT_POINT_SIZE);
}

/**
 * Each Gaussian as a solid oriented ellipsoid, in one `THREE.InstancedMesh` (a
 * single draw call). Lit like any mesh, so the global Shaded / Wireframe toggles
 * apply to it through the AssetLayer's usual shading pairs.
 *
 * Geometry-bound rather than fill-bound: the icosphere's tessellation drops as the
 * Gaussian count rises, and `selectEllipsoids` caps how many are drawn at all.
 */
function buildSplatEllipsoids(cloud: SplatCloud): THREE.InstancedMesh {
  const indices = selectEllipsoids(cloud);
  const n = indices.length;
  const geometry = ellipsoidGeometry(ellipsoidDetail(n));
  // Lambert, not Standard: at this instance count the cost that matters is per-
  // fragment shading, and a PBR BRDF + environment IBL buys nothing on matte
  // single-color blobs. Diffuse-only from the scene's hemisphere + key light.
  const material = new THREE.MeshLambertMaterial();
  const mesh = new THREE.InstancedMesh(geometry, material, n);
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage); // built once, never animated

  const matrix = new THREE.Matrix4();
  const center = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();
  let maxRadius = 0;
  for (let i = 0; i < n; i++) {
    const s = indices[i];
    center.set(cloud.centers[s * 3], cloud.centers[s * 3 + 1], cloud.centers[s * 3 + 2]);
    quat.set(
      cloud.quats[s * 4],
      cloud.quats[s * 4 + 1],
      cloud.quats[s * 4 + 2],
      cloud.quats[s * 4 + 3]
    );
    scale.set(
      cloud.scales[s * 3] * ELLIPSOID_SIGMA,
      cloud.scales[s * 3 + 1] * ELLIPSOID_SIGMA,
      cloud.scales[s * 3 + 2] * ELLIPSOID_SIGMA
    );
    maxRadius = Math.max(maxRadius, scale.x, scale.y, scale.z);
    mesh.setMatrixAt(i, matrix.compose(center, quat, scale));
    // sRGB-encoded rgb, decoded to linear as the points path does for vertex colors.
    color.setRGB(
      cloud.colors[s * 3] / 255,
      cloud.colors[s * 3 + 1] / 255,
      cloud.colors[s * 3 + 2] / 255,
      THREE.SRGBColorSpace
    );
    mesh.setColorAt(i, color);
  }
  // Preset from the centers' AABB (grown by the largest ellipsoid) so Three doesn't
  // rescan every instance matrix on first render.
  mesh.boundingSphere = sphereFromBounds(cloud.bounds, maxRadius);
  return mesh;
}

/**
 * The instanced unit sphere. Indexed and attribute-minimal, because every saved
 * vertex is multiplied by the instance count: dropping the unused UVs and welding
 * the duplicate corners takes detail 0 from 60 vertices to 12 (the same 20
 * triangles). `IcosahedronGeometry` hands us flat per-face normals at detail 0,
 * which would block the weld — but on a unit sphere the smooth normal *is* the
 * position, so we substitute that first (and get rounder ellipsoids for free).
 */
function ellipsoidGeometry(detail: number): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, detail);
  geometry.deleteAttribute("uv"); // no maps on these materials
  geometry.setAttribute("normal", geometry.getAttribute("position").clone());
  return mergeVertices(geometry);
}

/**
 * Which Gaussians to draw as ellipsoids: those above `MIN_OPACITY`, and — if that
 * still exceeds `MAX_ELLIPSOIDS` — only the most visually significant of them
 * (opacity × ellipsoid volume). Both cuts are logged rather than applied silently.
 */
function selectEllipsoids(cloud: SplatCloud): Uint32Array {
  const kept = new Uint32Array(cloud.count);
  let keptCount = 0;
  for (let i = 0; i < cloud.count; i++) {
    if (cloud.opacities[i] >= MIN_OPACITY) {
      kept[keptCount++] = i;
    }
  }
  if (keptCount < cloud.count) {
    console.warn(
      `3DView: ${cloud.count - keptCount} splat(s) below opacity ${MIN_OPACITY} not drawn as ellipsoids`
    );
  }
  if (keptCount <= MAX_ELLIPSOIDS) {
    return kept.subarray(0, keptCount);
  }
  // Over budget: keep the top-MAX_ELLIPSOIDS by significance. Find the cutoff by
  // sorting the significance values (a native typed-array sort) rather than the
  // indices, then take splats at or above it — ties may fill the budget early.
  const significance = new Float32Array(keptCount);
  for (let i = 0; i < keptCount; i++) {
    significance[i] = splatSignificance(cloud, kept[i]);
  }
  const cutoff = significance.slice().sort()[keptCount - MAX_ELLIPSOIDS];
  const selected = new Uint32Array(MAX_ELLIPSOIDS);
  let n = 0;
  for (let i = 0; i < keptCount && n < MAX_ELLIPSOIDS; i++) {
    if (significance[i] >= cutoff) {
      selected[n++] = kept[i];
    }
  }
  console.warn(
    `3DView: ellipsoid budget ${MAX_ELLIPSOIDS} — drawing the ${n} most significant of ${keptCount} splat(s)`
  );
  return selected.subarray(0, n);
}

/** How much a Gaussian contributes on screen: opacity × ellipsoid volume (∝ σx·σy·σz). */
function splatSignificance(cloud: SplatCloud, i: number): number {
  return (
    cloud.opacities[i] * cloud.scales[i * 3] * cloud.scales[i * 3 + 1] * cloud.scales[i * 3 + 2]
  );
}

/** Icosphere tessellation, chosen against the splat count: an IcosahedronGeometry
 *  of detail d has 20·(d+1)² triangles — 180 / 80 / 20 here. */
function ellipsoidDetail(count: number): number {
  if (count <= 20_000) {
    return 2;
  }
  return count <= 150_000 ? 1 : 0;
}

function to255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}
