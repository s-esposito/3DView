// Shape a parsed COLMAP model into the render-ready `ModelData` the webview
// consumes. Pure (no `vscode`), so it can be unit-tested alongside the parser.
import { loadModel, imagesToPoses, modelName } from "../colmap";
import type { CameraView, ModelData, Bounds } from "../shared/messages";

/** Parse the model at `dir` and shape it for the webview. */
export function buildModelData(dir: string): ModelData {
  const model = loadModel(dir);
  const poses = imagesToPoses(model.images);

  const cameras: CameraView[] = [];
  for (const pose of poses) {
    const cam = model.cameras.get(pose.cameraId);
    if (!cam) {
      continue; // image references a camera we don't have; skip its frustum
    }
    cameras.push({
      imageId: pose.imageId,
      cameraId: pose.cameraId,
      name: pose.name,
      model: modelName(cam.model),
      center: pose.center,
      worldFromCamera: pose.worldFromCamera,
      fx: cam.fx,
      fy: cam.fy,
      cx: cam.cx,
      cy: cam.cy,
      width: cam.width,
      height: cam.height,
    });
  }

  return {
    count: model.points.count,
    positions: model.points.positions,
    colors: model.points.colors,
    cameras,
    bounds: computeBounds(model.points.positions),
  };
}

/** Axis-aligned bounds over an interleaved xyz position array. */
export function computeBounds(positions: Float32Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) {
        min[a] = v;
      }
      if (v > max[a]) {
        max[a] = v;
      }
    }
  }
  // Empty cloud: fall back to a unit box so downstream math stays finite.
  if (!Number.isFinite(min[0])) {
    return { min: [-1, -1, -1], max: [1, 1, 1] };
  }
  return { min, max };
}
