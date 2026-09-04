// Drag-and-drop intake for the viewer. The webview is the universal drop target:
// every host embeds this same Chromium-based bundle. A drop arrives as one of two
// kinds, and they take different routes:
//
//  - BYTES. An OS file/folder drop (from a file manager) exposes readable File
//    bytes in every host, but never a filesystem PATH — a sandboxed webview isn't
//    told one. So we read the bytes into `blob:` URLs and feed the SAME message
//    pipeline the hosts use (`loadColmap` / `addAsset`), converging on
//    `viewer.addReconstruction` / `viewer.addAsset` with no host round-trip.
//  - URIS. A drag out of the editor's own file explorer (or an editor tab) carries
//    `text/uri-list` and no bytes at all. Those URIs are the host's to resolve, so
//    we hand them straight back and it opens them by path (CLAUDE.md has what that
//    buys, and why a remote connection has no other route). Only a host that says
//    it can — `HostBridge.opensUris` — is offered such a drag; the rest see the
//    drag declined, as before. Note for VS Code: such a drop only reaches a webview
//    while SHIFT is held — pointer events on the webview are suppressed mid-drag so
//    the editor group wins the drop (microsoft/vscode#182449, fixed in 1.91).
//
// A dropped folder is recursed via the Chromium entries API; a complete COLMAP
// model (a cameras/images/points3D trio, .bin or .txt, at any depth) loads as a
// reconstruction with its sibling images mapped by basename to blob: URLs; a lone
// recognised file loads as an asset. The path classification is shared with the
// demo host's folder picker via `colmap/grouping.ts` (groupColmapModels).
import type { AddAssetMsg, HostToWebview, ColmapModelRef } from "../shared/messages";
import { ASSET_EXTS, extOf } from "../shared/messages";
import { sharedFolderName } from "../shared/naming";
import { parseUriList, URI_LIST_MIME } from "../shared/uriList";
import { basename, groupColmapModels, isImagePath, type ColmapModelPaths } from "../colmap";

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
 * overlay while a droppable drag is over the page and, on drop, either classifies
 * the dropped bytes and hands a host-shaped message to `onContent` (the same
 * handler the host message channel uses), or — for a drag that carried only URIs —
 * passes those to `onUris` for the host to open by path. Failures (nothing
 * recognised, a read error) are reported as an `error` message through `onContent`.
 */
export function installDropZone(
  onContent: (msg: HostToWebview) => void,
  onUris?: (uris: string[]) => void
): void {
  const overlay = buildOverlay();
  document.body.appendChild(overlay);

  // A URI drag is worth taking only where the host can act on it — otherwise the
  // overlay would light for a drop nothing can complete.
  const droppable = (dt: DataTransfer | null) => hasDroppable(dt, !!onUris);

  // dragenter/dragleave fire for every child element the cursor crosses; a depth
  // counter tells us when the drag has truly entered or left the window.
  let depth = 0;
  const hide = () => {
    depth = 0;
    overlay.classList.remove("active");
  };

  window.addEventListener("dragenter", (e) => {
    if (!droppable(e.dataTransfer)) return;
    e.preventDefault();
    depth++;
    overlay.classList.add("active");
  });
  window.addEventListener("dragover", (e) => {
    if (!droppable(e.dataTransfer)) return;
    e.preventDefault(); // required, or the browser navigates to the file instead of firing `drop`
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (e) => {
    if (!droppable(e.dataTransfer)) return;
    e.preventDefault();
    if (--depth <= 0) hide();
  });
  window.addEventListener("drop", (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault(); // stop the browser from opening the dropped file
    hide();
    void handleDrop(e.dataTransfer, onContent, onUris);
  });
}

/** A drag we might be able to open: it carries file bytes ("Files"), or — where the
 *  host opens paths — the URIs of files it could open for us. Neither payload is
 *  readable mid-drag, the types list is all a dragover gets, so this is what the
 *  overlay is gated on. */
function hasDroppable(dt: DataTransfer | null, acceptsUris: boolean): boolean {
  return !!dt && (dt.types.includes("Files") || (acceptsUris && dt.types.includes(URI_LIST_MIME)));
}

async function handleDrop(
  dt: DataTransfer,
  onContent: (msg: HostToWebview) => void,
  onUris?: (uris: string[]) => void
): Promise<void> {
  try {
    // Read before the first `await`: the DataTransfer is emptied once this handler
    // returns, the same constraint that forces the entry snapshot in gatherFiles.
    const uris = parseUriList(dt.getData(URI_LIST_MIME));
    const types = Array.from(dt.types);
    const files = await gatherFiles(dt);
    if (files.length > 0) {
      // Bytes win over URIs when a drag carries both: an OS drag names paths on the
      // machine running this browser, which over a remote connection is not the
      // machine the host resolves paths against.
      onContent(buildContent(files));
    } else if (onUris && uris.length > 0) {
      // No bytes, but the host owns paths. It reports its own progress and its own
      // failures, so nothing is shown from here.
      onUris(uris);
    } else if (types.includes("Files")) {
      // A file drag whose bytes we couldn't read at all. Staying silent here reads
      // as a broken viewer. (Anything else — dragged text, a link — is ignored.)
      throw new Error(
        `Couldn't read that drop (${types.join(", ")}). Drag from your file manager, or use + in the Scene panel.`
      );
    }
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
  const assets = files.filter((f) => ASSET_EXTS.includes(extOf(f.path)));
  if (assets.length === 1) return buildAsset(assets[0].file);
  if (assets.length > 1) {
    return {
      type: "addGroup",
      id: nextId("group"),
      label: sharedFolderName(assets.map((a) => a.path)) ?? "Dropped files",
      members: assets.map((a) => buildAsset(a.file)),
    };
  }
  throw new Error(
    `Unrecognised drop — expected a COLMAP folder (cameras/images/points3D) or an asset file (${ASSET_EXTS.map((e) => `.${e}`).join(" / ")}).`
  );
}

/** Map every image-like file to a blob: URL keyed by basename (the loader matches a
 *  COLMAP image name, then its basename, so blob: URLs still resolve to frustums). */
function buildImageUrls(files: DroppedFile[]): Record<string, string> {
  const imageUrls: Record<string, string> = {};
  for (const { path, file } of files) {
    if (isImagePath(path)) imageUrls[basename(path)] = URL.createObjectURL(file);
  }
  return imageUrls;
}

/** Shape a located model (paths → its dropped Files) into a ColmapModelRef payload. */
function toColmapRef(
  model: ColmapModelPaths,
  byPath: Map<string, File>,
  imageUrls: Record<string, string>
): ColmapModelRef {
  const label = basename(model.dir) || "COLMAP Model";
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

/** Build an `addAsset` message from a single dropped asset file as a blob: URL. */
function buildAsset(file: File): AddAssetMsg {
  return {
    type: "addAsset",
    id: nextId("asset"),
    label: file.name,
    asset: { uri: URL.createObjectURL(file), name: file.name },
  };
}


/** Full-window drop hint, hidden until a file drag enters the page (`.active`). */
function buildOverlay(): HTMLElement {
  const overlay = document.createElement("div");
  overlay.id = "viewer-drop";
  overlay.className = "viewer-drop";
  const inner = document.createElement("div");
  inner.className = "viewer-drop-inner";
  inner.textContent = "Drop a reconstruction or asset to add it to the scene";
  overlay.append(inner);
  return overlay;
}
