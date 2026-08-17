// Pure Three.js geometry builders and small scene-math helpers. No state, no
// DOM — everything here takes data in and returns objects/values out, so each
// piece is easy to read, reuse, and reason about.
import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { ModelData, CameraView, Bounds } from "../shared/messages";

// Default frustum wireframe color (RGB 0.423, 0.5568, 0.7490 → 8-bit). The Scene
// panel's "Frustum color" picker overrides it per session via Viewer.setFrustumColor.
export const FRUSTUM_COLOR = 0x6c8ebf;
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

/**
 * Frustum wireframe: apex -> each corner, then the image-plane rectangle. Drawn as
 * a Spark-independent "fat line" (LineSegments2) so `linewidth` actually takes
 * effect — plain WebGL ignores LineBasicMaterial.linewidth — giving the frustums a
 * thicker, more solid, 3D read. `linewidth` is in screen pixels (worldUnits: false);
 * the material's resolution is kept in sync automatically by LineSegments2's
 * onBeforeRender (from the renderer viewport), so callers needn't manage it.
 */
export function buildFrustumLines(
  center: number[],
  corners: number[][],
  color: number,
  linewidth: number
): LineSegments2 {
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
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(seg);
  const material = new LineMaterial({
    color,
    linewidth,
    worldUnits: false, // linewidth in screen px: constant thickness at any zoom
    alphaToCoverage: true, // smooth edges (the renderer is antialiased)
  });
  return new LineSegments2(geometry, material);
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
    opacity: 0, // invisible until a texture is assigned (opacity is the show/hide gate)
  });
  patchImagePlaneAlpha(material);
  return new THREE.Mesh(geometry, material);
}

/** Opacity floor for an image's fully-transparent pixels (image alpha 0). */
const IMAGE_ALPHA_FLOOR = 0.5;

/**
 * Remap how an image plane blends by the image's own alpha, per-pixel: opaque
 * pixels (image alpha 1) keep their color at full opacity; fully-transparent
 * pixels (image alpha 0) become white at `IMAGE_ALPHA_FLOOR` opacity; in between
 * interpolates. So a masked-out (transparent) region reads as a faint white fill
 * instead of vanishing. The material's `opacity` stays the load/evict show-hide
 * gate (1 shown, 0 hidden) and multiplies the result. Patched via onBeforeCompile
 * so MeshBasicMaterial keeps doing the sRGB decode/encode (the sampler returns
 * linear, and `vec3(1.0)` is white in linear too).
 */
function patchImagePlaneAlpha(material: THREE.MeshBasicMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `#ifdef USE_MAP
        vec4 imgTexel = texture2D( map, vMapUv );
        diffuseColor.rgb = mix( vec3( 1.0 ), imgTexel.rgb, imgTexel.a );
        diffuseColor.a = mix( ${IMAGE_ALPHA_FLOOR.toFixed(2)}, 1.0, imgTexel.a ) * opacity;
      #endif`
    );
  };
  // Give the patched shader its own program bucket so it never shares a compiled
  // program with an unpatched MeshBasicMaterial of the same parameters.
  material.customProgramCacheKey = () => "frustum-image-plane-alpha";
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

// How far a frustum reaches toward the nearest thing its camera sees. Picked so
// that on an object-centric capture — cameras about one scene-diameter out, the
// common case — the result still lands inside the slider's own 0.16·diagonal range
// instead of pinned at its maximum.
const NEAR_FRACTION = 0.15;
// The near depth is read off a low quantile, at both levels of frustumScaleFromDepth
// and for the same reason at each: within one camera it stops a single stray point
// in the foreground setting the depth, and across cameras it degrades to (near-)the
// minimum at any realistic camera count, which is the camera that matters.
const NEAR_QUANTILE = 0.05;
// Every point is projected into every camera, so the cost is a product and a big
// model (10^6 points × 10^3 cameras) would stall the load. A strided sample of the
// cloud caps it; the quantile of a few thousand depths lands in the same place.
const MAX_PROJECTIONS = 2_000_000;

/** `sorted[q]` by fraction, clamped — a percentile without the interpolation. */
function quantile(sorted: ArrayLike<number>, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/**
 * How deep to draw the camera frustums, in world units; 0 when the model gives
 * nothing to measure (no cloud, or cameras pointed away from it).
 *
 * Sized from what the cameras SEE rather than from the scene's overall extent: a
 * frustum should take up a fixed fraction of the free space in front of its
 * camera, so it stays legible on a tabletop capture and an outdoor one alike and
 * never pokes through the geometry it is looking at. A scene-diagonal rule gets
 * this wrong in both directions — one far background point shrinks every frustum,
 * and a camera standing close to the subject gets one that buries it.
 *
 * Per camera: project the cloud in, keep the points that are in front of it and
 * inside the image, and take the near depth of those. Then take the near depth
 * again ACROSS cameras, because one scale is drawn for all of them and the
 * tightest camera is the one that would intersect.
 */
export function frustumScaleFromDepth(data: ModelData): number {
  if (data.count === 0 || data.cameras.length === 0) {
    return 0;
  }
  const stride = Math.max(
    1,
    Math.ceil((data.count * data.cameras.length) / MAX_PROJECTIONS)
  );
  // Refilled per camera, so the depths sort natively (no comparator) in one buffer.
  const depths = new Float64Array(Math.ceil(data.count / stride));
  const nears: number[] = [];
  for (const cam of data.cameras) {
    // Row-major camera->world (see frustumCorners); its transpose takes a world
    // offset back into the camera frame, so row i of the transpose is column i here.
    const m = cam.worldFromCamera;
    let seen = 0;
    for (let i = 0; i < data.count; i += stride) {
      const dx = data.positions[i * 3] - cam.center[0];
      const dy = data.positions[i * 3 + 1] - cam.center[1];
      const dz = data.positions[i * 3 + 2] - cam.center[2];
      const z = m[2] * dx + m[5] * dy + m[8] * dz;
      if (z <= 0) {
        continue; // behind the camera
      }
      const u = (cam.fx * (m[0] * dx + m[3] * dy + m[6] * dz)) / z + cam.cx;
      const v = (cam.fy * (m[1] * dx + m[4] * dy + m[7] * dz)) / z + cam.cy;
      if (u < 0 || u > cam.width || v < 0 || v > cam.height) {
        continue; // outside the image
      }
      depths[seen++] = z;
    }
    if (seen > 0) {
      const imaged = depths.subarray(0, seen);
      imaged.sort();
      nears.push(quantile(imaged, NEAR_QUANTILE));
    }
  }
  if (nears.length === 0) {
    return 0;
  }
  nears.sort((a, b) => a - b);
  return NEAR_FRACTION * quantile(nears, NEAR_QUANTILE);
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
