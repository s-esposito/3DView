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
 * asset is a mesh (glTF/GLB/OBJ/PLY), a bare point cloud (PLY), a 3D Gaussian
 * Splatting cloud (.ply / .splat / .spz / .ksplat), or 3D point tracks
 * (.npz / .npy); the loader is picked by file extension.
 */
export interface AssetRef {
  /** Webview URI of the asset file (mesh siblings resolve relative to it). */
  uri: string;
  /** File name, used for display and to pick a loader by extension. */
  name: string;
}

/** The asset families a host offers separately in its "add" menu and file picker. */
export type AssetKind = "mesh" | "cloud" | "splat" | "tracks";

/** What kind of content the "+" add action should pick — a COLMAP *folder*, an
 *  asset *file* of one family, or a *folder of asset files* (`"assetFolder"`: every
 *  asset in it, offered as one temporal item — the way to load a per-frame capture
 *  where a host's dialog cannot select several files, as VS Code's cannot over a
 *  remote connection). The kind only chooses the picker's filter: what an asset
 *  actually is comes from the file itself (a `.ply` is a mesh, a point cloud or a
 *  splat, by what is in it), so picking the "wrong" menu entry still loads the file
 *  correctly. `"archive"` picks a zipped COLMAP project — offered only by a host
 *  that advertises `HostBridge.opensArchives`, as the browser demo does for phones,
 *  which can't pick the folder a model and its images span. */
export type AddKind = "colmap" | AssetKind | "assetFolder" | "archive";

/**
 * File extensions per asset family — the single source every host filters by.
 * `.ply` appears under mesh, cloud and splat on purpose: the three are told apart
 * by what the file holds (a splat header, faces, neither), not by the name.
 */
export const ASSET_KIND_EXTS: Record<AssetKind, readonly string[]> = {
  mesh: ["glb", "gltf", "obj", "ply"],
  cloud: ["ply"],
  splat: ["ply", "splat", "spz", "ksplat"],
  tracks: ["npz", "npy"],
};

/** Every loadable asset extension, in menu order and without duplicates. */
export const ASSET_EXTS: readonly string[] = [
  ...new Set(Object.values(ASSET_KIND_EXTS).flat()),
];

/** A file name's extension, lower-cased and without the dot ("" when it has none).
 *  The one reader every asset-kind test goes through, so "MODEL.PLY" and "model.ply"
 *  are the same file to all of them. */
export function extOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/** Human-readable name of an asset family, for picker titles and messages. */
export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  mesh: "Mesh",
  cloud: "Point cloud",
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

/** A mesh / point cloud / 3DGS splat / point-track file for the webview to load. */
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

/**
 * The host's starting viewpoint for the scene: the camera sits at `position` and
 * orbits `target`. Both are in the scene's own frame — the one reconstructions
 * and assets are loaded in (COLMAP's, +y down) — so the Upright toggle turns them
 * with the content. It becomes the scene's home view: the viewer moves there now
 * and goes back there wherever it would otherwise fit the camera to the scene (the
 * first item landing, Reset view, the Upright toggle, leaving a camera's POV). It
 * may arrive before the content does.
 */
export interface SetViewMsg {
  type: "setView";
  position: [number, number, number];
  target: [number, number, number];
}

/**
 * Place a scene item, or one named node inside it (a node of its glTF), by a full
 * 4x4 matrix: rotation, translation AND scale, in the scene's own frame (the one
 * items are loaded in, COLMAP's, +y down). `matrix` is the 16 entries row-major.
 * For a host that owns an item's placement and moves it as it changes (an object's
 * pose being optimised); it replaces the item's own move/rotate fields' placement.
 * An unknown id or node is ignored: the item may still be loading.
 */
export interface SetTransformMsg {
  type: "setTransform";
  id: string;
  node?: string;
  matrix: number[];
}

/** The panels the icon rail can open. */
export type PanelName = "scene" | "display" | "physics" | "capture";

/** A helper or display switch (the Display panel's Show / Meshes toggles). */
export type ShowName = "grid" | "axes" | "box" | "points" | "frustums" | "images" | "shaded" | "wireframe";

/**
 * How the viewer looks and what a person may do in it. Every field is optional: one left out
 * keeps its current value (at startup: the preset's, else the full UI). Given at startup as
 * `window.__viewerHost.config` (read before anything is drawn, so nothing flashes) or at any
 * time with a `configure` message, which merges into what is there.
 */
export interface ViewerConfig {
  /** Start from a preset, then apply the other fields: "full" (default: every panel and
   *  control, as in VS Code) or "presentation" (a showcase: only the Scene panel, no footer, no
   *  selecting / editing / physics, grid, axes and box off). */
  preset?: "full" | "presentation";
  /** The UI and viewport colour scheme. */
  theme?: "light" | "dark" | "dim";
  /** The viewport's background, any CSS colour ("#fff"); null = the theme's. */
  background?: string | null;
  /** Helpers and display switches, each on or off. */
  show?: Partial<Record<ShowName, boolean>>;
  /** Show the scene Y-up (true, the default) or in its raw COLMAP frame (+y down). */
  upright?: boolean;
  /** How 3D Gaussian splats are drawn. */
  splatMode?: "splatting" | "ellipsoids" | "points";
  /** The viewer's chrome. */
  ui?: {
    /** Which panels the icon rail offers, in rail order; false = no rail and no panels. */
    panels?: PanelName[] | false;
    /** The panel to open now (null: none, the rail alone). */
    open?: PanelName | null;
    /** The footer (frame rate, backend, version, help, theme switcher), and its parts. */
    footer?: boolean;
    fps?: boolean;
    themeSwitcher?: boolean;
    help?: boolean;
    /** Keyboard shortcuts (off: keys do nothing in the viewer). */
    keyboard?: boolean;
  };
  /** What a person may do. */
  interaction?: {
    /** Clicking an item (in the view or the Scene list) selects it and opens its Inspector. */
    select?: boolean;
    /** Change the scene: the gizmo and placement fields, rename, remove, the "+" add menu. */
    edit?: boolean;
    /** Physics: the Physics panel, the playback bar, Shoot / Blast, an item's physics mode. */
    physics?: boolean;
  };
}

/** Change the configuration at runtime: the fields given merge into the current one. */
export type ConfigureMsg = { type: "configure" } & ViewerConfig;

/** What a scene item holds: a COLMAP reconstruction, a sequence of frames, or one asset. */
export type ItemType = "reconstruction" | "sequence" | "mesh" | "splats" | "points" | "tracks" | "physics";

/** Whether an item takes part in the physics: not at all, as a static body (an environment that
 *  only stops others), or as a dynamic one that moves (a breakable object is always the last). */
export type PhysicsMode = "off" | "static" | "dynamic";

/** One scene item, in `state`. */
export interface ItemState {
  id: string;
  label: string;
  type: ItemType;
  visible: boolean;
  /** Its placement: the 4x4 matrix row-major, in the scene's frame (as setTransform takes it). */
  matrix: number[];
  /** Its box in the scene's frame, placement included; null while it has nothing to measure. */
  bounds: Bounds | null;
  /** A sequence's frames (0 for anything else), the one shown (0-based), and whether it plays. */
  frameCount: number;
  frame: number;
  playing: boolean;
  /** Its physics mode, and the modes it can take; null when it cannot take part. */
  physics: { mode: PhysicsMode; modes: PhysicsMode[] } | null;
}

/** The viewer's state, in `state`. Positions are in the scene's frame (COLMAP's, +y down). */
export interface ViewerSnapshot {
  version: string;
  apiVersion: number;
  items: ItemState[];
  selected: string | null;
  camera: { position: [number, number, number]; target: [number, number, number]; fov: number };
  /** The configuration in force, every field filled: a `configure` with it restores this look. */
  config: ViewerConfig;
  /** The simulation; null while no item takes part in it. */
  physics: { running: boolean } | null;
}

/** The embedding API's version, in `ready`: raised whenever a message, event or field is added
 *  (additions only; an embedder feature-detects with it). */
export const API_VERSION = 1;

/** Remove an item from the scene (it is answered by `removed`). */
export interface RemoveItemMsg {
  type: "removeItem";
  id: string;
}

/** Show or hide an item. A hidden physics item leaves the simulation: nothing hits it. */
export interface SetItemVisibleMsg {
  type: "setItemVisible";
  id: string;
  visible: boolean;
}

/** Change the label an item shows in the Scene list. */
export interface SetItemLabelMsg {
  type: "setItemLabel";
  id: string;
  label: string;
}

/** Select an item, opening its Inspector (null: nothing). Answered by `selected` when the
 *  selection changes. Works whatever `interaction.select` allows the person. */
export interface SelectItemMsg {
  type: "selectItem";
  id: string | null;
}

/** Show frame `frame` (0-based, clamped) of a sequence item. */
export interface SetFrameMsg {
  type: "setFrame";
  id: string;
  frame: number;
}

/** Play or pause a sequence item; it loops. */
export interface SetPlayingMsg {
  type: "setPlaying";
  id: string;
  playing: boolean;
}

/** An item's part in the physics: "off" (none, the default for all but a breakable object),
 *  "static" (a fixed body others land on and bounce off) or "dynamic" (it falls and is hit). A
 *  breakable object is "off" or "dynamic"; an item that cannot take part (tracks, a sequence)
 *  ignores it. Works whatever `interaction.physics` allows the person. */
export interface SetPhysicsModeMsg {
  type: "setPhysicsMode";
  id: string;
  mode: PhysicsMode;
}

/** Ask for the viewer's state; answered by `state` with the same `requestId`. */
export interface GetStateMsg {
  type: "getState";
  requestId?: string | number;
}

/** Ask for a PNG of the current view, as Capture > Save viewpoint draws it: `scale` times the
 *  view's size (default 1), on a transparent background unless `transparent` is false (then on
 *  the viewport's). Answered by `captured` with the same `requestId`. */
export interface CaptureMsg {
  type: "capture";
  requestId?: string | number;
  scale?: number;
  transparent?: boolean;
}

/** Drive the simulation: run its clock, stop it, or put every object back where it started. */
export interface PhysicsMsg {
  type: "physics";
  action: "play" | "pause" | "restoreAll";
}

/** The two ways a multi-item add can resolve. Named as the modal's own answers, so
 *  a host-supplied hint and a user's click are the same value downstream. */
export type GroupingChoice = "temporal" | "separate";

/**
 * Extension host -> webview. A scene holds any number of reconstructions and
 * assets (meshes / point clouds / splats / tracks), each identified by a
 * host-assigned `id` (stable
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
  | SetViewMsg
  | SetTransformMsg
  | ConfigureMsg
  | RemoveItemMsg
  | SetItemVisibleMsg
  | SetItemLabelMsg
  | SelectItemMsg
  | SetFrameMsg
  | SetPlayingMsg
  | SetPhysicsModeMsg
  | PhysicsMsg
  | GetStateMsg
  | CaptureMsg
  | { type: "error"; message: string };

/**
 * What the viewer tells its host about the scene's items. Every add message (`addAsset`,
 * `addReconstruction`, `loadColmap`, an `addGroup` loaded as one sequence) is answered with
 * `itemAdded` once the item is in the Scene list, then `itemLoaded` when all of it is drawn, or
 * `itemFailed` if it could not be loaded (a failed item is removed: `removed` follows).
 * `bounds` is the item's box in the scene's own frame (COLMAP's, +y down), its placement
 * included.
 */
export type ViewerEvent =
  | { type: "itemAdded"; id: string; label: string }
  | { type: "itemLoaded"; id: string; bounds: Bounds | null }
  | { type: "itemFailed"; id: string; message: string }
  | { type: "removed"; id: string } // an item left the scene: the host can forget it
  | { type: "selected"; id: string | null }; // the selection changed (a click, or selectItem)

/** The answers to `getState` and `capture`, carrying the request's `requestId`. */
export type ViewerReply =
  | { type: "state"; requestId?: string | number; state: ViewerSnapshot }
  // `data`: a PNG data URL; `error` instead when the view could not be drawn.
  | { type: "captured"; requestId?: string | number; data?: string; error?: string };

/** Webview -> extension host. */
export type WebviewToHost =
  // The viewer is listening: messages sent before this may be lost. `version` is 3DView's
  // (package.json), `apiVersion` the embedding API's (API_VERSION).
  | { type: "ready"; version: string; apiVersion: number }
  | ViewerEvent
  | ViewerReply
  | { type: "requestAdd"; kind: AddKind } // "+" in the Scene menu
  // A drop the webview could only read as URIs, not bytes — a drag out of the
  // editor's own file explorer. The host owns paths, so it opens them; only a host
  // that advertises `HostBridge.opensUris` is sent this (see dropZone.ts).
  | { type: "openUris"; uris: string[] }
  // A rendered file to save: a viewpoint PNG or a camera-path video. `data` is a
  // data URL ("data:image/png;base64,…"); the host writes it, offering the file type
  // that `suggestedName`'s extension names. Only a host that advertises
  // `HostBridge.savesFiles` is sent this; elsewhere the webview downloads it itself.
  | { type: "saveFile"; suggestedName: string; data: string };
