// The scene controller: owns the renderer, scene graph, camera, and interaction.
// A scene is a list of SceneLayers (reconstructions + assets) under `root`, whose
// rotation implements the raw<->upright-Y-up toggle. The UI drives this via a
// small imperative API; the Viewer owns all state.
import * as THREE from "three";
import { PMREMGenerator, type WebGPURenderer } from "three/webgpu";
import { createRenderer, getGpuCaps } from "@sparkjsdev/radix";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { CameraView, Bounds, ModelData, AddKind, ViewerConfig, ViewerEvent } from "../shared/messages";
import { expand, FULL_INTERACTION, FULL_UI, type InteractionConfig, type UiConfig } from "./config";
import { themeColor } from "./theme";
import {
  buildGrid,
  cloudColor,
  diagonalOf,
  unionBounds,
  transformBounds,
  computeLocalBounds,
  frustumScaleFromDepth,
  disposeObject,
  FRUSTUM_COLOR,
  estimatePointSpacing,
  PointCloud,
} from "./builders";
import {
  SceneLayer,
  ReconstructionLayer,
  DisplayOptions,
  AssetOptions,
  DEFAULT_ASSET_OPTIONS,
} from "./sceneLayer";
import { AssetLayer, loadSplatCloud } from "./assetLayer";
import { TemporalLayer } from "./temporalLayer";
import { SplatDrawer } from "./splatDrawer";
import { SPLAT_RENDER_MODES, sameSplatLayout } from "./splats";
import type { SplatCloud, SplatRenderMode } from "./splats";
import { PhysicsRun, PhysicsRuntime, type PhysicsPreset } from "./physics/run";
import { geometryShape, mountRigid, unmountRigid } from "./physics/rigidObject";
import { ASSET_KIND_EXTS, extOf } from "../shared/messages";
import { CameraInteraction, DEFAULT_FOV } from "./cameraInteraction";
import { cameraPose, orderCameras, samplePath } from "./cameraPath";
import { encodeVideo } from "./videoEncoder";

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
  /** Per axis, about the item's origin; 1 is its own size. */
  scale: Vec3;
}

/** Points or vertices above which building a collision shape is announced (it takes a moment). */
const BIG_GEOMETRY = 200_000;

/** The gizmo's size, as a share of three's default: Blender's is about half of it on screen. */
const GIZMO_SIZE = 0.5;

/** What the gizmo on the selected item does (Blender's G / R / S). */
export type GizmoMode = "translate" | "rotate" | "scale";

/** One frame of a temporal item, resolved to what a layer needs — the same two
 *  shapes the single-item add paths take. */
export type TemporalFrame =
  | { kind: "reconstruction"; id: string; label: string; data: ModelData; source?: string }
  | { kind: "asset"; id: string; label: string; uri: string; name: string };

/** What a click in the view does: select the item under it, or (with a physics object in the
 *  scene) shoot the piece it hits / blow up a blast there. */
export type ClickMode = "select" | "shoot" | "blast";

/** Whether an item takes part in the physics: not at all, as a static body (an environment that
 *  only stops others), or as a dynamic one that moves (a breakable object is always the last). */
export type PhysicsMode = "off" | "static" | "dynamic";

/** What a Scene item holds: a COLMAP reconstruction, a sequence of frames, or one asset. */
export type ItemType = "reconstruction" | "sequence" | "mesh" | "splats" | "points" | "tracks" | "physics";

/** A layer's ItemType: a lone asset says what it holds; several frames are a sequence. */
function itemType(l: SceneLayer): ItemType {
  if (l instanceof ReconstructionLayer) return "reconstruction";
  return l instanceof AssetLayer && l.frameCount === 0 ? l.type : "sequence";
}

/** One entry in the Scene list. */
export interface SceneItem {
  id: string;
  label: string;
  kind: "reconstruction" | "asset";
  type: ItemType;
  /** Its physics mode and the modes it can take; null when it cannot take part (tracks, a
   *  sequence). Off by default, but for a breakable object. */
  physics: { mode: PhysicsMode; modes: PhysicsMode[]; shape: boolean } | null;
  visible: boolean;
  /** Source location (e.g. asset file URI) for the hover tooltip; undefined when unknown. */
  source?: string;
  transform: ItemTransform;
  /** Frames in this item's sequence; 0 when it isn't a temporal item. */
  frameCount: number;
  /** Which frame is on screen (0-based). */
  frame: number;
  /** Whether the playback clock is advancing this item. */
  playing: boolean;
  /** Cameras in this item (a reconstruction's frustums); 0 for assets and temporal items. */
  cameraCount: number;
}

/** What renderCameraPath renders. */
export interface CameraPathVideo {
  /** The reconstruction whose cameras the path follows, in image-name order. */
  itemId: string;
  /** Frames per camera-to-camera segment: 1 renders exactly the cameras' views. */
  framesPerCamera: number;
  fps: number;
  /** Close the path back to the first camera (for orbits). */
  loop: boolean;
  /** Output size as a multiple of the first camera's image size. */
  scale: number;
  /** Vertical field of view (degrees) for every frame, overriding the cameras' own. */
  fov?: number;
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
  /** Whether renders (viewpoint PNG, camera-path video) size points by the cloud's
   *  own spacing, so they fill in instead of thinning out at render resolution. */
  adaptivePointSize: boolean;
  hasPoints: boolean;
  hasCameras: boolean;
  hasAssets: boolean;
  hasSplat: boolean;
  /** Whether any asset is a bare point cloud, so the "Point size" slider applies
   *  even in a scene with no reconstruction. */
  hasPointCloud: boolean;
  /** Longest point-track asset in the scene, in time steps; 0 when there are none. */
  trackSteps: number;
  /** How many of those steps are currently drawn. */
  trackTrail: number;
  /** Point-track line opacity, 0..1. */
  trackOpacity: number;
  /** Fraction of point tracks drawn, 0..1. */
  trackDensity: number;
  /** Point-track trail thickness in screen pixels. */
  trackLineWidth: number;
  /** Gaussian smoothing of the trajectories along time, in steps; 0 = raw. */
  trackSmoothing: number;
  /** Sensible nudge for the position fields, derived from the scene's size. */
  positionStep: number;
  /** How fast temporal items play back, in frames per second (shared by all of them). */
  playbackFps: number;
  /** Which GPU backend draws the scene; null until the renderer is up. */
  backend: "WebGPU" | "WebGL2" | null;
  items: SceneItem[];
  /** The scene's physics, for the Physics panel; null while no item takes part. */
  physics: PhysicsView | null;
  /** The Scene item the Inspector shows; null when none is selected. */
  selected: string | null;
  /** What a click in the view does. */
  clickMode: ClickMode;
  /** What the gizmo on the selected item does; scale is locked for a breakable object whose
   *  physics is on (its welds are calibrated to its size). */
  gizmoMode: GizmoMode;
  /** The configured chrome, and what a person may do (Viewer.configure). */
  ui: UiConfig;
  interaction: InteractionConfig;
  scaleLocked: boolean;
}

/** The scene's simulation, as the Physics panel shows it. */
export interface PhysicsView {
  /** Whether its clock runs. */
  running: boolean;
  /** Sim seconds per real second. */
  speed: number;
  /** m/s². */
  gravity: number;
  /** Whether there is a floor (at the scene's bottom). */
  floor: boolean;
  /** Metres per scene unit. */
  unit: number;
  /** Whether the camera follows the object last acted on while its pieces move. */
  follow: boolean;
  /** "2 objects, moving", ... */
  status: string;
  objects: PhysicsItem[];
}

/** A chunked object's physics, as its Inspector shows it. */
export interface PhysicsItem {
  id: string;
  label: string;
  /** Calibrating its welds (its actions wait). */
  busy: boolean;
  /** A chunked object (welds, presets) rather than a rigid one. */
  breakable: boolean;
  /** A dynamic body (it moves) or a static one (it only stops others). */
  dynamic: boolean;
  /** "calibrating 40%", "3 pieces, largest 80%, moving", ... */
  status: string;
  /** Glue, x the load each weld carries at rest. */
  strength: number;
  /** Shatter on impact above this speed (m/s); Infinity = off. */
  shatterSpeed: number;
}

/** What an object's Inspector can ask of its physics. */
export type PhysicsAction = "reset" | "drop";

export class Viewer {
  /** Fired with the selected camera on POV entry, and with null on exit. */
  onSelect?: (camera: CameraView | null) => void;
  /** Fired after the scene's content or layout changes. */
  onChange?: () => void;
  /** Fired when async content (e.g. an asset) fails to load. */
  onError?: (message: string) => void;
  /** Fired with a human-readable loading phase (download %, "Decoding") for async assets. */
  onProgress?: (message: string) => void;
  /** Fired as a temporal item plays, so the panel can move the playhead in place.
   *  Deliberately not onChange — that would rebuild the slider several times a second. */
  onFrame?: (id: string, frame: number) => void;
  /** Fired about twice a second with the frames drawn per second, or null while nothing is
   *  drawn (the loop renders on demand, so an idle scene draws no frames). */
  onFps?: (fps: number | null) => void;
  /** Fired with a physics object's status (``id`` null: the simulation's) as it changes
   *  (every step while it moves), so the panel can update its lines in place — not onChange, for
   *  the same reason as onFrame. */
  onPhysics?: (id: string | null, status: string) => void;
  /** Fired when the "+" add action is invoked (the host opens a picker). */
  onRequestAdd?: (kind: AddKind) => void;
  /** Fired with what a host hears about the items (messages.ts ViewerEvent): added, loaded,
   *  failed, removed, selected. */
  onEvent?: (event: ViewerEvent) => void;
  /** Fired with a rendered file (viewpoint PNG, camera-path video) as a data URL, to save (main.ts: via the host, or an in-page download). */
  onSaveFile?: (data: string, suggestedName: string) => void;

  /** Set once the GPU device is up (see initRenderer); nothing renders before. */
  private renderer?: WebGPURenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly root: THREE.Group;
  private readonly interaction: CameraInteraction;

  private layers: SceneLayer[] = [];
  private readonly byId = new Map<string, SceneLayer>();
  private grid?: THREE.GridHelper;
  private axes?: THREE.AxesHelper;
  /** The splat renderer — one per scene, created lazily the first time splatting
   *  is used and removed once no splat asset is left (see syncSplats). */
  private splats?: SplatDrawer;
  private bounds: Bounds = { min: [-1, -1, -1], max: [1, 1, 1] };
  /** The host's starting viewpoint (see SetViewMsg), in the scene's own frame;
   *  null fits the camera to the scene's bounds instead. */
  private homeView: { position: Vec3; target: Vec3 } | null = null;

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
  // Palette turn for the next scene item's fallback color. Taken per ITEM, not per
  // layer — see addTemporal, where one turn covers every frame.
  private colorTurn = 0;
  // Temporal items currently playing, and the clock that steps them (shared, so
  // several sequences advance together). Empty is the common case: the clock in
  // `animate` costs one Set size check per frame.
  private readonly playingLayers = new Set<TemporalLayer>();
  /** The scene's physics: every physics object's run, in one World. */
  private readonly physics = new PhysicsRuntime();
  /** Whether something moved in the last frame (advancePhysics). */
  private physicsMoving = false;
  /** Frames drawn since ``fpsSince`` (ms), for onFps. */
  private fpsFrames = 0;
  private fpsSince = 0;
  /** What the Physics panel was last built from (physicsChanged). */
  private physicsShown = "";
  /** Whether the camera follows ``followRun`` (the object last acted on) while its pieces move. */
  private followPhysics = true;
  private followRun?: PhysicsRun;
  /** Whether the physics has a floor (at the scene's bottom: placeFloor). */
  private floorOn = true;
  /** The Scene item the Inspector shows. */
  private selectedId: string | null = null;
  /** Items given a body on demand (setPhysicsMode): its run, its node, its holder, its mode. */
  private readonly rigid = new Map<string, { run: PhysicsRun; holder: THREE.Object3D }>();
  /** setPhysicsMode calls by item id: one awaiting a big voxelization drops out if a later call
   *  came meanwhile. */
  private readonly modeCalls = new Map<string, number>();
  /** Pending re-voxelizations of rescaled rigid items (reshapeSoon), by item id. */
  private readonly reshapes = new Map<string, ReturnType<typeof setTimeout>>();
  /** Chunked objects switched off (they take part by default). */
  private readonly physicsOff = new Set<string>();
  private clickMode: ClickMode = "select";
  /** The configured chrome and interaction (configure; the "full" preset until then), and the
   *  viewport background replacing the theme's, if any. */
  private ui: UiConfig = { ...FULL_UI, openRequest: 0 };
  private allowed: InteractionConfig = { ...FULL_INTERACTION };
  private background: THREE.Color | null = null;
  /** The gizmo on the selected item (three's TransformControls), what it does, and whether the
   *  pointer went down on it (so the click it makes selects or shoots nothing). */
  private readonly gizmo: TransformControls;
  private gizmoMode: GizmoMode = "translate";
  private gizmoPressed = false;
  /** The item's scale when a gizmo drag began (a rigid body is re-voxelized if it changed). */
  private readonly scaleBefore = new THREE.Vector3();
  private readonly canvas: HTMLCanvasElement;
  private playbackFps = 10;
  private lastStep = 0;
  // Camera roll (tilt) about the view axis, in degrees. Re-applied every frame
  // after OrbitControls.update() (which owns the un-rolled orientation).
  private rollDeg = 0;
  // On-demand rendering: render only when the camera is moving (damping) or
  // something requested a redraw, instead of re-rasterizing the cloud every frame.
  private needsRender = true;
  // The camera-path video being rendered, if any; while set, the live render loop
  // stands down (the canvas is the video's frame buffer, and shows its frames).
  private videoRender?: { cancelled: boolean };
  // Renders size points by each cloud's spacing (see adaptPoints); the spacing is
  // measured once per geometry, on its first render.
  private adaptivePointSize = true;
  private readonly pointSpacing = new WeakMap<THREE.BufferGeometry, number>();

  constructor(container: HTMLElement = document.body) {
    // Apply the default theme before reading any themed CSS var below (the
    // 3D background reads --vscode-editor-background, which the theme overrides).
    document.body.dataset.viewerTheme = this.themeName;
    const canvas = document.createElement("canvas");
    container.appendChild(canvas);
    this.canvas = canvas;

    this.scene = new THREE.Scene();
    this.scene.background = themeColor("--vscode-editor-background", 0x1e1e1e);
    this.root = new THREE.Group();
    this.scene.add(this.root);

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
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.addEventListener("end", () => this.refreshTextures());

    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.size = GIZMO_SIZE;
    this.gizmo.addEventListener("change", () => this.requestRender());
    this.gizmo.addEventListener("mouseDown", () => {
      this.gizmoPressed = true;
    });
    this.gizmo.addEventListener("mouseUp", () => {
      setTimeout(() => (this.gizmoPressed = false), 0); // after this pointerup's click handler
    });
    this.gizmo.addEventListener("dragging-changed", (e) => {
      this.controls.enabled = !e.value; // the gizmo's drag is not an orbit
      const object = this.gizmo.object;
      if (e.value && object) {
        this.scaleBefore.copy(object.scale);
      } else if (this.selectedId) {
        this.placed(this.selectedId, !this.scaleBefore.equals(object?.scale ?? this.scaleBefore));
      }
    });
    this.scene.add(this.gizmo.getHelper());

    this.interaction = new CameraInteraction({
      dom: canvas,
      camera: this.camera,
      controls: this.controls,
      root: this.root,
      reconstructions: () => this.reconstructionLayers(),
      boundsDiagonal: () => diagonalOf(this.bounds),
      onSelect: (cam) => this.onSelect?.(cam),
      requestRender: this.requestRender,
      onMiss: (ray) => this.viewClick(ray),
      ignoreClick: () => this.gizmoPressed, // a click on the gizmo selects, flies or shoots nothing
    });
    this.physics.onChange = () => this.physicsChanged();

    window.addEventListener("resize", () => this.onResize());

    // Default empty scene so the viewport is navigable before any content.
    // applyOrientation (not just fitCamera) so the default upright flip is
    // applied to `root` from the start, not only after the first U toggle.
    this.rebuildHelpers();
    this.applyOrientation();
    this.initRenderer(canvas).catch((err: unknown) => {
      console.error("3DView: no renderer", err);
      this.onError?.(`Can't start the renderer: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Bring up the renderer: WebGPU where the host has it, else three's WebGL2 backend
   * (Radix, which draws the splats, runs on either). Asynchronous — the GPU device
   * has to be requested — so nothing renders until it resolves; content added
   * meanwhile is simply drawn by the first frame. `directCanvas: false` keeps three's
   * usual sRGB output, which every material here is tuned for.
   */
  private async initRenderer(canvas: HTMLCanvasElement): Promise<void> {
    const renderer = await createRenderer({ canvas, antialias: true, directCanvas: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    // Lighting for lit mesh materials (glTF PBR, PLY/OBJ). The image-based light
    // is load-bearing, not decoration: without it metalness/roughness maps render
    // black (metals reflect the environment, not analytic lights). Intensities are
    // hand-balanced; see CLAUDE.md "PBR meshes need the environment".
    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    this.scene.environmentIntensity = 0.6;
    room.dispose(); // free the room's geometry/materials; PMREM keeps only the cubemap
    pmrem.dispose();
    this.renderer = renderer;
    this.syncSplats(); // a splat may have arrived before the renderer did
    this.animate();
    this.onChange?.(); // the panel shows which backend came up
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
      adaptivePointSize: this.adaptivePointSize,
      hasPoints: recon.some((l) => l.pointCount > 0),
      hasCameras: recon.some((l) => l.cameraCount > 0),
      hasAssets: this.layers.some((l) => l.kind === "asset"),
      hasSplat: this.assetLayers().some((l) => l.isSplat),
      hasPointCloud: this.assetLayers().some((l) => l.isPointCloud),
      trackSteps,
      trackTrail: Math.min(this.assetOpts.trackTrail, trackSteps),
      trackOpacity: this.assetOpts.trackOpacity,
      trackDensity: this.assetOpts.trackDensity,
      trackLineWidth: this.assetOpts.trackLineWidth,
      trackSmoothing: this.assetOpts.trackSmoothing,
      positionStep: roundToPowerOfTen(diagonalOf(this.bounds) / 100),
      playbackFps: this.playbackFps,
      backend: this.renderer
        ? (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
          ? "WebGPU"
          : "WebGL2"
        : null,
      physics: this.physics.runs.length === 0 ? null : {
        running: this.physics.running,
        speed: this.physics.speed,
        gravity: this.physics.gravity,
        floor: this.floorOn,
        unit: this.physics.unit,
        follow: this.followPhysics,
        status: this.physics.status,
        objects: this.layers.flatMap((l) => {
          const run = this.runOf(l);
          return run ? [{ id: l.id, label: l.label, busy: run.calibrating, status: run.status,
            breakable: run.breakable, dynamic: run.dynamic,
            strength: run.strength, shatterSpeed: run.shatterSpeed }] : [];
        }),
      },
      selected: this.selectedId,
      clickMode: this.clickMode,
      gizmoMode: this.gizmoMode,
      ui: this.ui,
      interaction: this.allowed,
      scaleLocked: this.scaleLocked(),
      items: this.layers.map((l) => ({
        id: l.id,
        label: l.label,
        kind: l.kind,
        type: itemType(l),
        physics: this.physicsModes(l),
        visible: l.visible,
        source: l.source,
        transform: readTransform(l.object),
        frameCount: l instanceof TemporalLayer ? l.frameCount : 0,
        frame: l instanceof TemporalLayer ? l.frame : 0,
        playing: l instanceof TemporalLayer && this.playingLayers.has(l),
        cameraCount: l instanceof ReconstructionLayer ? l.cameraCount : 0,
      })),
    };
  }

  addReconstruction(id: string, label: string, data: ModelData, source?: string): void {
    this.attach(this.buildReconstruction(id, label, data, source));
    this.loaded(id);
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
    const layer = new AssetLayer(id, label, uri, cloudColor(this.colorTurn++));
    this.layers.push(layer);
    this.byId.set(id, layer);
    this.root.add(layer.object);
    this.onEvent?.({ type: "itemAdded", id, label });
    layer
      .load(uri, name, this.assetOpts, (phase) => this.onProgress?.(`${label} — ${phase}`))
      .then(() => {
        layer.setVisible(true);
        if (layer.physics && this.byId.get(id) === layer) {
          this.physics.add(layer.physics); // not if it was removed while loading
        }
        // The scene state may have changed while this was loading; a no-op otherwise.
        this.syncLayerState(layer);
        this.syncSplats(); // this asset may be the scene's first splat
        this.refreshScene(this.layers.length === 1); // fit only if it's the first item
        this.loaded(id);
      })
      .catch((err: Error) => {
        if (this.byId.get(id) !== layer) return; // removed while loading: nothing failed
        this.onEvent?.({ type: "itemFailed", id, message: err.message });
        this.removeItem(id);
        this.onError?.(err.message);
      })
      // The asset bytes are fetched exactly once during load; free a blob: URL
      // (a dropped / demo file) afterward so it isn't pinned for the session. A
      // no-op on non-blob host URLs (VS Code / PyCharm).
      .finally(() => URL.revokeObjectURL(uri));
  }

  /**
   * Add several items as ONE scene item with a timeline — a capture's timesteps
   * rather than that many unrelated things in the scene.
   *
   * Frames load eagerly (they are all scrubbable the moment the item exists) and
   * SEQUENTIALLY: progress then reads as "frame k/N", peak decode pressure is one
   * frame rather than fifty concurrent Spark decodes, and a frame that fails is
   * skipped instead of taking the sequence down with it.
   */
  async addTemporal(id: string, label: string, frames: TemporalFrame[]): Promise<void> {
    if (frames.length === 0) {
      return;
    }
    const first = frames[0];
    const source = first.kind === "reconstruction" ? first.source : first.uri;
    // Attaching frame 1 fits the view if the scene was empty — on that one frame.
    // Re-fit once the rest have landed, so the first thing opened is framed by all
    // of its content and not by a prefix of it.
    const fitWhenLoaded = this.layers.length === 0;
    // ONE color for the whole sequence: its frames are timesteps of one capture, so
    // uncolored ones must not change color as the item is scrubbed or played.
    const color = cloudColor(this.colorTurn++);

    // A 3DGS sequence whose frames share a layout is taken in as ONE layer that
    // swaps between them, which is the only way the splat renderer shows a new
    // frame without first re-sorting it (see AssetLayer.showFrame).
    const clouds = await this.decodeSplatFrames(label, frames);
    if (clouds) {
      this.attachSplatSequence(id, label, source, frames, clouds, color);
      this.loaded(id);
      return;
    }

    const layer = new TemporalLayer(id, label, first.kind, source);
    for (const [at, frame] of frames.entries()) {
      const progress = (phase: string) =>
        this.onProgress?.(`${label} — frame ${at + 1}/${frames.length} — ${phase}`);
      let built: SceneLayer;
      try {
        built = await this.buildFrame(frame, progress, color);
      } catch (err) {
        this.onError?.(`${frame.label}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (layer.frameCount > 0 && !this.byId.has(id)) {
        built.dispose(); // removed from the Scene list while this frame was loading
        return;
      }
      layer.addFrame(built);
      if (layer.frameCount === 1) {
        // Show the sequence as soon as it has content, so fit-to-view lands on
        // something real and the remaining frames have somewhere to appear.
        this.attach(layer);
      }
    }
    if (layer.frameCount === 0) {
      this.onEvent?.({ type: "itemFailed", id, message: "no frame could be loaded" });
      this.onError?.(`${label}: no frame could be loaded.`);
      return;
    }
    layer.frames.forEach((f) => this.syncLayerState(f));
    this.syncSplats(); // the sequence may hold the scene's first splat
    this.refreshScene(fitWhenLoaded);
    this.loaded(id);
  }

  /**
   * Decode every frame of a would-be 3DGS sequence, and take ownership of their
   * bytes; undefined when this isn't one, leaving the files untouched for the
   * caller to load a frame at a time. Attempted only when every frame is a
   * splat-shaped file, so the give-up cases — a `.ply` that turns out to be a mesh,
   * a decode failure — cost at most the one download that revealed it.
   */
  private async decodeSplatFrames(
    label: string,
    frames: TemporalFrame[]
  ): Promise<SplatCloud[] | undefined> {
    const splatFile = (name: string) => ASSET_KIND_EXTS.splat.includes(extOf(name));
    // flatMap, not filter: it narrows the frames to the asset shape as it goes.
    const assets = frames.flatMap((f) => (f.kind === "asset" && splatFile(f.name) ? [f] : []));
    if (assets.length !== frames.length) {
      return undefined;
    }
    const clouds: SplatCloud[] = [];
    for (const [at, asset] of assets.entries()) {
      try {
        clouds.push(
          await loadSplatCloud(asset.uri, asset.name, (phase) =>
            this.onProgress?.(`${label} — frame ${at + 1}/${assets.length} — ${phase}`)
          )
        );
      } catch {
        return undefined; // not 3DGS after all, or unreadable — fall back
      }
    }
    // The bytes are ours now: free a dropped / demo blob so it isn't pinned for the
    // session, as every other loading path does once it has fetched.
    assets.forEach((asset) => URL.revokeObjectURL(asset.uri));
    return clouds;
  }

  /**
   * Add decoded splat frames as one scene item. Frames that share a packed layout
   * live in a single layer that swaps between them — the fast path, where a frame
   * shows immediately and the re-sort follows. Frames that don't get a layer each,
   * built from the clouds already decoded so nothing is fetched twice.
   */
  private attachSplatSequence(
    id: string,
    label: string,
    source: string | undefined,
    frames: TemporalFrame[],
    clouds: SplatCloud[],
    fallbackColor: number
  ): void {
    // One layer holding every frame, or one layer per frame — the same timeline
    // either way; only who owns the frames differs.
    const swappable = clouds.every((cloud) => sameSplatLayout(cloud, clouds[0]));
    const build = (held: SplatCloud[], at: number) => {
      const layer = new AssetLayer(frames[at].id, frames[at].label, source ?? label, fallbackColor);
      layer.adoptSplatFrames(held, this.assetOpts);
      this.syncLayerState(layer);
      return layer;
    };
    const temporal = new TemporalLayer(
      id,
      label,
      "asset",
      source,
      swappable ? build(clouds, 0) : undefined
    );
    if (!swappable) {
      clouds.forEach((cloud, at) => temporal.addFrame(build([cloud], at)));
    }
    this.attach(temporal); // fits the view when this is the scene's first item
    this.syncSplats(); // the sequence may hold the scene's first splat
  }

  /** One frame of a temporal item, built the same way a lone item of its kind is. */
  private async buildFrame(
    frame: TemporalFrame,
    onProgress: (phase: string) => void,
    fallbackColor: number
  ): Promise<SceneLayer> {
    if (frame.kind === "reconstruction") {
      return this.buildReconstruction(frame.id, frame.label, frame.data, frame.source);
    }
    const layer = new AssetLayer(frame.id, frame.label, frame.uri, fallbackColor);
    try {
      await layer.load(frame.uri, frame.name, this.assetOpts, onProgress);
    } finally {
      // Fetched exactly once above; free a blob: URL (a dropped / demo file) so it
      // isn't pinned for the session. A no-op on non-blob host URLs.
      URL.revokeObjectURL(frame.uri);
    }
    return layer;
  }

  /** Draw frame `frame` of a temporal item. Like setItemTransform, deliberately does
   *  NOT fire onChange — the caller is a live slider, and a panel re-render would
   *  destroy it mid-drag. */
  setItemFrame(id: string, frame: number): void {
    const layer = this.byId.get(id);
    if (layer instanceof TemporalLayer) {
      this.showFrame(layer, frame, true);
    }
  }

  /**
   * Draw one frame of a temporal item. `withTextures` is false while playing: each
   * frame carries its own frustum thumbnails, and re-running the nearest-N budget
   * ten times a second would keep the loader thrashing for images nobody can see at
   * that rate. A scrub, and the pause that ends playback, refresh them.
   */
  private showFrame(layer: TemporalLayer, frame: number, withTextures: boolean): void {
    const before = layer.frame;
    const outgoing = layer.drawnFrame;
    layer.setFrame(frame);
    if (layer.frame === before) {
      return; // clamped to the frame already drawn
    }
    if (outgoing && outgoing !== layer.drawnFrame) {
      // That frame's layer left the scene, as far as hover/selection is concerned.
      // A sequence layer stays and swaps its data, so there is nothing to drop.
      this.interaction.handleRemoved(outgoing.id);
    }
    if (layer.drawnFrame) {
      // It may have been hidden while the scene's state moved under it.
      this.syncLayerState(layer.drawnFrame);
    }
    if (withTextures) {
      this.refreshTextures();
    }
    this.requestRender();
  }

  /** Start / stop playback of a temporal item; it wraps at the end. */
  setItemPlaying(id: string, playing: boolean): void {
    const layer = this.byId.get(id);
    if (!(layer instanceof TemporalLayer)) {
      return;
    }
    if (playing && layer.frameCount > 1) {
      this.playingLayers.add(layer);
    } else {
      this.playingLayers.delete(layer);
      this.refreshTextures(); // the frame it stopped on is worth its thumbnails
    }
    this.requestRender();
  }

  /** Drive an object's physics (its Inspector). ``height``: a drop's, in metres. */
  runPhysics(id: string, action: PhysicsAction, height = 3): void {
    const run = this.physicsOf(id);
    if (!run) {
      return;
    }
    this.followRun = run;
    this.recentre(run); // the pieces go back to rest
    if (action === "reset") run.reset();
    else void run.drop(height);
    this.requestRender();
  }

  /** Select a Scene item for the Inspector (null: none). A physics object becomes the one the
   *  camera follows. */
  selectItem(id: string | null): void {
    const next = id && this.byId.has(id) ? id : null;
    if (next === this.selectedId) {
      return; // e.g. a click on empty space with nothing selected: no panel rebuild
    }
    this.selectedId = next;
    this.attachGizmo();
    this.onEvent?.({ type: "selected", id: next });
    const run = this.physicsOf(this.selectedId ?? "");
    if (run) {
      this.followRun = run;
    }
    this.onChange?.();
  }

  /** What a click in the view does; anything but Select shows a crosshair. Shoot and Blast need
   *  a physics object in the scene. */
  setClickMode(mode: ClickMode): void {
    this.clickMode = this.physics.runs.length > 0 && this.allowed.physics ? mode : "select";
    this.canvas.style.cursor = this.clickMode === "select" ? "" : "crosshair";
    this.onChange?.();
  }

  /** What the gizmo does: move, rotate or scale the selected item (scale is refused while it is
   *  locked: a breakable object with its physics on). */
  setGizmoMode(mode: GizmoMode): void {
    if (mode === "scale" && this.scaleLocked()) {
      return;
    }
    this.gizmoMode = mode;
    this.gizmo.setMode(mode);
    this.onChange?.();
    this.requestRender();
  }

  /** The selected item's scale is locked (scaleLockedFor). */
  private scaleLocked(): boolean {
    return this.scaleLockedFor(this.selectedId ? this.byId.get(this.selectedId) : undefined);
  }

  /** A breakable object whose physics is on: its welds are calibrated to its size, and its chunks
   *  are its bodies (no holder to carry a scale), so its scale stays 1. */
  private scaleLockedFor(layer: SceneLayer | undefined): boolean {
    return layer instanceof AssetLayer && layer.physics !== undefined && this.runOf(layer) !== undefined;
  }

  /** A rigid item's mode (off when it has no body). */
  private rigidMode(id: string): PhysicsMode {
    const rigid = this.rigid.get(id);
    return !rigid ? "off" : rigid.run.dynamic ? "dynamic" : "static";
  }

  /** A rescaled rigid item gets its new collision shape once the scale stops changing (a field
   *  typed in, a host streaming matrices): voxelizing is not per keystroke, and the panel is not
   *  rebuilt, so the field keeps its focus. */
  private reshapeSoon(id: string): void {
    clearTimeout(this.reshapes.get(id));
    this.reshapes.set(id, setTimeout(() => {
      this.reshapes.delete(id);
      if (this.rigid.has(id)) void this.setPhysicsMode(id, this.rigidMode(id), false);
    }, 300));
  }

  /** The gizmo on the selected item while it is shown, off otherwise; out of scale mode where
   *  scale is locked. */
  private attachGizmo(): void {
    const layer = this.selectedId ? this.byId.get(this.selectedId) : undefined;
    if (layer?.visible && this.allowed.edit) this.gizmo.attach(layer.object);
    else this.gizmo.detach();
    if (this.gizmoMode === "scale" && this.scaleLocked()) {
      this.gizmoMode = "translate";
      this.gizmo.setMode("translate");
    }
    this.requestRender();
  }

  /** An item was moved (the gizmo, the Inspector's fields, a host): its bounds, the grid, and its
   *  physics — a body rests where it is placed, whole; a rigid one rescaled gets a new shape. */
  private placed(id: string, rescaled: boolean, notify = true): void {
    const layer = this.byId.get(id);
    if (!layer) {
      return;
    }
    layer.object.updateMatrix(); // bounds below read `matrix`, not the render-time one
    if (rescaled && this.rigid.has(id)) {
      this.reshapeSoon(id); // voxelized again at the new scale
    } else {
      this.runOf(layer)?.reset();
    }
    this.recomputeBounds();
    this.rebuildHelpers(); // the grid + axes span the scene, so they follow
    this.refreshTextures();
    if (notify) {
      this.onChange?.(); // the Inspector's fields (not for a host streaming matrices)
    }
    this.requestRender();
  }

  /** Start or stop the simulation's clock (every object's). */
  playPhysics(on: boolean): void {
    if (on) void this.physics.play();
    else this.physics.pause();
  }

  /** Every chunked object back to rest, whole; the clock stops. */
  resetPhysics(): void {
    if (this.followRun) this.recentre(this.followRun);
    this.physics.resetAll();
  }

  /** Sim seconds per real second (slow motion below 1). */
  setPhysicsSpeed(speed: number): void {
    this.physics.setSpeed(speed);
  }

  /** m/s², down. */
  setPhysicsGravity(g: number): void {
    this.physics.setGravity(g);
  }

  /** A floor at the scene's bottom, or none (things fall until they are lost). */
  setPhysicsFloor(on: boolean): void {
    this.floorOn = on;
    this.placeFloor();
    this.onChange?.();
  }

  /** Metres per scene unit (COLMAP's units are arbitrary): gravity, drop heights and speeds are
   *  in metres. The physics is built again in the new units. */
  setPhysicsUnit(metres: number): void {
    this.physics.setUnit(metres);
    this.onChange?.();
  }

  /** The floor at the bottom of the scene's bounds (data y points down, so its largest y; the
   *  World's frame is the data frame turned, y up), or none. */
  private placeFloor(): void {
    this.physics.setFloor(this.floorOn ? -this.bounds.max[1] : null);
  }

  /** Run a physics preset; a volley's five shots come from the camera, through the object's
   *  middle, 10 cm apart across the view. */
  physicsPreset(id: string, name: PhysicsPreset): void {
    const run = this.physicsOf(id);
    if (!run) {
      return;
    }
    this.followRun = run;
    this.recentre(run); // a preset starts from rest
    void run.preset(name, (middle) => {
      const across = this.camera.getWorldDirection(new THREE.Vector3()).cross(this.camera.up).normalize();
      return [-2, -1, 0, 1, 2].map((i) => {
        const target = middle.clone().addScaledVector(across, 0.1 * i);
        return new THREE.Ray(this.camera.position.clone(), target.sub(this.camera.position).normalize());
      });
    });
    this.onChange?.(); // the panel's sliders show the preset's glue and shatter
  }

  setPhysicsStrength(id: string, strength: number): void {
    this.physicsOf(id)?.setStrength(strength);
  }

  /** Shatter on impact above ``speed`` m/s; Infinity turns it off. */
  setPhysicsShatterSpeed(id: string, speed: number): void {
    this.physicsOf(id)?.setShatterSpeed(speed);
  }

  /** With follow on, bring the view back to the object at rest, keeping the camera's offset to
   *  its target: the pieces are about to jump back there, and the follow only eases. */
  private recentre(run: PhysicsRun): void {
    if (this.followPhysics) {
      this.shiftView(run.middleWorld(true).sub(this.controls.target));
    }
  }

  /** Move the camera and its target together. */
  private shiftView(shift: THREE.Vector3): void {
    this.controls.target.add(shift);
    this.camera.position.add(shift);
  }

  setPhysicsFollow(on: boolean): void {
    this.followPhysics = on;
    this.onChange?.();
  }

  private physicsOf(id: string): PhysicsRun | undefined {
    const layer = this.byId.get(id);
    return layer && this.runOf(layer);
  }

  /** A layer's run while it takes part: a chunked object's own unless switched off, or the one
   *  made for it (setPhysicsMode). */
  private runOf(l: SceneLayer): PhysicsRun | undefined {
    if (l instanceof AssetLayer && l.physics) return this.physicsOff.has(l.id) ? undefined : l.physics;
    return this.rigid.get(l.id)?.run;
  }

  /** What the Inspector offers for a layer's physics (SceneItem.physics). */
  private physicsModes(l: SceneLayer): SceneItem["physics"] {
    const run = this.runOf(l);
    const shape = run?.shapeShown ?? false;
    if (l instanceof AssetLayer && l.physics) return { mode: run ? "dynamic" : "off", modes: ["off", "dynamic"], shape };
    if (l instanceof ReconstructionLayer) return { mode: this.rigidMode(l.id), modes: ["off", "static"], shape };
    if (l instanceof AssetLayer && (l.type === "mesh" || l.type === "points" || l.type === "splats") && l.frameCount === 0) {
      return { mode: this.rigidMode(l.id), modes: ["off", "static", "dynamic"], shape };
    }
    return null;
  }

  /**
   * Take an item into the physics or out of it. A breakable object goes in or out as it is (off:
   * back to rest, out of the World; on: it calibrates again). Any other item gets a body from its
   * own geometry (rigidObject.ts: voxelized, merged into boxes at the defaults for its mode);
   * dynamic, its content hangs on the body; off, the body goes and the content is back where it
   * was. Turning one on prepares the World, so it joins at once.
   */
  async setPhysicsMode(id: string, mode: PhysicsMode, notify = true): Promise<void> {
    const layer = this.byId.get(id);
    if (!layer) {
      return;
    }
    const call = (this.modeCalls.get(id) ?? 0) + 1;
    this.modeCalls.set(id, call);
    let announced = false;
    if (layer instanceof AssetLayer && layer.physics) {
      const run = layer.physics;
      if (mode === "off" && !this.physicsOff.has(id)) {
        run.reset();
        this.physics.remove(run);
        this.physicsOff.add(id);
      } else if (mode !== "off" && this.physicsOff.delete(id)) {
        if (!layer.object.scale.equals(new THREE.Vector3(1, 1, 1))) {
          layer.object.scale.set(1, 1, 1); // scaled while off: back to its own size (scaleLockedFor)
          this.placed(id, false, false);
        }
        this.physics.add(run);
        run.setEnabled(layer.visible);
      }
    } else {
      const old = this.rigid.get(id);
      const shapeShown = old?.run.shapeShown ?? false;
      if (old) {
        if (layer instanceof AssetLayer) layer.mountOn(undefined);
        this.physics.remove(old.run);
        unmountRigid(old.holder);
        this.rigid.delete(id);
      }
      const size = mode === "off" ? 0
        : layer instanceof AssetLayer ? layer.geometrySize : layer instanceof ReconstructionLayer ? layer.pointCount : 0;
      if (size > BIG_GEOMETRY) {
        // Reading and voxelizing it runs on this thread: say so, and let that paint first.
        this.onProgress?.(`${layer.label} — building its collision shape`);
        announced = true;
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (this.modeCalls.get(id) !== call || !this.byId.has(id)) {
          return; // switched again, or removed, meanwhile: the later call decides
        }
      }
      const geometry = mode === "off" ? null
        : layer instanceof AssetLayer || layer instanceof ReconstructionLayer ? layer.collisionGeometry() : null;
      if (geometry) {
        const body = mode === "dynamic" ? "dynamic" : "static";
        const { scene, node, holder } = mountRigid(layer.object, geometryShape(geometry, body, layer.object.scale));
        if (body === "dynamic" && layer instanceof AssetLayer) layer.mountOn(holder);
        const run = new PhysicsRun(scene, [node], body);
        run.setEnabled(layer.visible);
        run.setShapeVisible(shapeShown); // a new shape (rescaled) keeps the wireframe if it was on
        this.physics.add(run);
        this.rigid.set(id, { run, holder });
      }
    }
    this.physicsDropped();
    if (mode !== "off") {
      void this.physics.prepared(); // it joins the World at once
    }
    this.attachGizmo(); // a breakable object's scale locks while its physics is on
    if (notify || announced) {
      this.onChange?.(); // (also what takes the status message down)
    }
    this.requestRender();
  }

  /** The physics may have lost a run: stop following one that is gone, and leave Shoot / Blast
   *  once nothing is left to hit. */
  private physicsDropped(): void {
    if (this.followRun && !this.physics.runs.includes(this.followRun)) {
      this.followRun = undefined;
    }
    if (this.physics.runs.length === 0 && this.clickMode !== "select") {
      this.setClickMode("select");
    }
  }

  /** Draw an item's collision shape (its bodies' boxes, as a wireframe) or not. */
  setPhysicsShape(id: string, on: boolean): void {
    this.physicsOf(id)?.setShapeVisible(on);
    this.onChange?.();
    this.requestRender();
  }

  /**
   * A click in the view that hit no camera. Select: the item whose box it crosses (the smallest,
   * so an object inside a room's reconstruction wins over the room; a chunked object by its
   * pieces' current extent), or none. Shoot / Blast: the first chunk on the ray, if the ray
   * crosses a physics object's box — a click on empty space does nothing.
   */
  private viewClick(ray: THREE.Ray): void {
    const hits = this.layers.flatMap((l) => {
      const chunked = l instanceof AssetLayer && l.physics ? l.physics : undefined;
      const local = chunked ? chunked.extent() : l.bounds();
      if (!l.visible || !local) return [];
      // A dynamic rigid item is drawn through its body's holder; its bounds move with it.
      const frame = this.rigid.get(l.id)?.holder ?? l.object;
      frame.updateWorldMatrix(true, false);
      const box = new THREE.Box3(new THREE.Vector3(...local.min), new THREE.Vector3(...local.max))
        .applyMatrix4(frame.matrixWorld);
      if (!ray.intersectsBox(box)) return [];
      const size = box.getSize(new THREE.Vector3());
      return [{ layer: l, volume: size.x * size.y * size.z }];
    }).sort((a, b) => a.volume - b.volume);
    if (this.clickMode === "select") {
      if (this.allowed.select) this.selectItem(hits[0]?.layer.id ?? null);
      return;
    }
    const run = hits.map((h) => this.runOf(h.layer)).find((r) => r !== undefined);
    if (run) {
      this.followRun = run;
      void (this.clickMode === "blast" ? run.blast(ray) : run.shoot(ray));
    }
  }

  /** The physics moved or changed: every object's box and line, and the simulation's line, in
   *  place; the panel itself is rebuilt only when what it is built from changes (the clock
   *  starting or stopping, a calibration starting or ending). */
  private physicsChanged(): void {
    for (const layer of this.layers) {
      const run = this.runOf(layer);
      if (run) {
        if (layer instanceof AssetLayer && layer.physics === run) {
          layer.setBoxBounds(run.extent()); // a rigid item's box rides on its body instead
        }
        this.onPhysics?.(layer.id, run.status);
      }
    }
    this.onPhysics?.(null, this.physics.status);
    const shown = `${this.physics.running} ${this.physics.runs.map((r) => r.calibrating).join()}`;
    if (shown !== this.physicsShown) {
      this.physicsShown = shown;
      this.onChange?.();
    }
    this.requestRender();
  }

  /** How fast temporal items play back, in frames per second (shared by all of them). */
  setPlaybackFps(fps: number): void {
    this.playbackFps = fps;
  }

  setItemVisible(id: string, visible: boolean): void {
    const layer = this.byId.get(id);
    layer?.setVisible(visible);
    if (layer) {
      this.runOf(layer)?.setEnabled(visible); // a hidden object leaves the World: nothing hits it
    }
    this.attachGizmo();
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
    const rescaled = patch.scale !== undefined && !this.scaleLockedFor(layer);
    if (rescaled) {
      layer.object.scale.fromArray(patch.scale!.map((v) => Math.max(1e-3, v)));
    }
    this.placed(id, rescaled, false); // no onChange: the field being typed in keeps its focus
  }

  /**
   * Place a scene item — or `node`, a named object inside it (a glTF node) — by a
   * full 4x4 matrix, row-major: rotation, translation and scale (see SetTransformMsg).
   * Like setItemTransform it fires no `onChange`, so a host can stream it; a matrix
   * the target already has costs nothing, so a host may resend it every pass.
   */
  setItemMatrix(id: string, rowMajor: number[], node?: string): void {
    const layer = this.byId.get(id);
    const target = node ? layer?.object.getObjectByName(node) : layer?.object;
    const key = rowMajor.join();
    if (!layer || !target || rowMajor.length !== 16 || target.userData.hostMatrix === key) {
      return;
    }
    target.userData.hostMatrix = key;
    const scaleBefore = target.scale.clone();
    const m = new THREE.Matrix4();
    m.set(...(rowMajor as Parameters<THREE.Matrix4["set"]>));
    m.decompose(target.position, target.quaternion, target.scale);
    if (target === layer.object && this.scaleLockedFor(layer)) {
      target.scale.set(1, 1, 1); // a breakable object's scale stays 1 while its physics is on
    }
    target.updateMatrix(); // bounds below read `matrix`, not the render-time one
    if (target === layer.object) {
      this.placed(id, !target.scale.equals(scaleBefore), false); // its physics: reset, or a new shape
      return;
    }
    this.recomputeBounds();
    this.rebuildHelpers();
    this.refreshTextures();
    this.requestRender();
  }

  /** Put a scene item back at the origin, unrotated. */
  resetItemTransform(id: string): void {
    this.setItemTransform(id, { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
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
    if (layer instanceof TemporalLayer) {
      // Hover/selection belong to a FRAME's id, never the container's.
      layer.frames.forEach((f) => this.interaction.handleRemoved(f.id));
      this.playingLayers.delete(layer);
    }
    if (this.selectedId === id) {
      this.selectedId = null;
      this.gizmo.detach();
      this.onEvent?.({ type: "selected", id: null });
    }
    const run = this.runOf(layer);
    if (run) {
      this.physics.remove(run);
    }
    this.rigid.delete(id);
    this.physicsOff.delete(id);
    this.physicsDropped();
    clearTimeout(this.reshapes.get(id));
    this.reshapes.delete(id);
    layer.dispose();
    this.layers = this.layers.filter((l) => l !== layer);
    this.byId.delete(id);
    this.syncSplats(); // that may have been the scene's last splat
    this.recomputeBounds();
    this.rebuildHelpers();
    this.onChange?.();
    this.onEvent?.({ type: "removed", id });
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
  setTrackTrail(frames: number): void {
    this.setAssetOptions({
      trackTrail: frames >= this.trackSteps() ? Number.POSITIVE_INFINITY : frames,
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

  /** Thicken the point-track trails (screen px). Live: a fat line's width is a
   *  uniform, so nothing is rebuilt. */
  setTrackLineWidth(width: number): void {
    this.setAssetOptions({ trackLineWidth: width });
  }

  /** Smooth each trajectory along time (in steps; 0 = raw). Rebuilds the lines —
   *  it moves where the points are — but from data already decoded. */
  setTrackSmoothing(sigma: number): void {
    this.setAssetOptions({ trackSmoothing: sigma });
  }

  /** Merge a change into the scene-wide asset options and push it to every layer. */
  private setAssetOptions(patch: Partial<AssetOptions>): void {
    this.assetOpts = { ...this.assetOpts, ...patch };
    this.layers.forEach((l) => l.applyAssetOptions(this.assetOpts));
    this.syncSplats();
    this.requestRender();
  }

  /**
   * Match the splat renderer to what the scene needs — it goes up when splatting is
   * in use and comes down once no splat asset is left, since it holds GPU buffers
   * sized to what it has drawn. It belongs to the scene rather than to `root`: it
   * draws each splat object through that object's own matrixWorld. `onDirty` is what
   * makes it fit our on-demand loop — it fires when a sort lands after its frame,
   * exactly when the last frame went stale.
   */
  private syncSplats(): void {
    // A chunked object always draws as splats; a 3DGS cloud only in "splatting" mode.
    const chunked = this.assetLayers().some((l) => l.isChunked);
    const hasSplat = chunked || this.assetLayers().some((l) => l.isSplat);
    if (this.splats && !hasSplat) {
      this.splats.dispose();
      this.splats = undefined;
    } else if (!this.splats && hasSplat && (chunked || this.assetOpts.splatMode === "splatting") && this.renderer) {
      this.splats = new SplatDrawer(this.renderer, this.requestRender);
      this.scene.add(this.splats.mesh);
    }
  }

  /** One slider, two option bags: reconstructions read `opts.pointSize`, assets read
   *  the asset options (a bare PLY cloud, or a 3DGS asset in "points" mode). */
  setPointSize(size: number): void {
    this.opts.pointSize = size;
    this.reconstructionLayers().forEach((l) => l.applyOptions(this.opts));
    this.setAssetOptions({ pointSize: size }); // also requests a render
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

  /** Whether renders size points by each cloud's spacing (see adaptPoints). */
  setAdaptivePointSize(on: boolean): void {
    this.adaptivePointSize = on;
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
    this.scene.background = this.background ?? themeColor("--vscode-editor-background", 0x1e1e1e);
    this.requestRender();
  }

  /**
   * Apply an embedding configuration (messages.ts ViewerConfig): the fields given merge into the
   * current ones, a preset first if it names one. The look goes to the setters a person's clicks
   * use; the chrome and what a person may do are kept (ViewerState.ui / .interaction) and acted on
   * where they apply.
   */
  configure(config: ViewerConfig): void {
    const c = expand(config);
    if (c.theme) this.setTheme(c.theme);
    if (c.background !== undefined) {
      this.background = c.background === null ? null : new THREE.Color(c.background);
      this.setTheme(this.themeName); // re-reads the viewport background
    }
    for (const [name, on] of Object.entries(c.show ?? {})) {
      if (on !== undefined) this.setGlobal(name as GlobalToggle, on);
    }
    if (c.upright !== undefined) this.setOrientation(c.upright ? "upright" : "raw");
    if (c.splatMode) this.setSplatMode(c.splatMode);
    const { panels, open, ...rest } = c.ui ?? {};
    this.ui = { ...this.ui, ...rest };
    if (panels !== undefined) this.ui.panels = panels || [];
    if (open !== undefined) this.ui = { ...this.ui, open, openRequest: this.ui.openRequest + 1 };
    this.allowed = { ...this.allowed, ...c.interaction };
    if (!this.allowed.select) this.selectItem(null);
    if (!this.allowed.physics && this.clickMode !== "select") this.setClickMode("select");
    this.attachGizmo(); // none without `edit`
    this.onChange?.();
  }

  /** The chrome and what a person may do, as configured (configure). */
  get settings(): { ui: UiConfig; interaction: InteractionConfig } {
    return { ui: this.ui, interaction: this.allowed };
  }

  requestAdd(kind: AddKind): void {
    this.onRequestAdd?.(kind);
  }

  resetView(): void {
    this.fitCamera();
  }

  /** Make `position` looking at `target` (scene frame) the home view, and go there. */
  setHomeView(position: Vec3, target: Vec3): void {
    this.homeView = { position, target };
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
    this.onEvent?.({ type: "itemAdded", id: layer.id, label: layer.label });
    this.refreshScene(first);
  }

  /** Tell the host an item is all drawn, with its box in the scene's frame (placement included);
   *  nothing when it was removed meanwhile. */
  private loaded(id: string): void {
    const layer = this.byId.get(id);
    if (!layer) return;
    layer.object.updateMatrix();
    const local = layer.bounds();
    this.onEvent?.({ type: "itemLoaded", id, bounds: local ? transformBounds(local, layer.object.matrix) : null });
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

  /**
   * Every layer the scene actually DRAWS: the top-level layers, with a temporal item
   * replaced by its drawn frame. The kind filters below go through this, so a
   * sequence's frames — real layers nested inside it, invisible to a top-level kind
   * test — are reachable, while the frames waiting off-screen stay out of the
   * texture budget, the derived state flags and camera picking.
   */
  private drawnLayers(): SceneLayer[] {
    return this.layers.flatMap((l) => (l instanceof TemporalLayer ? (l.drawnFrame ?? []) : l));
  }

  private reconstructionLayers(): ReconstructionLayer[] {
    return this.drawnLayers().filter(
      (l): l is ReconstructionLayer => l.kind === "reconstruction"
    );
  }

  private assetLayers(): AssetLayer[] {
    return this.drawnLayers().filter((l): l is AssetLayer => l.kind === "asset");
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
    this.placeFloor(); // the floor follows the scene's bottom
  }

  private rebuildHelpers(): void {
    disposeObject(this.grid);
    disposeObject(this.axes);
    this.axes = new THREE.AxesHelper(diagonalOf(this.bounds) * 0.5);
    this.axes.visible = this.showAxes;
    // Drawn after the grid, whose center lines it lies exactly on: at equal depth the
    // later draw wins, and the WebGPU renderer's own order would let the grid win.
    this.axes.renderOrder = 1;
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
    if (this.homeView) {
      // The home view is in the scene's frame; the root carries the Upright flip.
      this.camera.position.fromArray(this.homeView.position).applyMatrix4(this.root.matrixWorld);
      this.controls.target.fromArray(this.homeView.target).applyMatrix4(this.root.matrixWorld);
    } else {
      // The FOV is vertical, so a portrait screen (a phone) sees a narrower slice
      // across: back off by 1/aspect there to keep the scene's width in view too.
      const off = (diag * 0.6) / Math.min(1, this.camera.aspect);
      this.camera.position.set(center.x + off, center.y + off, center.z + off);
      this.controls.target.copy(center);
    }
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  /**
   * Render the current viewpoint at `scale`× the on-screen resolution and hand the
   * resulting PNG (data URL) to `onSaveFile` to save. The 3D canvas
   * only (no UI overlay) is captured, with a fully transparent background (the
   * viewer background color is dropped). Guards against exceeding the GPU's max buffer.
   */
  saveViewpoint(scale: number): void {
    const renderer = this.renderer;
    if (this.videoRender || !renderer) {
      return; // the drawing buffer is a video frame until renderCameraPath is done
    }
    const maxDim = getGpuCaps(renderer).maxTextureSize;
    const w = Math.round(window.innerWidth * scale);
    const h = Math.round(window.innerHeight * scale);
    if (w > maxDim || h > maxDim) {
      this.onError?.(`Image too large (${w}×${h}px); max ${maxDim}px per side — try a lower scale.`);
      return;
    }
    // Enlarge the drawing buffer (keeping CSS size, so layout doesn't jump), render,
    // then read it back with toDataURL() in the same task — on both backends the
    // canvas still holds this render then, not a stale frame.
    // Drop the opaque scene.background and clear to alpha 0 so the PNG is transparent;
    // restore both afterwards so the live view keeps its background color.
    const prevRatio = renderer.getPixelRatio();
    const prevBackground = this.scene.background;
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    this.scene.background = null;
    renderer.setClearColor(0x000000, 0);
    const points = this.adaptPoints(scale);
    points.fit(this.camera.fov);
    this.draw(this.camera);
    points.restore();
    const png = renderer.domElement.toDataURL("image/png");
    this.scene.background = prevBackground;
    renderer.setPixelRatio(prevRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    this.requestRender();
    this.onSaveFile?.(png, `viewpoint-${scale}x.png`);
  }

  /** Whether a camera-path video is being rendered (see renderCameraPath). */
  get isRenderingVideo(): boolean {
    return this.videoRender !== undefined;
  }

  /** Stop the camera-path video being rendered; nothing is saved. */
  cancelVideo(): void {
    if (this.videoRender) {
      this.videoRender.cancelled = true;
    }
  }

  /**
   * Render a video flying through a reconstruction's cameras and hand it to
   * `onSaveFile`. Frames are the cameras' own views (their pose and vertical FOV,
   * unless `fov` overrides it; principal point assumed centered) at `scale`× the
   * first camera's image size,
   * drawn with a camera of its own so the interactive view is left as it was.
   * Frustums and their images are hidden meanwhile: at a camera's own pose, its
   * image plane would fill the frame. Progress goes to `onProgress`.
   */
  async renderCameraPath(video: CameraPathVideo): Promise<void> {
    const layer = this.byId.get(video.itemId);
    const renderer = this.renderer;
    if (this.videoRender || !renderer || !(layer instanceof ReconstructionLayer) || layer.cameraCount === 0) {
      return;
    }
    const cameras = orderCameras(layer.data.cameras);
    this.root.updateMatrixWorld(true); // also refreshes layer.object.matrixWorld
    const keys = cameras.map((c) => cameraPose(c, layer.object.matrixWorld, DEFAULT_FOV));
    const frames = samplePath(keys, video.framesPerCamera, video.loop);
    // H.264 needs even dimensions.
    const even = (v: number) => Math.max(2, 2 * Math.round(v / 2));
    const w = even(cameras[0].width * video.scale);
    const h = even(cameras[0].height * video.scale);
    const maxDim = getGpuCaps(renderer).maxTextureSize;
    if (w > maxDim || h > maxDim) {
      this.onError?.(`Video too large (${w}×${h}px); max ${maxDim}px per side — try a lower scale.`);
      return;
    }

    const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, w / h, this.camera.near, this.camera.far);
    const frustums = this.reconstructionLayers().map((l) => l.cameras.object);
    const frustumsShown = frustums.map((o) => o.visible);
    const prevRatio = renderer.getPixelRatio();
    const render = (this.videoRender = { cancelled: false });
    const points = this.adaptPoints(h / window.innerHeight);
    frustums.forEach((o) => (o.visible = false));
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    try {
      const result = await encodeVideo(
        renderer.domElement,
        frames.length,
        video.fps,
        async (i) => {
          this.onProgress?.(`Rendering video: frame ${i + 1} of ${frames.length}`);
          camera.position.copy(frames[i].position);
          camera.quaternion.copy(frames[i].quaternion);
          camera.fov = video.fov ?? frames[i].fov;
          camera.updateProjectionMatrix();
          points.fit(camera.fov);
          await this.renderSettled(camera);
        },
        () => render.cancelled
      );
      if (result) {
        this.onSaveFile?.(result.dataUrl, `camera-path.${result.extension}`);
      }
    } catch (err) {
      this.onError?.(`Video render failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.videoRender = undefined;
      points.restore();
      frustums.forEach((o, i) => (o.visible = frustumsShown[i]));
      renderer.setPixelRatio(prevRatio);
      renderer.setSize(window.innerWidth, window.innerHeight);
      this.requestRender();
      this.onChange?.(); // clears the progress status
    }
  }

  /**
   * For a render at `renderScale`× the on-screen pixel size (by height): swap every
   * point cloud's material for one sized by the cloud's own spacing (PointCloud.adapt),
   * so the render fills in instead of thinning out at its higher resolution. Each
   * cloud is never drawn thinner than it looks on screen. `fit` sizes the points for
   * a camera's FOV; `restore` puts the live materials back. A no-op when adaptive
   * sizing is off.
   */
  private adaptPoints(renderScale: number): { fit(fov: number): void; restore(): void } {
    const swapped: { fit(fov: number): void; restore(): void }[] = [];
    if (this.adaptivePointSize) {
      this.root.updateMatrixWorld(true);
      this.root.traverse((object) => {
        if (!(object instanceof PointCloud)) {
          return;
        }
        let spacing = this.pointSpacing.get(object.points);
        if (spacing === undefined) {
          spacing = estimatePointSpacing(object.points.getAttribute("position").array);
          this.pointSpacing.set(object.points, spacing);
        }
        const adaptive = object.adapt(spacing * object.matrixWorld.getMaxScaleOnAxis());
        const minPx = object.pointSize * renderScale;
        // Cap: a point at the lens at most 1/20 of the frame height.
        const maxPx = Math.max(minPx, (window.innerHeight * renderScale) / 20);
        swapped.push({ fit: (fov) => adaptive.fit(fov, minPx, maxPx), restore: adaptive.restore });
      });
    }
    return {
      fit: (fov) => swapped.forEach((s) => s.fit(fov)),
      restore: () => swapped.forEach((s) => s.restore()),
    };
  }

  /** Render `camera`'s view, handing the splat renderer what the scene shows first. */
  private draw(camera: THREE.Camera, live = false): void {
    this.gizmo.getHelper().visible = live && this.gizmo.object !== undefined; // never in a capture
    this.splats?.gather(this.scene);
    this.renderer!.render(this.scene, camera);
  }

  /**
   * Draw `camera`'s view. On the WebGL2 backend splats are sorted per viewpoint on a
   * worker, so a first draw from a new viewpoint uses the previous order: wait for the
   * sort to land and draw again (bounded, on a timer — rAF may not fire in a hidden
   * webview). WebGPU sorts within the frame, so its first draw is already settled.
   */
  private async renderSettled(camera: THREE.PerspectiveCamera): Promise<void> {
    this.draw(camera);
    if (this.splats?.sortsLater) {
      await this.splats.nextSort(1000);
      this.draw(camera);
    }
  }

  private onResize(): void {
    if (this.videoRender) {
      return; // the drawing buffer is the video's size; renderCameraPath restores it after
    }
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer?.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer?.setSize(window.innerWidth, window.innerHeight);
    this.requestRender();
  }

  /** Request a redraw on the next frame (for changes that don't move the camera). */
  private requestRender = (): void => {
    this.needsRender = true;
  };

  /**
   * Step every playing temporal item, at most once per 1/fps. Rides the animation
   * loop rather than a timer of its own, so it can't outlive the viewer or fire
   * while the tab is hidden; the frame it advances to is what requestRender draws.
   */
  private advancePlayback(): void {
    if (this.playingLayers.size === 0) {
      this.lastStep = 0;
      return;
    }
    const now = performance.now();
    if (now - this.lastStep < 1000 / this.playbackFps) {
      return;
    }
    this.lastStep = now;
    for (const layer of this.playingLayers) {
      this.showFrame(layer, (layer.frame + 1) % layer.frameCount, false);
      this.onFrame?.(layer.id, layer.frame);
    }
  }

  /**
   * Step the physics (physics/run.ts keeps its own fixed clock). Draws, and
   * re-sorts the splats (the chunks moved relative to each other), only while something moves:
   * once every body sleeps the loop is idle again.
   */
  private advancePhysics(): void {
    if (this.physics.tick(performance.now())) {
      this.splats?.requestSort();
      this.needsRender = true;
      this.physicsMoving = true;
      this.physicsChanged();
      if (this.followPhysics && this.followRun) {
        // Ease the view toward its median piece, keeping the camera's offset (the prototype's).
        this.shiftView(this.followRun.middleWorld().sub(this.controls.target).multiplyScalar(0.05));
      }
    } else if (this.physicsMoving) {
      this.physicsMoving = false;
      this.physicsChanged(); // it just came to rest: say so once
    }
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    if (this.videoRender) {
      return; // renderCameraPath owns the canvas until it's done
    }
    this.advancePlayback();
    this.advancePhysics();
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
      this.draw(this.camera, true);
      this.needsRender = false;
      this.fpsFrames++;
    }
    const now = performance.now();
    if (now - this.fpsSince >= 500) {
      this.onFps?.(this.fpsFrames ? Math.round((1000 * this.fpsFrames) / (now - this.fpsSince)) : null);
      this.fpsFrames = 0;
      this.fpsSince = now;
    }
  };
}

/** An object's placement in the units the transform fields edit: metres and degrees. */
function readTransform(object: THREE.Object3D): ItemTransform {
  const { x, y, z } = object.rotation;
  return {
    position: object.position.toArray() as Vec3,
    rotation: [x, y, z].map(THREE.MathUtils.radToDeg) as Vec3,
    scale: object.scale.toArray() as Vec3,
  };
}

/** Round down to the nearest power of ten (1, 0.1, 0.01, …), so a nudge step reads
 *  as a round number whatever the scene's scale. Zero-safe. */
function roundToPowerOfTen(value: number): number {
  return value > 0 ? 10 ** Math.floor(Math.log10(value)) : 0.01;
}
