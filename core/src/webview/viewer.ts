// The scene controller: owns the renderer, scene graph, camera, and interaction.
// A scene is a list of SceneLayers (reconstructions + assets) under `root`, whose
// rotation implements the raw<->upright-Y-up toggle. The UI drives this via a
// small imperative API; the Viewer owns all state.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { CameraView, Bounds, ModelData, AddKind } from "../shared/messages";
import { themeColor } from "./theme";
import {
  buildGrid,
  diagonalOf,
  unionBounds,
  transformBounds,
  computeLocalBounds,
  frustumScaleFromDepth,
  disposeObject,
  FRUSTUM_COLOR,
} from "./builders";
import {
  SceneLayer,
  ReconstructionLayer,
  DisplayOptions,
  AssetOptions,
  DEFAULT_ASSET_OPTIONS,
} from "./sceneLayer";
import { AssetLayer } from "./assetLayer";
import { SparkRenderer } from "@sparkjsdev/spark";
import { SPLAT_RENDER_MODES } from "./splats";
import type { SplatRenderMode } from "./splats";
import { CameraInteraction, DEFAULT_FOV } from "./cameraInteraction";

// Cap render resolution: above this, HiDPI fill/memory cost (∝ ratio²) isn't
// worth the marginal sharpness for point clouds. Never below 1.
const MAX_PIXEL_RATIO = 1.5;

/** Scene-wide toggles the control panel exposes. */
export type GlobalToggle =
  | "points"
  | "frustums"
  | "images"
  | "box"
  | "grid"
  | "axes"
  | "wireframe"
  | "shaded";
export type Orientation = "raw" | "upright";
export type ThemeName = "light" | "dark" | "dim";

export type Vec3 = [number, number, number];

/** A scene item's own placement: metres and degrees, as the UI shows them. */
export interface ItemTransform {
  position: Vec3;
  /** Euler XYZ in degrees (Three's default order), like Blender's rotation fields. */
  rotation: Vec3;
}

/** One entry in the Scene list. */
export interface SceneItem {
  id: string;
  label: string;
  kind: "reconstruction" | "asset";
  visible: boolean;
  /** Source location (e.g. asset file URI) for the hover tooltip; undefined when unknown. */
  source?: string;
  transform: ItemTransform;
}

/** Read-only snapshot of view state, for the UI to render controls from. */
export interface ViewerState {
  points: boolean;
  frustums: boolean;
  images: boolean;
  box: boolean;
  grid: boolean;
  axes: boolean;
  wireframe: boolean;
  shaded: boolean;
  splatMode: SplatRenderMode;
  orientation: Orientation;
  theme: ThemeName;
  pointSize: number;
  frustumScale: number;
  frustumScaleMax: number;
  /** Frustum wireframe thickness, in screen pixels. */
  frustumLineWidth: number;
  /** Frustum wireframe base color, as 0xRRGGBB. */
  frustumColor: number;
  /** Perspective field of view, in degrees. */
  fov: number;
  /** Camera roll (tilt) about the view axis, in degrees. */
  roll: number;
  hasPoints: boolean;
  hasCameras: boolean;
  hasAsset: boolean;
  hasSplat: boolean;
  /** Longest point-track asset in the scene, in time steps; 0 when there are none. */
  trackSteps: number;
  /** How many of those steps are currently drawn. */
  trackFrames: number;
  /** Point-track line opacity, 0..1. */
  trackOpacity: number;
  /** Fraction of point tracks drawn, 0..1. */
  trackDensity: number;
  /** Sensible nudge for the position fields, derived from the scene's size. */
  positionStep: number;
  items: SceneItem[];
}

export class Viewer {
  /** Fired with the selected camera on POV entry, and with null on exit. */
  onSelect?: (camera: CameraView | null) => void;
  /** Fired after the scene's content or layout changes. */
  onChange?: () => void;
  /** Fired when async content (e.g. an asset) fails to load. */
  onError?: (message: string) => void;
  /** Fired with a human-readable loading phase (download %, "Decoding…") for async assets. */
  onProgress?: (message: string) => void;
  /** Fired when the "+" add action is invoked (the host opens a picker). */
  onRequestAdd?: (kind: AddKind) => void;
  /** Fired when an item is removed, so the host can forget it. */
  onRemoveItem?: (id: string) => void;
  /** Fired with a PNG data URL of the current viewpoint, for the host to save. */
  onSaveImage?: (png: string, suggestedName: string) => void;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly root: THREE.Group;
  private readonly interaction: CameraInteraction;

  private layers: SceneLayer[] = [];
  private readonly byId = new Map<string, SceneLayer>();
  private grid?: THREE.GridHelper;
  private axes?: THREE.AxesHelper;
  /** Spark's splat rasterizer — one per scene, present only while a splat asset is
   *  loaded and splatting is in use (see syncSpark). */
  private spark?: SparkRenderer;
  private bounds: Bounds = { min: [-1, -1, -1], max: [1, 1, 1] };

  // Scene-wide display state.
  private readonly opts: DisplayOptions = {
    points: true,
    frustums: true,
    images: true,
    box: true,
    pointSize: 1.5,
    frustumScale: 0,
    frustumLineWidth: 3,
    frustumColor: FRUSTUM_COLOR,
  };
  private showGrid = true;
  private showAxes = true;
  private wireframe = false;
  // Meshes are lit/shaded by default (GLB PBR, etc.); turning "Shaded" off shows
  // unlit albedo (base color + texture only).
  private shaded = true;
  // What assets draw: 3DGS render mode + point-track trail/opacity/density.
  private assetOpts: AssetOptions = { ...DEFAULT_ASSET_OPTIONS };
  private orientation: Orientation = "upright";
  // UI + viewport color scheme; applied to <body data-viewer-theme> so the CSS
  // palette and the 3D background follow it. Default is dark (the glass look).
  private themeName: ThemeName = "dark";
  private frustumScaleMax = 1;
  private frustumInitialized = false;
  // Camera roll (tilt) about the view axis, in degrees. Re-applied every frame
  // after OrbitControls.update() (which owns the un-rolled orientation).
  private rollDeg = 0;
  // On-demand rendering: render only when the camera is moving (damping) or
  // something requested a redraw, instead of re-rasterizing the cloud every frame.
  private needsRender = true;

  constructor(container: HTMLElement = document.body) {
    // Apply the default theme before reading any themed CSS var below (the
    // 3D background reads --vscode-editor-background, which the theme overrides).
    document.body.dataset.viewerTheme = this.themeName;
    // alpha: true → the drawing buffer has an alpha channel so saveViewpoint() can
    // capture a transparent PNG (normal frames still paint scene.background opaquely).
    // preserveDrawingBuffer: true → saveViewpoint() renders outside the rAF loop and
    // then reads the canvas via toDataURL(); without this the webview compositor can
    // hand back the *previous* frame (opaque theme background), saving a black
    // background instead of the transparent one we just rendered.
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = themeColor("--vscode-editor-background", 0x1e1e1e);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    // Lighting for lit mesh materials (glTF PBR, PLY/OBJ). The image-based light
    // is load-bearing, not decoration: without it metalness/roughness maps render
    // black (metals reflect the environment, not analytic lights). Intensities are
    // hand-balanced; see CLAUDE.md "PBR meshes need the environment".
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    this.scene.environmentIntensity = 0.6;
    room.dispose(); // free the room's geometry/materials; PMREM keeps only the cubemap
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(1, 2, 1);
    this.scene.add(key);

    this.camera = new THREE.PerspectiveCamera(
      DEFAULT_FOV,
      window.innerWidth / window.innerHeight,
      0.01,
      1e6
    );
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener("end", () => this.refreshTextures());

    this.interaction = new CameraInteraction({
      dom: this.renderer.domElement,
      camera: this.camera,
      controls: this.controls,
      root: this.root,
      reconstructions: () => this.reconstructionLayers(),
      boundsDiagonal: () => diagonalOf(this.bounds),
      onSelect: (cam) => this.onSelect?.(cam),
      requestRender: this.requestRender,
    });

    window.addEventListener("resize", () => this.onResize());

    // Default empty scene so the viewport is navigable before any content.
    // applyOrientation (not just fitCamera) so the default upright flip is
    // applied to `root` from the start, not only after the first U toggle.
    this.rebuildHelpers();
    this.applyOrientation();
    this.animate();
  }

  // --- Public API -----------------------------------------------------------
  getState(): ViewerState {
    const recon = this.reconstructionLayers();
    const trackSteps = this.trackSteps();
    return {
      points: this.opts.points,
      frustums: this.opts.frustums,
      images: this.opts.images,
      box: this.opts.box,
      grid: this.showGrid,
      axes: this.showAxes,
      wireframe: this.wireframe,
      shaded: this.shaded,
      splatMode: this.assetOpts.splatMode,
      orientation: this.orientation,
      theme: this.themeName,
      pointSize: this.opts.pointSize,
      frustumScale: this.opts.frustumScale,
      frustumScaleMax: this.frustumScaleMax,
      frustumLineWidth: this.opts.frustumLineWidth,
      frustumColor: this.opts.frustumColor,
      fov: this.camera.fov,
      roll: this.rollDeg,
      hasPoints: recon.some((l) => l.pointCount > 0),
      hasCameras: recon.some((l) => l.cameraCount > 0),
      hasAsset: this.layers.some((l) => l.kind === "asset"),
      hasSplat: this.assetLayers().some((l) => l.isSplat),
      trackSteps,
      trackFrames: Math.min(this.assetOpts.trackFrames, trackSteps),
      trackOpacity: this.assetOpts.trackOpacity,
      trackDensity: this.assetOpts.trackDensity,
      positionStep: roundToPowerOfTen(diagonalOf(this.bounds) / 100),
      items: this.layers.map((l) => ({
        id: l.id,
        label: l.label,
        kind: l.kind,
        visible: l.visible,
        source: l.source,
        transform: readTransform(l.object),
      })),
    };
  }

  addReconstruction(id: string, label: string, data: ModelData, source?: string): void {
    this.attach(this.buildReconstruction(id, label, data, source));
  }

  /**
   * Build a reconstruction layer, sizing the scene's frustums from the first model
   * to arrive (see CLAUDE.md, "Frustum size is measured, not guessed"). Separate
   * from `addReconstruction` because a temporal item builds its frames itself and
   * must trip the same latch.
   */
  private buildReconstruction(
    id: string,
    label: string,
    data: ModelData,
    source?: string
  ): ReconstructionLayer {
    if (!this.frustumInitialized) {
      const b = computeLocalBounds(data);
      this.frustumScaleMax = diagonalOf(b) * 0.16;
      // What the cameras see, falling back to one slider step of the scene extent
      // for a model that gives nothing to measure, and capped at the slider's own
      // maximum so the initial value is always one it can express.
      const measured = frustumScaleFromDepth(data);
      this.opts.frustumScale = Math.min(
        measured || this.frustumScaleMax / 80,
        this.frustumScaleMax
      );
      this.frustumInitialized = true;
    }
    return new ReconstructionLayer(id, label, data, this.opts, this.requestRender, source);
  }

  addAsset(id: string, label: string, uri: string, name: string): void {
    const layer = new AssetLayer(id, label, uri);
    this.layers.push(layer);
    this.byId.set(id, layer);
    this.root.add(layer.object);
    layer
      .load(uri, name, this.assetOpts, (phase) => this.onProgress?.(`${label} — ${phase}`))
      .then(() => {
        layer.setVisible(true);
        // The scene state may have changed while this was loading; a no-op otherwise.
        this.syncLayerState(layer);
        this.syncSpark(); // this asset may be the scene's first splat
        this.refreshScene(this.layers.length === 1); // fit only if it's the first item
      })
      .catch((err: Error) => {
        this.removeItem(id);
        this.onError?.(err.message);
      })
      // The asset bytes are fetched exactly once during load; free a blob: URL
      // (a dropped / demo file) afterward so it isn't pinned for the session. A
      // no-op on non-blob host URLs (VS Code / PyCharm).
      .finally(() => URL.revokeObjectURL(uri));
  }

  setItemVisible(id: string, visible: boolean): void {
    this.byId.get(id)?.setVisible(visible);
    this.requestRender();
  }

  /**
   * Move / rotate one scene item, Blender-style: its own placement inside the
   * scene, independent of every other item. Only the given fields change, so the
   * UI can drive one axis at a time. Rotation is Euler XYZ in degrees.
   *
   * Deliberately does not fire `onChange` — the caller is a live number field, and
   * a panel re-render would steal its focus mid-edit.
   */
  setItemTransform(id: string, patch: Partial<ItemTransform>): void {
    const layer = this.byId.get(id);
    if (!layer) {
      return;
    }
    if (patch.position) {
      layer.object.position.fromArray(patch.position);
    }
    if (patch.rotation) {
      const [x, y, z] = patch.rotation.map(THREE.MathUtils.degToRad);
      layer.object.rotation.set(x, y, z);
    }
    layer.object.updateMatrix(); // bounds below read `matrix`, not the render-time one
    this.recomputeBounds();
    this.rebuildHelpers(); // the grid + axes span the scene, so they follow
    this.refreshTextures();
    this.requestRender();
  }

  /** Put a scene item back at the origin, unrotated. */
  resetItemTransform(id: string): void {
    this.setItemTransform(id, { position: [0, 0, 0], rotation: [0, 0, 0] });
  }

  /** Rename a scene item's display label; re-renders the Scene list via onChange. */
  renameItem(id: string, label: string): void {
    const layer = this.byId.get(id);
    if (!layer) {
      return;
    }
    layer.label = label;
    this.onChange?.();
  }

  removeItem(id: string): void {
    const layer = this.byId.get(id);
    if (!layer) {
      return;
    }
    this.interaction.handleRemoved(id);
    layer.dispose();
    this.layers = this.layers.filter((l) => l !== layer);
    this.byId.delete(id);
    this.syncSpark(); // that may have been the scene's last splat
    this.recomputeBounds();
    this.rebuildHelpers();
    this.onChange?.();
    this.onRemoveItem?.(id);
  }

  setGlobal(toggle: GlobalToggle, on: boolean): void {
    switch (toggle) {
      case "grid":
        this.showGrid = on;
        if (this.grid) this.grid.visible = on;
        break;
      case "axes":
        this.showAxes = on;
        if (this.axes) this.axes.visible = on;
        break;
      case "images":
        this.opts.images = on;
        this.reconstructionLayers().forEach((l) => l.rebuildCameras(this.opts));
        this.refreshTextures();
        break;
      case "box":
        // Boxes wrap both reconstructions and assets.
        this.opts.box = on;
        this.layers.forEach((l) => l.setBoxVisible(on));
        break;
      case "wireframe":
        this.wireframe = on;
        this.layers.forEach((l) => l.setWireframe(on));
        break;
      case "shaded":
        this.shaded = on;
        this.layers.forEach((l) => l.setShaded(on));
        break;
      default:
        this.opts[toggle] = on; // points | frustums
        this.reconstructionLayers().forEach((l) => l.applyOptions(this.opts));
    }
    this.requestRender();
  }

  toggleGlobal(toggle: GlobalToggle): void {
    this.setGlobal(toggle, !this.getState()[toggle]);
  }

  /** Switch how 3DGS assets are drawn; each splat layer rebuilds from its decoded cloud. */
  setSplatMode(mode: SplatRenderMode): void {
    this.setAssetOptions({ splatMode: mode });
  }

  /** Step through the 3DGS render modes (the E key), in decreasing fidelity. */
  cycleSplatMode(): void {
    const at = SPLAT_RENDER_MODES.indexOf(this.assetOpts.splatMode);
    this.setSplatMode(SPLAT_RENDER_MODES[(at + 1) % SPLAT_RENDER_MODES.length]);
  }

  /** Draw point-track trajectories up to `frames` time steps. At the maximum this
   *  reverts to "all steps", so a longer track asset added later still shows whole. */
  setTrackFrames(frames: number): void {
    this.setAssetOptions({
      trackFrames: frames >= this.trackSteps() ? Number.POSITIVE_INFINITY : frames,
    });
  }

  /** Fade point-track lines (1 = opaque) — how a dense set of trails stays legible. */
  setTrackOpacity(opacity: number): void {
    this.setAssetOptions({ trackOpacity: opacity });
  }

  /** Draw only a fraction of the point tracks (1 = all). The subset is stable, so
   *  raising this adds tracks back rather than reshuffling the set. */
  setTrackDensity(density: number): void {
    this.setAssetOptions({ trackDensity: density });
  }

  /** Merge a change into the scene-wide asset options and push it to every layer. */
  private setAssetOptions(patch: Partial<AssetOptions>): void {
    this.assetOpts = { ...this.assetOpts, ...patch };
    this.layers.forEach((l) => l.applyAssetOptions(this.assetOpts));
    this.syncSpark();
    this.requestRender();
  }

  /**
   * Match Spark's renderer to what the scene needs — call after the layers have been
   * updated, so the SplatMeshes it draws already exist. It goes up when splatting is
   * in use and comes down once no splat asset is left, because it holds GPU
   * accumulators sized to the largest cloud it has drawn.
   *
   * It belongs to the scene rather than to `root`: its own transform is the origin
   * Spark encodes splat positions against, so leaving it at identity keeps that
   * precise. `onDirty` is what makes it fit our on-demand loop — Spark calls it when
   * a viewpoint sort or LoD update lands, exactly when the last frame went stale.
   */
  private syncSpark(): void {
    const hasSplat = this.assetLayers().some((l) => l.isSplat);
    if (this.spark && !hasSplat) {
      this.spark.removeFromParent();
      this.spark.dispose();
      this.spark = undefined;
    } else if (!this.spark && hasSplat && this.assetOpts.splatMode === "splatting") {
      this.spark = new SparkRenderer({ renderer: this.renderer, onDirty: this.requestRender });
      this.scene.add(this.spark);
    }
  }

  setPointSize(size: number): void {
    this.opts.pointSize = size;
    this.reconstructionLayers().forEach((l) => l.applyOptions(this.opts));
    this.requestRender();
  }

  setFrustumScale(scale: number): void {
    this.opts.frustumScale = scale;
    this.reconstructionLayers().forEach((l) => l.rebuildCameras(this.opts));
    this.refreshTextures();
    this.requestRender();
  }

  /** Set the frustum wireframe thickness (screen px); live, no geometry rebuild. */
  setFrustumLineWidth(width: number): void {
    this.opts.frustumLineWidth = width;
    this.reconstructionLayers().forEach((l) => l.applyOptions(this.opts));
    this.requestRender();
  }

  /** Set the frustum wireframe base color (0xRRGGBB); live, no geometry rebuild.
   *  Hovered/selected frustums keep their highlight colors until deselected. */
  setFrustumColor(color: number): void {
    this.opts.frustumColor = color;
    this.reconstructionLayers().forEach((l) => l.applyOptions(this.opts));
    this.requestRender();
  }

  /** Set the perspective field of view, in degrees. */
  setFov(deg: number): void {
    this.camera.fov = deg;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  /** Roll (tilt) the camera about its view axis, in degrees. Applied each frame in
   *  `animate` on top of OrbitControls' orientation, so orbit/pan/zoom are unaffected. */
  setRoll(deg: number): void {
    this.rollDeg = deg;
    this.requestRender();
  }

  /** Reset the camera controls (field of view + roll) to their defaults. */
  resetCamera(): void {
    this.setRoll(0);
    this.setFov(DEFAULT_FOV);
  }

  setOrientation(orientation: Orientation): void {
    this.orientation = orientation;
    this.applyOrientation();
  }

  toggleOrientation(): void {
    this.setOrientation(this.orientation === "upright" ? "raw" : "upright");
  }

  /** Switch the UI + viewport color scheme (light/dark/dim). */
  setTheme(theme: ThemeName): void {
    this.themeName = theme;
    document.body.dataset.viewerTheme = theme;
    // The CSS palette retones via the [data-viewer-theme] vars; re-read the now
    // themed editor background for the 3D viewport (it was read once at init).
    this.scene.background = themeColor("--vscode-editor-background", 0x1e1e1e);
    this.requestRender();
  }

  requestAdd(kind: AddKind): void {
    this.onRequestAdd?.(kind);
  }

  resetView(): void {
    this.fitCamera();
  }

  exitPov(): void {
    this.interaction.exitPov();
    this.fitCamera();
  }

  /** Clear the camera-selection highlight without leaving the current view. */
  clearSelection(): void {
    this.interaction.clearSelection();
  }

  // --- Scene maintenance ----------------------------------------------------
  private attach(layer: SceneLayer): void {
    const first = this.layers.length === 0;
    this.layers.push(layer);
    this.byId.set(layer.id, layer);
    this.root.add(layer.object);
    this.refreshScene(first);
  }

  /**
   * Bring one layer up to the scene's current display + asset state — the single
   * owner of "what the scene state is". Needed wherever a layer joins the scene
   * later than the state it must obey: an asset whose load finished after a toggle
   * moved, or a temporal frame that was hidden while one did. Idempotent, and cheap
   * to repeat: both layer kinds rebuild only what actually changed.
   */
  private syncLayerState(layer: SceneLayer): void {
    layer.setBoxVisible(this.opts.box);
    layer.setWireframe(this.wireframe);
    layer.setShaded(this.shaded);
    layer.applyAssetOptions(this.assetOpts);
    if (layer instanceof ReconstructionLayer) {
      layer.rebuildCameras(this.opts);
      layer.applyOptions(this.opts);
    }
  }

  /** Recompute bounds/helpers after a content change; only re-fit when asked
   * (so adding to an existing scene doesn't move the user's view). */
  private refreshScene(fit: boolean): void {
    this.recomputeBounds();
    this.rebuildHelpers(); // requests a render
    if (fit) {
      this.fitCamera();
    }
    this.refreshTextures();
    this.onChange?.();
  }

  private reconstructionLayers(): ReconstructionLayer[] {
    return this.layers.filter(
      (l): l is ReconstructionLayer => l.kind === "reconstruction"
    );
  }

  private assetLayers(): AssetLayer[] {
    return this.layers.filter((l): l is AssetLayer => l.kind === "asset");
  }

  /** Steps in the longest point-track asset; 0 when the scene holds none. */
  private trackSteps(): number {
    return this.assetLayers().reduce((max, l) => Math.max(max, l.trackSteps), 0);
  }

  /** Scene bounds in root space: each layer's local bounds under its own placement. */
  private recomputeBounds(): void {
    const parts = this.layers
      .map((l) => {
        const local = l.bounds();
        return local && transformBounds(local, l.object.matrix);
      })
      .filter((b): b is Bounds => b != null);
    this.bounds = unionBounds(parts);
    this.frustumScaleMax = diagonalOf(this.bounds) * 0.16;
  }

  private rebuildHelpers(): void {
    disposeObject(this.grid);
    disposeObject(this.axes);
    this.axes = new THREE.AxesHelper(diagonalOf(this.bounds) * 0.5);
    this.axes.visible = this.showAxes;
    this.root.add(this.axes);
    this.grid = buildGrid(this.bounds);
    this.grid.visible = this.showGrid;
    this.root.add(this.grid);
    this.requestRender();
  }

  private refreshTextures(): void {
    this.root.updateMatrixWorld(true); // also refreshes each layer's matrixWorld
    this.reconstructionLayers().forEach((l) => l.refreshTextures(this.camera.position));
  }

  private applyOrientation(): void {
    // COLMAP is +y down / +z forward; "upright" flips 180° about x to read y-up.
    this.root.rotation.set(this.orientation === "upright" ? Math.PI : 0, 0, 0);
    this.fitCamera();
  }

  private fitCamera(): void {
    this.root.updateMatrixWorld(true);
    const world = transformBounds(this.bounds, this.root.matrixWorld);
    const wMin = new THREE.Vector3().fromArray(world.min);
    const wMax = new THREE.Vector3().fromArray(world.max);
    const center = wMin.clone().add(wMax).multiplyScalar(0.5);
    const diag = wMin.distanceTo(wMax) || 1;
    this.camera.near = diag / 1000;
    this.camera.far = diag * 100;
    const off = diag * 0.6;
    this.camera.position.set(center.x + off, center.y + off, center.z + off);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.requestRender();
  }

  /**
   * Render the current viewpoint at `scale`× the on-screen resolution and hand the
   * resulting PNG (data URL) to `onSaveImage` for the host to save. The 3D canvas
   * only (no UI overlay) is captured, with a fully transparent background (the
   * viewer background color is dropped). Guards against exceeding the GPU's max buffer.
   */
  saveViewpoint(scale: number): void {
    const maxDim = this.renderer.capabilities.maxTextureSize;
    const w = Math.round(window.innerWidth * scale);
    const h = Math.round(window.innerHeight * scale);
    if (w > maxDim || h > maxDim) {
      this.onError?.(`Render too large (${w}×${h}px); max ${maxDim}px per side — try a lower scale.`);
      return;
    }
    // Enlarge the drawing buffer (keeping CSS size, so layout doesn't jump), render,
    // then read it back with toDataURL(); the renderer's preserveDrawingBuffer (see
    // the constructor) is what keeps that read pointing at this render, not a stale frame.
    // Drop the opaque scene.background and clear to alpha 0 so the PNG is transparent;
    // restore both afterwards so the live view keeps its background color.
    const prevRatio = this.renderer.getPixelRatio();
    const prevBackground = this.scene.background;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.scene.background = null;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.render(this.scene, this.camera);
    const png = this.renderer.domElement.toDataURL("image/png");
    this.scene.background = prevBackground;
    this.renderer.setPixelRatio(prevRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.requestRender();
    this.onSaveImage?.(png, `viewpoint-${scale}x.png`);
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.requestRender();
  }

  /** Request a redraw on the next frame (for changes that don't move the camera). */
  private requestRender = (): void => {
    this.needsRender = true;
  };

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    // OrbitControls.update() returns true while the camera is still moving
    // (incl. damping glide); render then, or whenever a redraw was requested.
    const moving = this.controls.update();
    // Roll is a pure tilt about the view axis, layered on top of the orientation
    // OrbitControls just wrote. Re-applied every frame (update() re-derives the
    // un-rolled orientation from target + up each call, so this never accumulates),
    // which also keeps the camera consistently rolled for pointer picking.
    if (this.rollDeg !== 0) {
      this.camera.rotateZ(THREE.MathUtils.degToRad(this.rollDeg));
    }
    if (moving || this.needsRender) {
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  };
}

/** An object's placement in the units the transform fields edit: metres and degrees. */
function readTransform(object: THREE.Object3D): ItemTransform {
  const { x, y, z } = object.rotation;
  return {
    position: object.position.toArray() as Vec3,
    rotation: [x, y, z].map(THREE.MathUtils.radToDeg) as Vec3,
  };
}

/** Round down to the nearest power of ten (1, 0.1, 0.01, …), so a nudge step reads
 *  as a round number whatever the scene's scale. Zero-safe. */
function roundToPowerOfTen(value: number): number {
  return value > 0 ? 10 ** Math.floor(Math.log10(value)) : 0.01;
}
