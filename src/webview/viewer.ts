// The scene controller: owns the renderer, scene graph, camera, and interaction.
// A scene is a list of SceneLayers (reconstructions + meshes) under `root`, whose
// rotation implements the raw<->upright-Y-up toggle. The UI drives this via a
// small imperative API; the Viewer owns all state.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CameraView, Bounds, ModelData, AddKind } from "../shared/messages";
import { themeColor } from "./theme";
import { buildGrid, diagonalOf, unionBounds, computeLocalBounds, disposeObject } from "./builders";
import { SceneLayer, ReconstructionLayer, DisplayOptions } from "./sceneLayer";
import { MeshLayer } from "./meshLayer";
import { CameraInteraction, DEFAULT_FOV } from "./cameraInteraction";

// Cap render resolution: above this, HiDPI fill/memory cost (∝ ratio²) isn't
// worth the marginal sharpness for point clouds. Never below 1.
const MAX_PIXEL_RATIO = 1.5;

/** Scene-wide toggles the control panel exposes. */
export type GlobalToggle = "points" | "frustums" | "images" | "box" | "grid" | "axes";
export type Orientation = "raw" | "upright";

/** One entry in the Scene list. */
export interface SceneItem {
  id: string;
  label: string;
  kind: "reconstruction" | "mesh";
  visible: boolean;
}

/** Read-only snapshot of view state, for the UI to render controls from. */
export interface ViewerState {
  points: boolean;
  frustums: boolean;
  images: boolean;
  box: boolean;
  grid: boolean;
  axes: boolean;
  orientation: Orientation;
  pointSize: number;
  frustumScale: number;
  frustumScaleMax: number;
  hasPoints: boolean;
  hasCameras: boolean;
  hasMesh: boolean;
  items: SceneItem[];
}

export class Viewer {
  /** Fired with the selected camera on POV entry, and with null on exit. */
  onSelect?: (camera: CameraView | null) => void;
  /** Fired after the scene's content or layout changes. */
  onChange?: () => void;
  /** Fired when async content (e.g. a mesh) fails to load. */
  onError?: (message: string) => void;
  /** Fired when the "+" add action is invoked (the host opens a picker). */
  onRequestAdd?: (kind: AddKind) => void;
  /** Fired when an item is removed, so the host can forget it. */
  onRemoveItem?: (id: string) => void;

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
  private bounds: Bounds = { min: [-1, -1, -1], max: [1, 1, 1] };

  // Scene-wide display state.
  private readonly opts: DisplayOptions = {
    points: true,
    frustums: true,
    images: true,
    box: true,
    pointSize: 1.5,
    frustumScale: 0,
  };
  private showGrid = true;
  private showAxes = false;
  private orientation: Orientation = "raw";
  private frustumScaleMax = 1;
  private frustumInitialized = false;
  // On-demand rendering: render only when the camera is moving (damping) or
  // something requested a redraw, instead of re-rasterizing the cloud every frame.
  private needsRender = true;

  constructor(container: HTMLElement = document.body) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = themeColor("--vscode-editor-background", 0x1e1e1e);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    // Lighting for lit mesh materials (glTF PBR, PLY/OBJ). Unlit point clouds,
    // frustum lines, and image planes are unaffected.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 2.5));
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
      frustumScale: () => this.opts.frustumScale,
      boundsDiagonal: () => diagonalOf(this.bounds),
      onSelect: (cam) => this.onSelect?.(cam),
      requestRender: this.requestRender,
    });

    window.addEventListener("resize", () => this.onResize());

    // Default empty scene so the viewport is navigable before any content.
    this.rebuildHelpers();
    this.fitCamera();
    this.animate();
  }

  // --- Public API -----------------------------------------------------------
  getState(): ViewerState {
    const recon = this.reconstructionLayers();
    return {
      points: this.opts.points,
      frustums: this.opts.frustums,
      images: this.opts.images,
      box: this.opts.box,
      grid: this.showGrid,
      axes: this.showAxes,
      orientation: this.orientation,
      pointSize: this.opts.pointSize,
      frustumScale: this.opts.frustumScale,
      frustumScaleMax: this.frustumScaleMax,
      hasPoints: recon.some((l) => l.pointCount > 0),
      hasCameras: recon.some((l) => l.cameraCount > 0),
      hasMesh: this.layers.some((l) => l.kind === "mesh"),
      items: this.layers.map((l) => ({
        id: l.id,
        label: l.label,
        kind: l.kind,
        visible: l.visible,
      })),
    };
  }

  addReconstruction(id: string, label: string, data: ModelData): void {
    if (!this.frustumInitialized) {
      const b = computeLocalBounds(data);
      this.frustumScaleMax = diagonalOf(b) * 0.16;
      this.opts.frustumScale = this.frustumScaleMax / 80;
      this.frustumInitialized = true;
    }
    this.attach(new ReconstructionLayer(id, label, data, this.opts, this.requestRender));
  }

  addMesh(id: string, label: string, uri: string, name: string): void {
    const layer = new MeshLayer(id, label);
    this.layers.push(layer);
    this.byId.set(id, layer);
    this.root.add(layer.object);
    layer
      .load(uri, name)
      .then(() => {
        layer.setVisible(true);
        layer.setBoxVisible(this.opts.box);
        this.refreshScene(this.layers.length === 1); // fit only if it's the first item
      })
      .catch((err: Error) => {
        this.removeItem(id);
        this.onError?.(err.message);
      });
  }

  setItemVisible(id: string, visible: boolean): void {
    this.byId.get(id)?.setVisible(visible);
    this.requestRender();
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
        // Boxes wrap both reconstructions and meshes.
        this.opts.box = on;
        this.layers.forEach((l) => l.setBoxVisible(on));
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

  setOrientation(orientation: Orientation): void {
    this.orientation = orientation;
    this.applyOrientation();
  }

  toggleOrientation(): void {
    this.setOrientation(this.orientation === "upright" ? "raw" : "upright");
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

  private recomputeBounds(): void {
    const parts = this.layers
      .map((l) => l.bounds())
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
    this.root.updateMatrixWorld(true);
    this.reconstructionLayers().forEach((l) =>
      l.refreshTextures(this.camera.position, this.root.matrixWorld)
    );
  }

  private applyOrientation(): void {
    // COLMAP is +y down / +z forward; "upright" flips 180° about x to read y-up.
    this.root.rotation.set(this.orientation === "upright" ? Math.PI : 0, 0, 0);
    this.fitCamera();
  }

  private fitCamera(): void {
    this.root.updateMatrixWorld(true);
    const { min, max } = this.bounds;
    const wMin = new THREE.Vector3(Infinity, Infinity, Infinity);
    const wMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const c = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      c.set(
        i & 1 ? max[0] : min[0],
        i & 2 ? max[1] : min[1],
        i & 4 ? max[2] : min[2]
      ).applyMatrix4(this.root.matrixWorld);
      wMin.min(c);
      wMax.max(c);
    }
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
    if (moving || this.needsRender) {
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  };
}
