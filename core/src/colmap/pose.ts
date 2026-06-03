// Pose math for COLMAP extrinsics.
//
// COLMAP stores the *world-to-camera* transform: a point X_world maps to the
// camera frame via  X_cam = R * X_world + t, where R comes from `qvec`
// (Hamilton, ordered qw,qx,qy,qz) and t is `tvec`.
//
// For viewing we want the inverse (camera placed in the world):
//   - camera center in world  C = -R^T * t
//   - world-from-camera basis  R^T  (its columns are the camera's x/y/z axes
//     expressed in world coordinates).
//
// We deliberately keep COLMAP's raw axis convention (+x right, +y down,
// +z forward into the scene) — no up-axis flip — per the viewer's design.
import { Image } from "./types";

/** A camera placed in world space, ready to draw as a frustum. */
export interface CameraPose {
  imageId: number;
  name: string;
  cameraId: number;
  /** Camera center in world coordinates. */
  center: [number, number, number];
  /**
   * World-from-camera rotation R^T, row-major (9 elements).
   * Maps a direction in the camera frame to world coordinates.
   */
  worldFromCamera: number[];
}

/**
 * Convert a unit quaternion (qw, qx, qy, qz, Hamilton) to a 3x3 row-major
 * rotation matrix. This is the world-to-camera rotation R.
 */
export function quaternionToRotation(
  qvec: [number, number, number, number]
): number[] {
  let [w, x, y, z] = qvec;
  // Normalize defensively; COLMAP quaternions are unit but may drift slightly.
  const n = Math.hypot(w, x, y, z) || 1;
  w /= n;
  x /= n;
  y /= n;
  z /= n;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
  ];
}

/** Transpose a 3x3 row-major matrix. */
function transpose3(m: number[]): number[] {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** Multiply 3x3 (row-major) by a 3-vector. */
function mul3(m: number[], v: readonly number[]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Place a single COLMAP image in world space. */
export function imageToPose(image: Image): CameraPose {
  const R = quaternionToRotation(image.qvec);
  const Rt = transpose3(R);
  // C = -R^T * t
  const minusT: [number, number, number] = [
    -image.tvec[0],
    -image.tvec[1],
    -image.tvec[2],
  ];
  const center = mul3(Rt, minusT);
  return {
    imageId: image.imageId,
    name: image.name,
    cameraId: image.cameraId,
    center,
    worldFromCamera: Rt,
  };
}

/** Place every image in world space. */
export function imagesToPoses(images: Image[]): CameraPose[] {
  return images.map(imageToPose);
}
