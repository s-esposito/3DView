// Message contract between the extension host and the webview.
// This is the only module imported by BOTH runtimes, so it must stay free of
// any `vscode`, Node, or DOM/Three.js dependency.

/** A camera placed in world space, with the intrinsics needed to draw a frustum. */
export interface CameraView {
  imageId: number;
  cameraId: number;
  name: string;
  /** Human-readable COLMAP camera model name (e.g. "PINHOLE"). */
  model: string;
  /** Camera center in world coordinates. */
  center: [number, number, number];
  /** World-from-camera rotation R^T, row-major (9 elements). */
  worldFromCamera: number[];
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  /**
   * Webview-resolvable URI of the source image, if it was found on disk.
   * Undefined when no images directory was located or the file is missing.
   */
  imageUri?: string;
}

/** Axis-aligned bounds of the point cloud, for fit-to-view. */
export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * A render-ready model. Typed arrays are sent as-is (VS Code's webview channel
 * structured-clones them — there is no transfer-list arg on `postMessage`).
 * Axes are COLMAP's native frame (+x right, +y down, +z forward); no up-flip.
 */
export interface ModelData {
  count: number;
  positions: Float32Array; // length 3 * count, interleaved xyz
  colors: Uint8Array; // length 3 * count, interleaved rgb
  cameras: CameraView[];
  bounds: Bounds;
}

/**
 * An asset to load in the webview, identified by a webview-resolvable URI. An
 * asset is a mesh (glTF/GLB/OBJ/PLY) or a 3D Gaussian Splatting cloud
 * (.ply / .splat / .spz / .ksplat); the loader is picked by file extension.
 */
export interface AssetRef {
  /** Webview URI of the asset file (mesh siblings resolve relative to it). */
  uri: string;
  /** File name, used for display and to pick a loader by extension. */
  name: string;
}

/** The asset families a host offers separately in its "add" menu and file picker. */
export type AssetKind = "mesh" | "splat" | "tracks";

/** What kind of content the "+" add action should pick — a COLMAP *folder*, an
 *  asset *file* of one family, or a *folder of asset files* (`"assetFolder"`: every
 *  asset in it, offered as one temporal item — the way to load a per-frame capture
 *  where a host's dialog cannot select several files, as VS Code's cannot over a
 *  remote connection). The kind only chooses the picker's filter: what an asset
 *  actually is comes from the file itself (a `.ply` is a mesh or a splat by header),
 *  so picking the "wrong" menu entry still loads the file correctly. */
export type AddKind = "colmap" | AssetKind | "assetFolder";

/**
 * File extensions per asset family — the single source every host filters by.
 * `.ply` appears under both mesh and splat on purpose: the two are told apart by
 * the PLY header, not the name.
 */
export const ASSET_KIND_EXTS: Record<AssetKind, readonly string[]> = {
  mesh: ["glb", "gltf", "obj", "ply"],
  splat: ["ply", "splat", "spz", "ksplat"],
  tracks: ["npz", "npy"],
};

/** Every loadable asset extension, in menu order and without duplicates. */
export const ASSET_EXTS: readonly string[] = [
  ...new Set(Object.values(ASSET_KIND_EXTS).flat()),
];

/** Human-readable name of an asset family, for picker titles and messages. */
export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  mesh: "Mesh",
  splat: "3DGS splat",
  tracks: "3D point tracks",
};

/**
 * One COLMAP model the webview can fetch + parse from URLs — the `loadColmap`
 * payload minus its message `type`. Reused by `chooseColmap` so a host can offer
 * several discovered models (e.g. `sparse/0`, `sparse/1`) for the user to pick.
 */
export interface ColmapModelRef {
  id: string;
  label: string;
  format: "bin" | "txt";
  urls: { cameras: string; images: string; points3d: string };
  imageBaseUrl?: string;
  source?: string;
  // Optional per-image URL map (COLMAP image name or its basename → URL).
  // For hosts that can't serve images under a single base path — e.g. the
  // web demo, which only has opaque blob: URLs. Takes precedence over
  // `imageBaseUrl` when a name resolves in it.
  imageUrls?: Record<string, string>;
}

/**
 * The host ships a parsed model (the VS Code host, which reads the files itself).
 * `source` is an optional file-system path/location for the Scene-list hover
 * tooltip (the host knows it; the webview only has parsed data). Falls back to
 * `label` when absent.
 */
export interface AddReconstructionMsg {
  type: "addReconstruction";
  id: string;
  label: string;
  data: ModelData;
  source?: string;
}

/**
 * Like addReconstruction, but the webview fetches + parses the model itself from
 * URLs the host serves (so the host need not parse or ship a big ModelData). The
 * PyCharm/JCEF host + drag-drop use this.
 */
export type LoadColmapMsg = { type: "loadColmap" } & ColmapModelRef;

/** A mesh / 3DGS splat / point-track file for the webview to load. */
export interface AddAssetMsg {
  type: "addAsset";
  id: string;
  label: string;
  asset: AssetRef;
}

/** One item of a multi-item add — literally the message that would have carried it
 *  alone, so a group member and a lone item take the same path in the webview. */
export type AddItem = AddReconstructionMsg | LoadColmapMsg | AddAssetMsg;

/**
 * Several items added by ONE user action: "load all N models", a multi-file asset
 * pick, a drop of several assets. The webview asks — once, in one modal, for every
 * host — whether they are N scene items or one temporal item; `id` is the scene id
 * that temporal item takes (members keep their own ids when loaded separately), and
 * is what `removed` reports so the host can forget the whole group.
 */
export interface AddGroupMsg {
  type: "addGroup";
  id: string;
  label: string;
  members: AddItem[];
  /** Answer the grouping question in advance, when the host already knows — a host
   *  that discovered the members itself (a per-frame capture directory it walked)
   *  knows they are timesteps, and asking would be a modal in front of content the
   *  user did not choose to assemble. Omitted (the default) still asks, so every
   *  existing host is unchanged. `"cancel"` is deliberately not offerable: it is an
   *  answer to a question, not a way to add nothing. */
  grouping?: GroupingChoice;
}

/** The two ways a multi-item add can resolve. Named as the modal's own answers, so
 *  a host-supplied hint and a user's click are the same value downstream. */
export type GroupingChoice = "temporal" | "separate";

/**
 * Extension host -> webview. A scene holds any number of reconstructions and
 * assets (meshes / splats), each identified by a host-assigned `id` (stable
 * across panel recreations) so the webview can list, toggle, and remove them.
 */
export type HostToWebview =
  | { type: "loading"; message: string }
  | AddItem
  // Several discovered models — the webview shows a chooser so the user loads one,
  // some, or all. Used by the browser hosts (web demo + drag-drop), which lack a
  // native picker; the native hosts (VS Code, PyCharm) choose host-side instead.
  | { type: "chooseColmap"; models: ColmapModelRef[] }
  | AddGroupMsg
  | { type: "error"; message: string };

/** Webview -> extension host. */
export type WebviewToHost =
  | { type: "ready" }
  | { type: "requestAdd"; kind: AddKind } // "+" in the Scene menu
  // A drop the webview could only read as URIs, not bytes — a drag out of the
  // editor's own file explorer. The host owns paths, so it opens them; only a host
  // that advertises `HostBridge.opensUris` is sent this (see dropZone.ts).
  | { type: "openUris"; uris: string[] }
  | { type: "removed"; id: string } // an item was removed from the scene
  // A PNG render of the current viewpoint to save. `png` is a data URL
  // ("data:image/png;base64,…"); the host writes/downloads it.
  | { type: "saveImage"; png: string; suggestedName: string };
