// In-browser COLMAP loader. Given URLs for a model's three files, fetch them and
// run the pure parsers (from the host-agnostic `colmap/` library) to build the
// render-ready ModelData — entirely in the webview. This lets a host hand over
// plain URLs instead of a parsed model, so the host never re-implements parsing
// and never serializes large typed arrays across its message bridge.
import {
  parseCamerasBin,
  parseCamerasText,
  parseImagesBin,
  parseImagesText,
  parsePoints3DBin,
  parsePoints3DText,
  imagesToPoses,
  modelName,
  computeBounds,
} from "../colmap";
import type { CameraView, ModelData } from "../shared/messages";

/** URLs of a COLMAP model's three files (same origin/scheme the host serves). */
export interface ColmapUrls {
  cameras: string;
  images: string;
  points3d: string;
}

/**
 * Fetch + parse a COLMAP model from URLs, producing the same `ModelData` the VS
 * Code host builds in `host/modelData.ts`. Each camera's `imageUri` is resolved
 * (in priority order) from `imageUrls` — a per-name/basename URL map, for hosts
 * with opaque URLs like the demo's blob: URLs — then from `imageBaseUrl`, built
 * as `<imageBaseUrl>/<name>` (per-segment encoded). The host serving URLs is
 * responsible for guarding path escapes.
 */
export async function loadColmapFromUrls(
  urls: ColmapUrls,
  format: "bin" | "txt",
  imageBaseUrl?: string,
  imageUrls?: Record<string, string>
): Promise<ModelData> {
  const model =
    format === "bin"
      ? await (async () => {
          const [cam, img, pts] = await Promise.all([
            fetchBytes(urls.cameras),
            fetchBytes(urls.images),
            fetchBytes(urls.points3d),
          ]);
          return {
            cameras: parseCamerasBin(cam),
            images: parseImagesBin(img),
            points: parsePoints3DBin(pts),
          };
        })()
      : await (async () => {
          const [cam, img, pts] = await Promise.all([
            fetchText(urls.cameras),
            fetchText(urls.images),
            fetchText(urls.points3d),
          ]);
          return {
            cameras: parseCamerasText(cam),
            images: parseImagesText(img),
            points: parsePoints3DText(pts),
          };
        })();

  const cameras: CameraView[] = [];
  for (const pose of imagesToPoses(model.images)) {
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
      imageUri: resolveImageUri(pose.name, imageUrls, imageBaseUrl),
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

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url} (${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url} (${res.status})`);
  }
  return res.text();
}

/**
 * Resolve a camera image's URL. Prefer an explicit `imageUrls` entry — matched
 * by full COLMAP name, then by basename (hosts with opaque blob: URLs key the
 * map by basename) — otherwise fall back to `<imageBaseUrl>/<name>`.
 */
function resolveImageUri(
  name: string,
  imageUrls?: Record<string, string>,
  imageBaseUrl?: string
): string | undefined {
  if (imageUrls) {
    const direct = imageUrls[name];
    if (direct) return direct;
    const base = name.split("/").pop();
    if (base && imageUrls[base]) return imageUrls[base];
  }
  return imageBaseUrl ? imageUrl(imageBaseUrl, name) : undefined;
}

/** Join an image name onto a base URL, encoding each path segment (keeps subdirs). */
function imageUrl(baseUrl: string, name: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const segments = name.split("/").map(encodeURIComponent).join("/");
  return `${base}/${segments}`;
}
