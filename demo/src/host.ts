import type { HostToWebview, WebviewToHost, ColmapModelRef } from "@3dview/core";

// Web host bridge for the GitHub Pages demo: installs window.__viewerHost, opens
// the OS picker for the Scene "+" menu, and hands the webview blob: URLs to fetch.
// All parsing/rendering lives in the core bundle — this host stays thin.

/** Open the OS picker for a COLMAP folder or an asset file; resolves null if cancelled. */
function showFilePicker(kind: "colmap" | "asset"): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (kind === "colmap") {
      // A COLMAP model is a folder (e.g. sparse/0) of cameras/images/points3D.
      // `webkitdirectory` switches the dialog to folder selection; the FileList
      // then holds every file under the chosen folder (each with a
      // `webkitRelativePath`), and it overrides `accept`, so we set none.
      input.webkitdirectory = true;
    } else {
      // Meshes (glTF/GLB/OBJ/PLY) + 3DGS splats (PLY/SPLAT/SPZ/KSPLAT).
      input.accept = ".gltf,.glb,.obj,.ply,.splat,.spz,.ksplat";
    }
    input.addEventListener("change", () => resolve(input.files));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** Install the host bridge on the global object before the webview bundle loads. */
export function installHostBridge() {
  (globalThis as { __viewerHost?: { postMessage(msg: WebviewToHost): void } }).__viewerHost = {
    postMessage(msg: WebviewToHost) {
      // requestAdd (the Scene "+" menu) and saveImage need host action;
      // `ready`/`removed` need none — the demo tracks no scene state.
      if (msg.type === "requestAdd") {
        handleAdd(msg.kind).catch((err) => {
          console.error("[demo host]", err);
          const message = err instanceof Error ? err.message : String(err);
          window.postMessage({ type: "error", message } satisfies HostToWebview, "*");
        });
      } else if (msg.type === "saveImage") {
        // Browsers can download a data URL directly via a synthetic <a download>.
        const a = document.createElement("a");
        a.href = msg.png;
        a.download = msg.suggestedName;
        a.click();
      }
    },
  };
  console.log("[demo host] bridge installed");
}

/** Run the picker for a Scene "+" request and forward the result to the webview. */
async function handleAdd(kind: "colmap" | "asset"): Promise<void> {
  const files = await showFilePicker(kind);
  if (!files || files.length === 0) return; // cancelled / empty
  if (kind === "colmap") sendColmap(files);
  else sendAsset(files);
}

/** A complete COLMAP model located within one directory of the picked folder. */
interface ColmapModel {
  dir: string;
  format: "bin" | "txt";
  cameras: File;
  images: File;
  points3d: File;
}

const MODEL_TRIOS = {
  bin: ["cameras.bin", "images.bin", "points3D.bin"],
  txt: ["cameras.txt", "images.txt", "points3D.txt"],
} as const;

/**
 * Group the picked files by directory and return every dir that holds a complete
 * model (a bin or txt trio), sorted by path. `webkitdirectory` yields every file
 * under the chosen folder, so a `sparse/` with several models (`0/`, `1/`, …)
 * gives multiple candidate dirs — all are returned for the user to choose from.
 * Files are keyed by basename within their own dir, so same-named files in sibling
 * dirs don't collide.
 */
function findColmapModels(files: FileList): ColmapModel[] {
  const byDir = new Map<string, Map<string, File>>();
  for (const file of Array.from(files)) {
    const rel = file.webkitRelativePath || file.name;
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    let group = byDir.get(dir);
    if (!group) byDir.set(dir, (group = new Map()));
    group.set(file.name, file);
  }
  const models: ColmapModel[] = [];
  for (const [dir, group] of byDir) {
    for (const format of ["bin", "txt"] as const) {
      const [cameras, images, points3d] = MODEL_TRIOS[format];
      if (group.has(cameras) && group.has(images) && group.has(points3d)) {
        models.push({
          dir,
          format,
          cameras: group.get(cameras)!,
          images: group.get(images)!,
          points3d: group.get(points3d)!,
        });
        break; // one model per dir (.bin preferred over .txt)
      }
    }
  }
  return models.sort((a, b) => a.dir.localeCompare(b.dir));
}

const IMAGE_EXTENSIONS = /\.(jpe?g|png|bmp|gif|webp|tiff?)$/i;

/**
 * Map every image-like file under the picked folder to a blob URL, keyed by
 * basename. The webview's loader matches COLMAP image names against this (full
 * name, then basename), so frustums get textures despite blob: URLs not being
 * addressable under a single base path. Last file wins on a basename collision —
 * fine for the demo's typical flat `images/` layout.
 */
function buildImageUrls(files: FileList): Record<string, string> {
  const map: Record<string, string> = {};
  for (const file of Array.from(files)) {
    if (IMAGE_EXTENSIONS.test(file.name)) map[file.name] = URL.createObjectURL(file);
  }
  return map;
}

/** Locate the model(s) in the picked folder and post them (+ any images) to the
 *  webview — one `loadColmap`, or a `chooseColmap` chooser when several are found. */
function sendColmap(files: FileList): void {
  const models = findColmapModels(files);
  if (models.length === 0) {
    throw new Error(
      "No COLMAP model in the selected folder — expected a directory with " +
        "(cameras, images, points3D) as .bin or .txt."
    );
  }
  // Images live alongside the model(s); map once and share the blob: URLs across all.
  const imageUrls = buildImageUrls(files);
  const imageCount = Object.keys(imageUrls).length;
  const refs = models.map((model, i) => toColmapRef(model, i, imageUrls));
  const msg: HostToWebview =
    refs.length === 1 ? { type: "loadColmap", ...refs[0] } : { type: "chooseColmap", models: refs };
  window.postMessage(msg, "*");
  console.log(`[demo host] found ${models.length} COLMAP model(s) (${imageCount} image(s))`);
}

/** Shape a located model into a ColmapModelRef (the loadColmap/chooseColmap payload). */
function toColmapRef(
  model: ColmapModel,
  index: number,
  imageUrls: Record<string, string>
): ColmapModelRef {
  return {
    id: `colmap-${Date.now()}-${index}`,
    label: model.dir.split("/").pop() || "COLMAP Model",
    source: model.dir,
    format: model.format,
    urls: {
      cameras: URL.createObjectURL(model.cameras),
      images: URL.createObjectURL(model.images),
      points3d: URL.createObjectURL(model.points3d),
    },
    // Per-image blob URLs keyed by basename; omitted when no images were found.
    imageUrls: Object.keys(imageUrls).length > 0 ? imageUrls : undefined,
  };
}

/** Post the first picked asset file (mesh or splat) to the webview as a blob URL. */
function sendAsset(files: FileList): void {
  const asset = files[0];
  window.postMessage(
    {
      type: "addAsset",
      id: `asset-${Date.now()}`,
      label: asset.name,
      asset: { uri: URL.createObjectURL(asset), name: asset.name },
    } satisfies HostToWebview,
    "*"
  );
  console.log(`[demo host] loaded asset ${asset.name}`);
}
