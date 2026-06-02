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

/** A mesh to load in the webview, identified by a webview-resolvable URI. */
export interface MeshRef {
  /** Webview URI of the mesh file (asset siblings resolve relative to it). */
  uri: string;
  /** File name, used for display and to pick a loader by extension. */
  name: string;
}

/** Extension host -> webview. */
export type HostToWebview =
  | { type: "ready" }
  | { type: "loading"; message: string }
  | { type: "model"; data: ModelData }
  | { type: "mesh"; mesh: MeshRef }
  | { type: "error"; message: string };

/** Webview -> extension host. */
export type WebviewToHost =
  | { type: "ready" };
