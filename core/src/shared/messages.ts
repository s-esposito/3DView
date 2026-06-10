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

/** What kind of content the "+" add action should pick. */
export type AddKind = "colmap" | "asset";

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
 * Extension host -> webview. A scene holds any number of reconstructions and
 * assets (meshes / splats), each identified by a host-assigned `id` (stable
 * across panel recreations) so the webview can list, toggle, and remove them.
 */
export type HostToWebview =
  | { type: "loading"; message: string }
  // `source` is an optional file-system path/location for the Scene-list hover
  // tooltip (the host knows it; the webview only has parsed data). Falls back to
  // `label` when absent.
  | { type: "addReconstruction"; id: string; label: string; data: ModelData; source?: string }
  // Like addReconstruction, but the webview fetches + parses the model itself from
  // URLs the host serves (so the host need not parse or ship a big ModelData). The
  // VS Code host uses addReconstruction; the PyCharm/JCEF host + drag-drop use this.
  | ({ type: "loadColmap" } & ColmapModelRef)
  // Several discovered models — the webview shows a chooser so the user loads one,
  // some, or all. Used by the browser hosts (web demo + drag-drop), which lack a
  // native picker; the native hosts (VS Code, PyCharm) choose host-side instead.
  | { type: "chooseColmap"; models: ColmapModelRef[] }
  | { type: "addAsset"; id: string; label: string; asset: AssetRef }
  | { type: "error"; message: string };

/** Webview -> extension host. */
export type WebviewToHost =
  | { type: "ready" }
  | { type: "requestAdd"; kind: AddKind } // "+" in the Scene menu
  | { type: "removed"; id: string } // an item was removed from the scene
  // A PNG render of the current viewpoint to save. `png` is a data URL
  // ("data:image/png;base64,…"); the host writes/downloads it.
  | { type: "saveImage"; png: string; suggestedName: string };
