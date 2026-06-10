import type { HostToWebview, WebviewToHost, ColmapModelRef, ColmapModelPaths } from "@3dview/core";
import { groupColmapModels, isImagePath } from "@3dview/core";

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

/** A picked file's path relative to the chosen folder (the key the grouping uses). */
const pathOf = (f: File) => f.webkitRelativePath || f.name;

/**
 * Map every image-like file under the picked folder to a blob URL, keyed by
 * basename. The webview's loader matches COLMAP image names against this (full
 * name, then basename), so frustums get textures despite blob: URLs not being
 * addressable under a single base path. Last file wins on a basename collision —
 * fine for the demo's typical flat `images/` layout.
 */
function buildImageUrls(files: File[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const file of files) {
    if (isImagePath(file.name)) map[file.name] = URL.createObjectURL(file);
  }
  return map;
}

/** Locate the model(s) in the picked folder and post them (+ any images) to the
 *  webview — one `loadColmap`, or a `chooseColmap` chooser when several are found.
 *  Path classification is shared with drag-and-drop via core's `groupColmapModels`. */
function sendColmap(files: FileList): void {
  const list = Array.from(files);
  const models = groupColmapModels(list.map(pathOf));
  if (models.length === 0) {
    throw new Error(
      "No COLMAP model in the selected folder — expected a directory with " +
        "(cameras, images, points3D) as .bin or .txt."
    );
  }
  const byPath = new Map(list.map((f) => [pathOf(f), f]));
  // Images live alongside the model(s); map once and share the blob: URLs across all.
  const imageUrls = buildImageUrls(list);
  const imageCount = Object.keys(imageUrls).length;
  const refs = models.map((model, i) => toColmapRef(model, i, byPath, imageUrls));
  const msg: HostToWebview =
    refs.length === 1 ? { type: "loadColmap", ...refs[0] } : { type: "chooseColmap", models: refs };
  window.postMessage(msg, "*");
  console.log(`[demo host] found ${models.length} COLMAP model(s) (${imageCount} image(s))`);
}

/** Shape a located model (paths → its picked Files) into a ColmapModelRef payload. */
function toColmapRef(
  model: ColmapModelPaths,
  index: number,
  byPath: Map<string, File>,
  imageUrls: Record<string, string>
): ColmapModelRef {
  return {
    id: `colmap-${Date.now()}-${index}`,
    label: model.dir.split("/").pop() || "COLMAP Model",
    source: model.dir,
    format: model.format,
    urls: {
      cameras: URL.createObjectURL(byPath.get(model.cameras)!),
      images: URL.createObjectURL(byPath.get(model.images)!),
      points3d: URL.createObjectURL(byPath.get(model.points3d)!),
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
