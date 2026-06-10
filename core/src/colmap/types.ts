// Plain data structures for a parsed COLMAP model.
// These are environment-neutral: no `vscode`, no Node-specific types in the
// shapes themselves, so the parsers that produce them are unit-testable in
// isolation (see test/colmap.test.ts).

/** A COLMAP camera (intrinsics). `model` is the numeric COLMAP model id. */
export interface Camera {
  cameraId: number;
  model: number;
  width: number;
  height: number;
  /** Raw model params, length depends on `model` (see PARAMS_PER_MODEL). */
  params: number[];
  // Pinhole intrinsics derived from `params`, for drawing frustums.
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

/**
 * A COLMAP registered image (extrinsics). Pose is stored exactly as COLMAP
 * does: world-to-camera, `qvec` = (qw, qx, qy, qz) Hamilton, `tvec` = (tx,ty,tz).
 * Per-image 2D observations are intentionally dropped — not needed for viewing.
 */
export interface Image {
  imageId: number;
  qvec: [number, number, number, number];
  tvec: [number, number, number];
  cameraId: number;
  name: string;
}

/**
 * The sparse point cloud as flat typed arrays, render-ready.
 * `positions`/`colors` are length `3 * count`, interleaved xyz / rgb.
 * Stored flat (not as objects) so multi-million-point clouds stay cheap and
 * can be handed to the webview as postMessage transferables later.
 */
export interface PointCloud {
  count: number;
  positions: Float32Array;
  colors: Uint8Array;
}

/** A fully parsed COLMAP model: intrinsics by id, images, and the point cloud. */
export interface ColmapModel {
  cameras: Map<number, Camera>;
  images: Image[];
  points: PointCloud;
}

/** On-disk encoding of a model directory. */
export type ColmapFormat = "bin" | "txt";

// COLMAP camera model id -> number of params. (From colmap.github.io/format.html.)
export const PARAMS_PER_MODEL: Record<number, number> = {
  0: 3, // SIMPLE_PINHOLE
  1: 4, // PINHOLE
  2: 4, // SIMPLE_RADIAL
  3: 5, // RADIAL
  4: 8, // OPENCV
  5: 8, // OPENCV_FISHEYE
  6: 12, // FULL_OPENCV
  7: 5, // FOV
  8: 4, // SIMPLE_RADIAL_FISHEYE
  9: 5, // RADIAL_FISHEYE
  10: 12, // THIN_PRISM_FISHEYE
};

// Camera-model name -> id, for the text format (which stores the model name).
export const MODEL_NAME_TO_ID: Record<string, number> = {
  SIMPLE_PINHOLE: 0,
  PINHOLE: 1,
  SIMPLE_RADIAL: 2,
  RADIAL: 3,
  OPENCV: 4,
  OPENCV_FISHEYE: 5,
  FULL_OPENCV: 6,
  FOV: 7,
  SIMPLE_RADIAL_FISHEYE: 8,
  RADIAL_FISHEYE: 9,
  THIN_PRISM_FISHEYE: 10,
};

// Reverse of MODEL_NAME_TO_ID, for display.
const ID_TO_MODEL_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(MODEL_NAME_TO_ID).map(([name, id]) => [id, name])
);

/** Human-readable COLMAP camera-model name for a model id. */
export function modelName(id: number): string {
  return ID_TO_MODEL_NAME[id] ?? `MODEL_${id}`;
}

// Models that store a single shared focal length (fx == fy).
const SINGLE_FOCAL = new Set([0, 2, 3, 7, 8, 9]);

/**
 * Derive pinhole intrinsics (fx, fy, cx, cy) from a model's params.
 * Single-focal models: params = [f, cx, cy, ...]; others: [fx, fy, cx, cy, ...].
 */
export function intrinsicsFromParams(
  model: number,
  params: number[]
): { fx: number; fy: number; cx: number; cy: number } {
  if (SINGLE_FOCAL.has(model)) {
    return { fx: params[0], fy: params[0], cx: params[1], cy: params[2] };
  }
  return { fx: params[0], fy: params[1], cx: params[2], cy: params[3] };
}
