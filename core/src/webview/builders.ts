// Pure Three.js geometry builders and small scene-math helpers. No state, no
// DOM — everything here takes data in and returns objects/values out, so each
// piece is easy to read, reuse, and reason about.
import * as THREE from "three";
import type { ModelData, CameraView, Bounds } from "../shared/messages";

export const FRUSTUM_COLOR = 0x4aa3ff;
const GRID_PADDING = 1.5;
const BOX_COLOR = 0x33dd88;

/** The colored point cloud as a single `THREE.Points`. */
export function buildPoints(data: ModelData, pointSize: number): THREE.Points {
  return buildColoredPoints(data.positions, data.colors, data.bounds, pointSize);
}

/** Shared colored-points builder: positions + Uint8 rgb + AABB-derived sphere.
 *  Used by the COLMAP cloud above and by the splat layer's "points" render mode. */
export function buildColoredPoints(
  positions: Float32Array,
  colors: Uint8Array,
  bounds: Bounds,
  pointSize: number
): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  // Uint8 rgb, normalized to 0..1 in the shader.
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3, true));
  // Preset the bounding sphere so Three doesn't scan the whole position buffer on
  // first render (a per-cloud first-frame hitch).
  geometry.boundingSphere = sphereFromBounds(bounds);
  const material = new THREE.PointsMaterial({
    size: pointSize,
    vertexColors: true,
    sizeAttenuation: false,
  });
  return new THREE.Points(geometry, material);
}

/**
 * Sphere enclosing `bounds`, optionally grown by `margin` (how far geometry built
 * on those bounds reaches past them — e.g. a splat's ellipsoid radius). Radius is
 * half the space diagonal; undersizing would wrongly frustum-cull the content.
 */
export function sphereFromBounds(b: Bounds, margin = 0): THREE.Sphere {
  const center = new THREE.Vector3(
    (b.min[0] + b.max[0]) / 2,
    (b.min[1] + b.max[1]) / 2,
    (b.min[2] + b.max[2]) / 2
  );
  const halfDiagonal =
    0.5 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  return new THREE.Sphere(center, Math.max(halfDiagonal + margin, 1e-6));
}

/** World-space corners of a camera's image plane at depth `d` (TL, TR, BR, BL). */
export function frustumCorners(cam: CameraView, d: number): number[][] {
  const C = cam.center;
  const m = cam.worldFromCamera; // row-major, maps camera dir -> world
  const cornerPix: Array<[number, number]> = [
    [0, 0],
    [cam.width, 0],
    [cam.width, cam.height],
    [0, cam.height],
  ];
  return cornerPix.map(([u, v]) => {
    const x = ((u - cam.cx) / cam.fx) * d;
    const y = ((v - cam.cy) / cam.fy) * d;
    const z = d;
    return [
      C[0] + m[0] * x + m[1] * y + m[2] * z,
      C[1] + m[3] * x + m[4] * y + m[5] * z,
      C[2] + m[6] * x + m[7] * y + m[8] * z,
    ];
  });
}

/** Frustum wireframe: apex -> each corner, then the image-plane rectangle. */
export function buildFrustumLines(
  center: number[],
  corners: number[][],
  color: number
): THREE.LineSegments {
  const seg: number[] = [];
  const push = (a: number[], b: number[]) =>
    seg.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  for (const c of corners) {
    push(center, c);
  }
  push(corners[0], corners[1]);
  push(corners[1], corners[2]);
  push(corners[2], corners[3]);
  push(corners[3], corners[0]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color }));
}

/**
 * A quad spanning the four image-plane corners. Starts transparent (no texture);
 * the caller assigns a texture and sets opacity when one loads, so unloaded
 * planes stay invisible but remain pickable.
 */
export function buildImagePlane(corners: number[][]): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  const verts = new Float32Array([
    ...corners[0], // TL (pixel 0,0)
    ...corners[1], // TR
    ...corners[2], // BR
    ...corners[3], // BL
  ]);
  geometry.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  // UVs: image top (pixel y=0) maps to v=1 so it renders upright.
  geometry.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2)
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0, // invisible until a texture is assigned
  });
  return new THREE.Mesh(geometry, material);
}

/**
 * Metric grid in the XZ plane, always centered on the world origin (0, 0, 0).
 * 1-unit cells; an even, integer size keeps lines on integer world coordinates.
 * Size reaches from the origin out to the farthest point of the scene (plus
 * padding) so a scene offset from the origin is still covered.
 */
export function buildGrid(b: Bounds): THREE.GridHelper {
  const reachX = Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]));
  const reachZ = Math.max(Math.abs(b.min[2]), Math.abs(b.max[2]));
  const size = Math.max(2, Math.ceil(2 * Math.max(reachX, reachZ) * GRID_PADDING));
  // GridHelper is centered at its (default) origin position, in the XZ plane.
  return new THREE.GridHelper(size, size, 0x999999, 0x555555);
}

/** Wireframe box around the given (point-cloud) bounds. */
export function buildBox(b: Bounds): THREE.Box3Helper {
  const box = new THREE.Box3(
    new THREE.Vector3(b.min[0], b.min[1], b.min[2]),
    new THREE.Vector3(b.max[0], b.max[1], b.max[2])
  );
  return new THREE.Box3Helper(box, new THREE.Color(BOX_COLOR));
}

/** Bounds for fit-to-view: prefer the point cloud, fall back to camera centers. */
export function computeLocalBounds(data: ModelData): Bounds {
  if (data.count > 0) {
    return data.bounds;
  }
  if (data.cameras.length > 0) {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const cam of data.cameras) {
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], cam.center[a]);
        max[a] = Math.max(max[a], cam.center[a]);
      }
    }
    return { min, max };
  }
  return { min: [-1, -1, -1], max: [1, 1, 1] };
}

export function diagonalOf(b: Bounds): number {
  return (
    Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1
  );
}

/**
 * The AABB of `b`'s eight corners after `matrix` — how a layer's local bounds read
 * once its own placement (or the root's upright flip) is applied. Axis-aligned in,
 * axis-aligned out, so a rotation grows the box; that is the intent for fit-to-view
 * and the world grid.
 */
export function transformBounds(b: Bounds, matrix: THREE.Matrix4): Bounds {
  const corner = new THREE.Vector3();
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    corner
      .set(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2])
      .applyMatrix4(matrix);
    min[0] = Math.min(min[0], corner.x);
    min[1] = Math.min(min[1], corner.y);
    min[2] = Math.min(min[2], corner.z);
    max[0] = Math.max(max[0], corner.x);
    max[1] = Math.max(max[1], corner.y);
    max[2] = Math.max(max[2], corner.z);
  }
  return { min, max };
}

/** Smallest box containing all given bounds, or a unit box if none. */
export function unionBounds(parts: Bounds[]): Bounds {
  if (parts.length === 0) {
    return { min: [-1, -1, -1], max: [1, 1, 1] };
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of parts) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], b.min[a]);
      max[a] = Math.max(max[a], b.max[a]);
    }
  }
  return { min, max };
}

/** Run `fn` over a mesh's material value — a single material, an array, or absent. */
export function eachMaterial(
  material: THREE.Material | THREE.Material[] | undefined,
  fn: (mat: THREE.Material) => void
): void {
  if (Array.isArray(material)) {
    material.forEach(fn);
  } else if (material) {
    fn(material);
  }
}

/** Detach `obj` from its parent and free its (and descendants') GPU resources. */
export function disposeObject(obj: THREE.Object3D | undefined): void {
  if (!obj) {
    return;
  }
  obj.removeFromParent();
  obj.traverse((child) => {
    const node = child as Partial<THREE.Mesh> & {
      material?: THREE.Material | THREE.Material[];
    };
    node.geometry?.dispose?.();
    eachMaterial(node.material, disposeMaterial);
    // An InstancedMesh (the splat ellipsoids) also owns per-instance matrix/color
    // buffers, which only its own dispose() frees.
    const instanced = child as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      instanced.dispose();
    }
  });
}

/**
 * Dispose a material and every texture it references. `material.dispose()` does
 * NOT free textures (they may be shared), so we dispose each texture-valued
 * property first — not just `.map`, since GLB/PBR meshes also carry
 * normalMap/metalnessMap/roughnessMap/emissiveMap/aoMap, etc.
 */
function disposeMaterial(mat: THREE.Material): void {
  for (const value of Object.values(mat as unknown as Record<string, unknown>)) {
    if (value && (value as THREE.Texture).isTexture) {
      (value as THREE.Texture).dispose();
    }
  }
  mat.dispose();
}
