// The asset layer: holds at most one loaded asset under a container group,
// mirroring CameraLayer so the Viewer treats all scene sources uniformly. An
// asset is a mesh (glTF/GLB/OBJ/PLY) or a 3D Gaussian Splatting cloud
// (.ply / .splat / .spz / .ksplat). Mesh asset siblings (.bin, .mtl, textures)
// resolve relative to the file's webview URI; splats are loaded via Spark and
// rendered (v1) as a colored point cloud — base color only, no covariance/SH.
//
// Mesh shading: each mesh keeps its loaded material (lit PBR, incl. GLB
// textures) plus a derived unlit "albedo" material (base-color texture + color,
// no lighting). The "Shaded" toggle swaps between them; shaded is the default.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { unpackSplats, unpackSplat } from "@sparkjsdev/spark";
import type { Bounds } from "../shared/messages";
import { computeBounds } from "../colmap/bounds";
import { buildBox, buildSplatPoints, disposeObject, eachMaterial } from "./builders";
import type { SceneLayer } from "./sceneLayer";

// 3DGS point clouds have no per-point size of their own (v1), so render their
// centers at the same constant pixel size the COLMAP/PLY point paths use.
const SPLAT_POINT_SIZE = 1.5;

/** A single loaded asset (mesh or splat cloud) as a scene layer. */
export class AssetLayer implements SceneLayer {
  readonly kind = "asset" as const;
  readonly object = new THREE.Group();
  visible = true;

  private current?: THREE.Object3D;
  private currentBounds?: Bounds;
  private box?: THREE.Box3Helper;
  /** Per-mesh material pairs backing the Shaded / Wireframe toggles; empty for splats. */
  private shadingPairs: ShadingPair[] = [];

  constructor(
    readonly id: string,
    public label: string,
    /** Asset file URI, surfaced as the Scene-list hover tooltip. */
    readonly source: string
  ) {}

  bounds(): Bounds | undefined {
    return this.currentBounds;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.object.visible = visible;
  }

  setBoxVisible(visible: boolean): void {
    if (this.box) {
      this.box.visible = visible;
    }
  }

  setWireframe(on: boolean): void {
    // Apply to both the lit material and its unlit twin so the active one is right.
    // No-op for splat point clouds (they have no shading pairs).
    const apply = (m: THREE.Material) => {
      (m as THREE.MeshBasicMaterial).wireframe = on;
    };
    for (const pair of this.shadingPairs) {
      eachMaterial(pair.lit, apply);
      eachMaterial(pair.unlit, apply);
    }
  }

  setShaded(on: boolean): void {
    // Swap each mesh between its loaded (lit) material and its unlit albedo twin.
    // No-op for splat point clouds (they have no shading pairs).
    for (const pair of this.shadingPairs) {
      pair.mesh.material = on ? pair.lit : pair.unlit;
    }
  }

  /** Load the asset file and add it (plus a bounding box) under this layer's group.
   *  `onProgress` reports the current phase (download %, then "Decoding…"). */
  async load(uri: string, name: string, onProgress?: Progress): Promise<void> {
    const { object, bounds } = await loadAsset(uri, name, onProgress);
    this.current = object;
    this.currentBounds = bounds;
    this.shadingPairs = collectShadingPairs(object);
    this.object.add(object);
    this.box = buildBox(bounds);
    this.object.add(this.box);
  }

  dispose(): void {
    // Each unlit twin reuses its lit material's textures, so dispose the unlit
    // material objects here (not their shared maps) and re-activate the lit
    // material so disposeObject frees the textures + geometry exactly once.
    for (const pair of this.shadingPairs) {
      eachMaterial(pair.unlit, (m) => m.dispose());
      pair.mesh.material = pair.lit;
    }
    this.shadingPairs = [];
    disposeObject(this.current);
    disposeObject(this.object); // also disposes the box (a child of object)
    this.current = undefined;
    this.currentBounds = undefined;
    this.box = undefined;
  }
}

/** A loaded mesh paired with its as-loaded (lit) material and a derived unlit twin. */
interface ShadingPair {
  mesh: THREE.Mesh;
  // Both keep the mesh's original scalar-or-array shape, so reassigning one to
  // `mesh.material` re-renders correctly (an array needs geometry groups; a lone
  // material does not).
  lit: THREE.Material | THREE.Material[];
  unlit: THREE.Material | THREE.Material[];
}

/** Walk an object's meshes, pairing each loaded material with an unlit albedo twin. */
function collectShadingPairs(object: THREE.Object3D): ShadingPair[] {
  const pairs: ShadingPair[] = [];
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }
    const lit = mesh.material;
    const unlit = Array.isArray(lit) ? lit.map(toUnlit) : toUnlit(lit);
    pairs.push({ mesh, lit, unlit });
  });
  return pairs;
}

/**
 * An unlit (albedo) twin of a lit material: the base-color texture + color factor
 * with no lighting. Reuses the source's `map` texture (shared, not cloned), so it
 * shows GLB/PBR albedo exactly; carries over transparency/cutout and sidedness.
 */
function toUnlit(mat: THREE.Material): THREE.MeshBasicMaterial {
  // Any lit mesh material (Standard/Physical/Phong/Lambert) carries .map and .color.
  const m = mat as THREE.MeshStandardMaterial;
  return new THREE.MeshBasicMaterial({
    map: m.map,
    color: m.color.clone(),
    vertexColors: m.vertexColors,
    transparent: m.transparent,
    opacity: m.opacity,
    alphaTest: m.alphaTest,
    side: m.side,
    wireframe: m.wireframe,
  });
}

interface LoadedAsset {
  object: THREE.Object3D;
  bounds: Bounds;
}

/** Reports a human-readable loading phase ("Downloading… 45%", "Decoding…"). */
type Progress = (phase: string) => void;

/** "Downloading… 45%" when the total size is known, else a running byte count. */
function downloadPhase(loaded: number, total: number): string {
  return total > 0
    ? `Downloading… ${Math.round((loaded / total) * 100)}%`
    : `Downloading… ${(loaded / 1e6).toFixed(1)} MB`;
}

const gltfLoader = new GLTFLoader();
const objLoader = new OBJLoader();
const plyLoader = new PLYLoader();

function loadAsset(uri: string, name: string, onProgress?: Progress): Promise<LoadedAsset> {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "glb":
    case "gltf":
      return load(gltfLoader, uri, onProgress).then((gltf) => finalize(gltf.scene));
    case "obj":
      return load(objLoader, uri, onProgress).then((group) => finalize(group));
    case "ply":
      return loadPly(uri, name, onProgress);
    case "splat":
    case "spz":
    case "ksplat":
      return loadSplat(uri, name, onProgress);
    default:
      return Promise.reject(new Error(`Unsupported asset format: .${ext ?? "?"}`));
  }
}

/** Promisified loader.load with normalized errors and download-progress reporting. */
function load<T>(
  loader: {
    load: (
      url: string,
      onLoad: (result: T) => void,
      onProgress?: (e: ProgressEvent) => void,
      onError?: (err: unknown) => void
    ) => void;
  },
  uri: string,
  onProgress?: Progress
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    loader.load(
      uri,
      resolve,
      onProgress ? (e) => onProgress(downloadPhase(e.loaded, e.lengthComputable ? e.total : 0)) : undefined,
      (err) => reject(err instanceof Error ? err : new Error(String(err)))
    );
  });
}

/**
 * A .ply may be a mesh, a plain point cloud, or a 3DGS splat cloud. Fetch it once
 * and disambiguate by header: a 3DGS PLY carries `f_dc_0` (the SH DC color term),
 * which a mesh/normal-cloud PLY never has. Splats go through Spark; the rest reuse
 * three's PLYLoader.
 */
async function loadPly(uri: string, name: string, onProgress?: Progress): Promise<LoadedAsset> {
  const buffer = await fetchBytes(uri, onProgress);
  const bytes = new Uint8Array(buffer);
  if (isSplatPly(bytes)) {
    onProgress?.("Decoding…");
    return buildSplatLayer(bytes, name);
  }
  return finalize(plyToObject(plyLoader.parse(buffer)));
}

/** Load a Spark-supported splat file (.splat/.spz/.ksplat) as a colored point cloud. */
async function loadSplat(uri: string, name: string, onProgress?: Progress): Promise<LoadedAsset> {
  const buffer = await fetchBytes(uri, onProgress);
  onProgress?.("Decoding…");
  return buildSplatLayer(new Uint8Array(buffer), name);
}

/**
 * True if a PLY header looks like a 3D Gaussian Splatting file rather than a mesh
 * or plain point cloud. Covers both flavors Spark decodes:
 *   - uncompressed 3DGS — has the SH DC term `f_dc_0`;
 *   - PlayCanvas/SuperSplat **compressed** (`element chunk …`) — has `packed_position`.
 * A mesh / normal point-cloud PLY has neither (it has `x`/`y`/`z`, faces, colors).
 */
function isSplatPly(bytes: Uint8Array): boolean {
  // The header is ASCII and short; scan a generous prefix up to "end_header".
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const end = head.indexOf("end_header");
  const header = end >= 0 ? head.slice(0, end) : head;
  return header.includes("f_dc_0") || header.includes("packed_position");
}

/**
 * Decode a splat file with Spark (WASM in a worker) into packed splats, then read
 * each Gaussian's center + base color CPU-side into a colored `THREE.Points`.
 *
 * Spark stores centers as half-floats, so a Gaussian whose coordinate exceeds the
 * half-float range (~65504) — common "floater" splats in 3DGS files — decodes to
 * ±Infinity/NaN. We drop those: a single non-finite point would poison the bounds,
 * blowing up fit-to-view and the world grid.
 */
async function buildSplatLayer(input: Uint8Array, name: string): Promise<LoadedAsset> {
  const { packedArray, numSplats } = await unpackSplats({ input, pathOrUrl: name });
  const positions = new Float32Array(numSplats * 3);
  const colors = new Uint8Array(numSplats * 3);
  let n = 0; // count of finite splats kept
  for (let i = 0; i < numSplats; i++) {
    const s = unpackSplat(packedArray, i); // reused output object; copy immediately
    const { x, y, z } = s.center;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }
    positions[n * 3] = x;
    positions[n * 3 + 1] = y;
    positions[n * 3 + 2] = z;
    colors[n * 3] = to255(s.color.r);
    colors[n * 3 + 1] = to255(s.color.g);
    colors[n * 3 + 2] = to255(s.color.b);
    n++;
  }
  if (n < numSplats) {
    console.warn(`3DView: dropped ${numSplats - n} splat(s) with non-finite centers`);
  }
  const pos = positions.slice(0, n * 3);
  const col = colors.slice(0, n * 3);
  const bounds = computeBounds(pos);
  return { object: buildSplatPoints(pos, col, bounds, SPLAT_POINT_SIZE), bounds };
}

function to255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/**
 * Fetch a file's bytes, streaming download progress when the server reports a
 * `Content-Length` (it does for webview/file resources). Falls back to a plain
 * `arrayBuffer()` when there's no length or no progress callback.
 */
async function fetchBytes(uri: string, onProgress?: Progress): Promise<ArrayBuffer> {
  const res = await fetch(uri);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${uri}: ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get("Content-Length")) || 0;
  if (!onProgress || !res.body || total <= 0) {
    return res.arrayBuffer();
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    loaded += value.length;
    onProgress(downloadPhase(loaded, total));
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

/** PLY can be a mesh (has faces) or a bare point cloud; build the right object. */
function plyToObject(geometry: THREE.BufferGeometry): THREE.Object3D {
  const hasColor = geometry.getAttribute("color") != null;
  const isMesh = geometry.getIndex() != null && geometry.getIndex()!.count > 0;
  if (isMesh) {
    if (!geometry.getAttribute("normal")) {
      geometry.computeVertexNormals();
    }
    return new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        vertexColors: hasColor,
        color: hasColor ? 0xffffff : 0xcccccc,
        metalness: 0,
        roughness: 1,
      })
    );
  }
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      vertexColors: hasColor,
      color: hasColor ? 0xffffff : 0xcccccc,
      size: 1.5,
      sizeAttenuation: false,
    })
  );
}

function finalize(object: THREE.Object3D): LoadedAsset {
  const box = new THREE.Box3().setFromObject(object);
  const bounds: Bounds = box.isEmpty()
    ? { min: [-1, -1, -1], max: [1, 1, 1] }
    : {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
      };
  return { object, bounds };
}
