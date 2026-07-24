// 3D Gaussian Splatting: decode a splat file into a plain CPU-side cloud (Spark
// parses the file with WASM in a worker), then build one of two render modes from
// it. Both are self-built approximations — neither is true splatting (no per-view
// sort, no SH view-dependence, no alpha falloff):
//   - "points"     — one colored point per Gaussian center; cheap, scales to any file.
//   - "ellipsoids" — each Gaussian as a solid oriented ellipsoid (the unit sphere
//                    transformed by T(center)·R(quat)·S(σ·scales)), drawn as one
//                    instanced icosphere per Gaussian. Opaque, so the z-buffer
//                    handles occlusion and no per-viewpoint work is needed — it
//                    fits the Viewer's on-demand `requestRender()` loop.
// The decoded cloud is kept so switching modes rebuilds geometry without re-decoding.
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { unpackSplats, unpackSplat } from "@sparkjsdev/spark";
import type { Bounds } from "../shared/messages";
import { computeBounds } from "../colmap/bounds";
import { buildColoredPoints, sphereFromBounds } from "./builders";

/** How a decoded splat cloud is rendered. */
export type SplatRenderMode = "points" | "ellipsoids";

/** 3DGS point clouds have no per-point size of their own, so render their centers
 *  at the same constant pixel size the COLMAP/PLY point paths use. */
const SPLAT_POINT_SIZE = 1.5;

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
 * Gaussians) rather than quietly halving it, since ellipsoids are the default mode:
 * 20M triangles at the 20-triangle (detail 0) icosphere, and ~76 MB of instance
 * matrix + color buffers. Lower it if a big scene drags while orbiting.
 */
export const MAX_ELLIPSOIDS = 1_000_000;

/** A decoded 3DGS cloud, kept CPU-side so render modes rebuild without re-decoding. */
export interface SplatCloud {
  /** Number of Gaussians (all arrays are sized from this). */
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
  const { packedArray, numSplats } = await unpackSplats({ input, pathOrUrl: name });
  const centers = new Float32Array(numSplats * 3);
  const colors = new Uint8Array(numSplats * 3);
  const scales = new Float32Array(numSplats * 3);
  const quats = new Float32Array(numSplats * 4);
  const opacities = new Float32Array(numSplats);
  let n = 0; // count of finite splats kept
  for (let i = 0; i < numSplats; i++) {
    const s = unpackSplat(packedArray, i); // reused output object; copy immediately
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
  return mode === "ellipsoids" ? buildSplatEllipsoids(cloud) : buildSplatPoints(cloud);
}

/** The cloud's centers as a colored `THREE.Points` — base color only, no covariance. */
function buildSplatPoints(cloud: SplatCloud): THREE.Points {
  return buildColoredPoints(cloud.centers, cloud.colors, cloud.bounds, SPLAT_POINT_SIZE);
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
    // Raw (working-space) rgb, matching what the points path feeds vertex colors.
    color.setRGB(
      cloud.colors[s * 3] / 255,
      cloud.colors[s * 3 + 1] / 255,
      cloud.colors[s * 3 + 2] / 255
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
