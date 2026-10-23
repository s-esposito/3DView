// The path a "Render video" flies: a reconstruction's cameras in name order (how
// capture sequences are numbered), optionally with frames interpolated between
// neighbours. Pure Three.js math, no DOM or renderer, so it is unit-testable.
import * as THREE from "three";
import type { CameraView } from "../shared/messages";
import { compareNatural } from "../shared/naming";

/** Where a Three.js perspective camera sits on the path, and its vertical FOV (degrees). */
export interface PathPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
}

/** Cameras in the order the path visits them: natural order of their image names. */
export function orderCameras(cameras: readonly CameraView[]): CameraView[] {
  return [...cameras].sort((a, b) => compareNatural(a.name, b.name));
}

/**
 * A reconstruction camera as a Three.js camera pose. `toWorld` is the layer's world
 * matrix (root upright flip + item placement), as for frustum fly-to; `fallbackFov`
 * stands in when the intrinsics don't give a usable one.
 */
export function cameraPose(cam: CameraView, toWorld: THREE.Matrix4, fallbackFov: number): PathPose {
  // worldFromCamera is row-major, so column j is COLMAP camera axis j (x right,
  // y down, z forward) in layer space. A Three camera looks down -Z with +Y up:
  // its basis is (x, -y, -z), still right-handed.
  const m = cam.worldFromCamera;
  const axis = (j: number, sign: number) =>
    new THREE.Vector3(m[j], m[3 + j], m[6 + j]).multiplyScalar(sign).transformDirection(toWorld);
  const basis = new THREE.Matrix4().makeBasis(axis(0, 1), axis(1, -1), axis(2, -1));
  const fov = THREE.MathUtils.radToDeg(2 * Math.atan(cam.height / 2 / cam.fy));
  return {
    position: new THREE.Vector3(...cam.center).applyMatrix4(toWorld),
    quaternion: new THREE.Quaternion().setFromRotationMatrix(basis),
    fov: Number.isFinite(fov) && fov > 1 && fov < 170 ? fov : fallbackFov,
  };
}

/**
 * Frames along a path through `keys`: `steps` per camera-to-camera segment, the
 * first of each exactly at its camera. Positions follow a centripetal Catmull-Rom
 * curve (smooth, no overshoot at uneven spacing); orientation is slerped and FOV
 * lerped between the two cameras. `loop` closes the path back to the first camera
 * (for orbits); otherwise it ends on the last one.
 */
export function samplePath(keys: readonly PathPose[], steps: number, loop: boolean): PathPose[] {
  if (keys.length < 2) {
    return keys.map(clonePose);
  }
  const segments = loop ? keys.length : keys.length - 1;
  const curve = new THREE.CatmullRomCurve3(
    keys.map((k) => k.position),
    loop,
    "centripetal"
  );
  const frames: PathPose[] = [];
  for (let s = 0; s < segments; s++) {
    const a = keys[s];
    const b = keys[(s + 1) % keys.length];
    for (let f = 0; f < steps; f++) {
      const t = f / steps;
      frames.push({
        // getPoint's parameter runs by segment index, so (s + t) / segments is
        // fraction t of the way along segment s.
        position: curve.getPoint((s + t) / segments),
        quaternion: a.quaternion.clone().slerp(b.quaternion, t),
        fov: THREE.MathUtils.lerp(a.fov, b.fov, t),
      });
    }
  }
  if (!loop) {
    frames.push(clonePose(keys[keys.length - 1]));
  }
  return frames;
}

function clonePose(p: PathPose): PathPose {
  return { position: p.position.clone(), quaternion: p.quaternion.clone(), fov: p.fov };
}
