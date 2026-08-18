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
// recognised file loads as an asset. The path classification is shared with the
// demo host's folder picker via `colmap/grouping.ts` (groupColmapModels).
import type { AddAssetMsg, HostToWebview, ColmapModelRef } from "../shared/messages";
import { ASSET_EXTS } from "../shared/messages";
import { groupColmapModels, isImagePath, type ColmapModelPaths } from "../colmap";

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
    if (files.length === 0) {
      // A drag with no readable bytes. Silence here reads as "the viewer is broken",
      // and the usual cause has a workaround worth naming: a drag out of the VS Code
      // Explorer never reaches a webview at all (microsoft/vscode#182449), and over a
      // remote connection those files aren't on this machine to read anyway.
      if (Array.from(dt.types).includes("Files")) {
        throw new Error(
          "Couldn't read that drop. Dragging from the editor's file explorer doesn't reach the viewer — drag from your desktop file manager instead, or use + in the Scene panel."
        );
      }
      return; // not a file drag at all (e.g. dragged text) — ignore
    }
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

/** Classify the dropped files into COLMAP reconstruction(s) or asset file(s) (else throw). */
function buildContent(files: DroppedFile[]): HostToWebview {
  // A COLMAP model in the drop wins outright: a real reconstruction tree routinely
  // holds meshes too (dense/fused.ply, meshed-poisson.ply), and loading those
  // alongside it would be slow and surprising. Drop them on their own to see them.
  const models = groupColmapModels(files.map((f) => f.path));
  if (models.length > 0) {
    const byPath = new Map(files.map((f) => [f.path, f.file]));
    // Images live alongside the model(s) under one folder; map them once and share
    // the blob: URLs across every model (the webview keys frustum textures by name).
    const imageUrls = buildImageUrls(files);
    const refs = models.map((m) => toColmapRef(m, byPath, imageUrls));
    return refs.length === 1
      ? { type: "loadColmap", ...refs[0] }
      : { type: "chooseColmap", models: refs };
  }
  // Every asset in the drop, not just the first: dropping a folder of per-frame
  // splats is how a temporal item is meant to arrive.
  const assets = files.filter((f) => ASSET_EXTS.includes(ext(f.path)));
  if (assets.length === 1) return buildAsset(assets[0].file);
  if (assets.length > 1) {
    return {
      type: "addGroup",
      id: nextId("group"),
      label: commonFolder(assets.map((a) => a.path)),
      members: assets.map((a) => buildAsset(a.file)),
    };
  }
  throw new Error(
    `Unrecognised drop — expected a COLMAP folder (cameras/images/points3D) or an asset file (${ASSET_EXTS.map((e) => `.${e}`).join(" / ")}).`
  );
}

/** The folder the dropped files share, as a name for the group they form. */
function commonFolder(paths: string[]): string {
  const dir = paths[0].split("/").slice(0, -1);
  for (const path of paths) {
    const parts = path.split("/").slice(0, -1);
    while (dir.length > 0 && parts.slice(0, dir.length).join("/") !== dir.join("/")) {
      dir.pop();
    }
  }
  return dir.pop() || "Dropped files";
}

/** Map every image-like file to a blob: URL keyed by basename (the loader matches a
 *  COLMAP image name, then its basename, so blob: URLs still resolve to frustums). */
function buildImageUrls(files: DroppedFile[]): Record<string, string> {
  const imageUrls: Record<string, string> = {};
  for (const { path, file } of files) {
    if (isImagePath(path)) imageUrls[path.split("/").pop()!] = URL.createObjectURL(file);
  }
  return imageUrls;
}

/** Shape a located model (paths → its dropped Files) into a ColmapModelRef payload. */
function toColmapRef(
  model: ColmapModelPaths,
  byPath: Map<string, File>,
  imageUrls: Record<string, string>
): ColmapModelRef {
  const label = model.dir.split("/").pop() || "COLMAP Model";
  return {
    id: nextId("colmap"),
    label,
    source: model.dir || label,
    format: model.format,
    urls: {
      cameras: URL.createObjectURL(byPath.get(model.cameras)!),
      images: URL.createObjectURL(byPath.get(model.images)!),
      points3d: URL.createObjectURL(byPath.get(model.points3d)!),
    },
    imageUrls: Object.keys(imageUrls).length > 0 ? imageUrls : undefined,
  };
}

/** Build an `addAsset` message from a single dropped file (mesh or splat) as a blob: URL. */
function buildAsset(file: File): AddAssetMsg {
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
