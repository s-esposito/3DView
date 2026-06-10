// Drag-and-drop intake for the viewer. The webview is the universal drop target:
// every host embeds this same Chromium-based bundle, and an OS file/folder drop
// exposes readable File bytes in all of them (VS Code's sandboxed webview, the
// demo page, PyCharm/JCEF). The filesystem PATH is NOT exposed in a sandboxed
// webview, and Explorer-to-webview drops don't fire at all (microsoft/vscode#182449),
// so we can't route a drop through a host's path-based loader. Instead we read the
// dropped bytes into `blob:` URLs and feed the SAME message pipeline the hosts use
// (`loadColmap` / `addAsset`), so a drop converges on `viewer.addReconstruction` /
// `viewer.addAsset` with no host round-trip. (Path-based opening, Recents, and
// on-demand image streaming remain available via the host pickers and the VS Code
// Recents tree, which can see real paths.)
//
// A dropped folder is recursed via the Chromium entries API; a complete COLMAP
// model (a cameras/images/points3D trio, .bin or .txt, at any depth) loads as a
// reconstruction with its sibling images mapped by basename to blob: URLs; a lone
// recognised file loads as an asset. The classification mirrors the demo host's
// picker (demo/src/host.ts), which does the same for `<input webkitdirectory>`.
import type { HostToWebview } from "../shared/messages";

/** Asset extensions we can load (meshes + 3DGS splats); mirrors each host's picker filter. */
const ASSET_EXTS = ["glb", "gltf", "obj", "ply", "splat", "spz", "ksplat"];
const IMAGE_EXTENSIONS = /\.(jpe?g|png|bmp|gif|webp|tiff?)$/i;
const MODEL_TRIOS = {
  bin: ["cameras.bin", "images.bin", "points3D.bin"],
  txt: ["cameras.txt", "images.txt", "points3D.txt"],
} as const;

// A dropped file with its path relative to the drop (folders recursed); the path's
// directory groups files into candidate COLMAP models.
interface DroppedFile {
  path: string; // e.g. "scene/sparse/0/cameras.bin" (or just "model.glb")
  file: File;
}

// Webview-generated ids for dropped content. The host doesn't assign these (the
// drop never reaches it), but they only need to be unique within the scene: blob:
// content needs no new localResourceRoots, so it never forces a panel recreate.
let counter = 0;
const nextId = (kind: string) => `dnd-${kind}-${++counter}`;

/**
 * Install the viewer's drag-and-drop target on `window`. Shows a full-window
 * overlay while a file drag is over the page and, on drop, classifies the content
 * and hands a host-shaped message to `onContent` (the same handler the host
 * message channel uses). Failures (nothing recognised, a read error) are reported
 * as an `error` message through the same channel.
 */
export function installDropZone(onContent: (msg: HostToWebview) => void): void {
  const overlay = buildOverlay();
  document.body.appendChild(overlay);

  // dragenter/dragleave fire for every child element the cursor crosses; a depth
  // counter tells us when the drag has truly entered or left the window.
  let depth = 0;
  const hide = () => {
    depth = 0;
    overlay.classList.remove("active");
  };

  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.classList.add("active");
  });
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // required, or the browser navigates to the file instead of firing `drop`
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (--depth <= 0) hide();
  });
  window.addEventListener("drop", (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault(); // stop the browser from opening the dropped file
    hide();
    void handleDrop(e.dataTransfer, onContent);
  });
}

/** A drag carries files when its types list includes "Files" (DataTransfer.files is
 *  empty mid-drag — it's only populated on `drop` — so we can't test that here). */
function hasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
}

async function handleDrop(
  dt: DataTransfer,
  onContent: (msg: HostToWebview) => void
): Promise<void> {
  try {
    const files = await gatherFiles(dt);
    if (files.length === 0) return; // not a file drop (e.g. dragged text) — ignore
    onContent(buildContent(files));
  } catch (err) {
    onContent({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Collect every dropped file, recursing folders via the Chromium entries API
 * (`webkitGetAsEntry`). The entry handles must be grabbed synchronously — the
 * DataTransferItemList is emptied once the drop handler returns — so we snapshot
 * them before the first `await`. Falls back to the flat `DataTransfer.files` if
 * entries are unavailable. Each result carries its path relative to the drop.
 */
async function gatherFiles(dt: DataTransfer): Promise<DroppedFile[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) {
    return Array.from(dt.files).map((file) => ({ path: file.name, file }));
  }
  const out: DroppedFile[] = [];
  for (const entry of entries) {
    await walkEntry(entry, "", out);
  }
  return out;
}

/** Recurse a file/directory entry, appending each contained file (with its path) to `out`. */
async function walkEntry(entry: FileSystemEntry, prefix: string, out: DroppedFile[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject)
    );
    out.push({ path, file });
    return;
  }
  if (entry.isDirectory) {
    for (const child of await readDir(entry as FileSystemDirectoryEntry)) {
      await walkEntry(child, path, out);
    }
  }
}

/** Read all of a directory's entries; `readEntries` returns in batches, so loop until empty. */
function readDir(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

/** Classify the dropped files into a COLMAP reconstruction or a single asset (else throw). */
function buildContent(files: DroppedFile[]): HostToWebview {
  const model = findColmapModel(files);
  if (model) return buildColmap(model, files);
  const asset = files.find((f) => ASSET_EXTS.includes(ext(f.path)));
  if (asset) return buildAsset(asset.file);
  throw new Error(
    `Unrecognised drop — expected a COLMAP folder (cameras/images/points3D) or an asset file (${ASSET_EXTS.map((e) => `.${e}`).join(" / ")}).`
  );
}

/** A complete COLMAP model located within one directory of the dropped content. */
interface ColmapModel {
  dir: string;
  format: "bin" | "txt";
  cameras: File;
  images: File;
  points3d: File;
}

/**
 * Group files by their directory and return the first dir holding a complete model
 * (a .bin or .txt trio), at any depth. Mirrors demo/src/host.ts: a dropped project
 * folder with `sparse/0/{cameras,images,points3D}` resolves here; with several
 * models (`0/`, `1/`, …) we take the first complete one.
 */
function findColmapModel(files: DroppedFile[]): ColmapModel | null {
  const byDir = new Map<string, Map<string, File>>();
  for (const { path, file } of files) {
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash) : "";
    const base = slash >= 0 ? path.slice(slash + 1) : path;
    let group = byDir.get(dir);
    if (!group) byDir.set(dir, (group = new Map()));
    group.set(base, file);
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

/** Build a `loadColmap` message from a located model, mapping sibling images to blob: URLs. */
function buildColmap(model: ColmapModel, files: DroppedFile[]): HostToWebview {
  const imageUrls: Record<string, string> = {};
  for (const { path, file } of files) {
    // Key by basename: the loader matches a COLMAP image name, then its basename,
    // so blob: URLs (not addressable under a base path) still resolve to frustums.
    if (IMAGE_EXTENSIONS.test(path)) imageUrls[path.split("/").pop()!] = URL.createObjectURL(file);
  }
  const hasImages = Object.keys(imageUrls).length > 0;
  const label = model.dir.split("/").pop() || "COLMAP Model";
  return {
    type: "loadColmap",
    id: nextId("colmap"),
    label,
    source: model.dir || label,
    format: model.format,
    urls: {
      cameras: URL.createObjectURL(model.cameras),
      images: URL.createObjectURL(model.images),
      points3d: URL.createObjectURL(model.points3d),
    },
    imageUrls: hasImages ? imageUrls : undefined,
  };
}

/** Build an `addAsset` message from a single dropped file (mesh or splat) as a blob: URL. */
function buildAsset(file: File): HostToWebview {
  return {
    type: "addAsset",
    id: nextId("asset"),
    label: file.name,
    asset: { uri: URL.createObjectURL(file), name: file.name },
  };
}

function ext(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/** Full-window drop hint, hidden until a file drag enters the page (`.active`). */
function buildOverlay(): HTMLElement {
  const overlay = document.createElement("div");
  overlay.id = "viewer-drop";
  overlay.className = "viewer-drop";
  const inner = document.createElement("div");
  inner.className = "viewer-drop-inner";
  inner.textContent = "Drop a file or a COLMAP folder to add it to the scene";
  overlay.append(inner);
  return overlay;
}
