import type { HostToWebview, WebviewToHost } from "@3dviewer/core";

// Web host bridge for the GitHub Pages demo: installs window.__viewerHost, opens
// the OS picker for the Scene "+" menu, and hands the webview blob: URLs to fetch.
// All parsing/rendering lives in the core bundle — this host stays thin.

/** Open the OS picker for a COLMAP folder or a mesh file; resolves null if cancelled. */
function showFilePicker(kind: "colmap" | "mesh"): Promise<FileList | null> {
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
      input.accept = ".gltf,.glb,.obj,.ply";
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
      // requestAdd (the Scene "+" menu) is the only message needing host action;
      // `ready`/`removed` need none — the demo tracks no scene state.
      if (msg.type === "requestAdd") {
        handleAdd(msg.kind).catch((err) => {
          console.error("[demo host]", err);
          const message = err instanceof Error ? err.message : String(err);
          window.postMessage({ type: "error", message } satisfies HostToWebview, "*");
        });
      }
    },
  };
  console.log("[demo host] bridge installed");
}

/** Run the picker for a Scene "+" request and forward the result to the webview. */
async function handleAdd(kind: "colmap" | "mesh"): Promise<void> {
  const files = await showFilePicker(kind);
  if (!files || files.length === 0) return; // cancelled / empty
  if (kind === "colmap") sendColmap(files);
  else sendMesh(files);
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
 * Group the picked files by directory and return the first that holds a complete
 * model (a bin or txt trio). `webkitdirectory` yields every file under the chosen
 * folder, so a `sparse/` with several models (`0/`, `1/`, …) gives multiple
 * candidate dirs; we take the first complete one. Files are keyed by basename
 * within their own dir, so same-named files in sibling dirs don't collide.
 */
function findColmapModel(files: FileList): ColmapModel | null {
  const byDir = new Map<string, Map<string, File>>();
  for (const file of Array.from(files)) {
    const rel = file.webkitRelativePath || file.name;
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    let group = byDir.get(dir);
    if (!group) byDir.set(dir, (group = new Map()));
    group.set(file.name, file);
  }
  for (const [dir, group] of byDir) {
    for (const format of ["bin", "txt"] as const) {
      const [cameras, images, points3d] = MODEL_TRIOS[format];
      if (group.has(cameras) && group.has(images) && group.has(points3d)) {
        return {
          dir,
          format,
          cameras: group.get(cameras)!,
          images: group.get(images)!,
          points3d: group.get(points3d)!,
        };
      }
    }
  }
  return null;
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

/** Locate the model in the picked folder and post it (+ any images) to the webview. */
function sendColmap(files: FileList): void {
  const model = findColmapModel(files);
  if (!model) {
    throw new Error(
      "No COLMAP model in the selected folder — expected a directory with " +
        "(cameras, images, points3D) as .bin or .txt."
    );
  }
  const imageUrls = buildImageUrls(files);
  const imageCount = Object.keys(imageUrls).length;
  window.postMessage(
    {
      type: "loadColmap",
      id: `colmap-${Date.now()}`,
      label: model.dir.split("/").pop() || "COLMAP Model",
      format: model.format,
      urls: {
        cameras: URL.createObjectURL(model.cameras),
        images: URL.createObjectURL(model.images),
        points3d: URL.createObjectURL(model.points3d),
      },
      // Per-image blob URLs keyed by basename; omitted when no images were found.
      imageUrls: imageCount > 0 ? imageUrls : undefined,
    } satisfies HostToWebview,
    "*"
  );
  console.log(`[demo host] loaded COLMAP model (${imageCount} frustum image(s))`);
}

/** Post the first picked mesh file to the webview as a blob URL. */
function sendMesh(files: FileList): void {
  const mesh = files[0];
  window.postMessage(
    {
      type: "addMesh",
      id: `mesh-${Date.now()}`,
      label: mesh.name,
      mesh: { uri: URL.createObjectURL(mesh), name: mesh.name },
    } satisfies HostToWebview,
    "*"
  );
  console.log(`[demo host] loaded mesh ${mesh.name}`);
}
