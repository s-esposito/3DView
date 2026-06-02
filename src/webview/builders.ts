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
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  // Uint8 rgb, normalized to 0..1 in the shader.
  geometry.setAttribute("color", new THREE.BufferAttribute(data.colors, 3, true));
  const material = new THREE.PointsMaterial({
    size: pointSize,
    vertexColors: true,
    sizeAttenuation: false,
  });
  return new THREE.Points(geometry, material);
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

/** Metric grid in the XZ plane: 1-unit cells, lines on integer world coords. */
export function buildGrid(b: Bounds): THREE.GridHelper {
  const extentX = b.max[0] - b.min[0];
  const extentZ = b.max[2] - b.min[2];
  const size = Math.max(2, Math.ceil(Math.max(extentX, extentZ) * GRID_PADDING));
  const grid = new THREE.GridHelper(size, size, 0x999999, 0x555555);
  const cx = Math.round((b.min[0] + b.max[0]) / 2);
  const cz = Math.round((b.min[2] + b.max[2]) / 2);
  grid.position.set(cx, b.min[1], cz);
  return grid;
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
    const mats = Array.isArray(node.material)
      ? node.material
      : node.material
        ? [node.material]
        : [];
    for (const mat of mats) {
      (mat as THREE.MeshBasicMaterial).map?.dispose?.();
      mat.dispose();
    }
  });
}
