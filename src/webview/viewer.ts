// The scene controller: owns the renderer, scene graph, camera, and interaction,
// and exposes a small imperative API the UI drives. All renderable content hangs
// off `root`, whose rotation implements the raw<->upright-Y-up toggle.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ModelData, CameraView, Bounds } from "../shared/messages";
import { themeColor } from "./theme";
import { ThumbnailLoader } from "./textures";
import { CameraLayer } from "./cameraLayer";
import {
  buildPoints,
  buildGrid,
  buildBox,
  computeLocalBounds,
  diagonalOf,
  unionBounds,
  disposeObject,
} from "./builders";
import { loadMesh } from "./meshLayer";

const DEFAULT_FOV = 60;
const CLICK_DRAG_TOLERANCE_PX = 5;

export type Layer = "points" | "frustums" | "images" | "box" | "grid" | "axes" | "mesh";
export type Orientation = "raw" | "upright";

/** Read-only snapshot of view state, for the UI to render controls from. */
export interface ViewerState {
  points: boolean;
  frustums: boolean;
  images: boolean;
  box: boolean;
  grid: boolean;
  axes: boolean;
  mesh: boolean;
  orientation: Orientation;
  pointSize: number;
  frustumScale: number;
  frustumScaleMax: number;
  // Which content is present, so the UI can show only relevant controls.
  hasPoints: boolean;
  hasCameras: boolean;
  hasMesh: boolean;
}

/** What content is currently loaded, for status text and the panel header. */
export interface ViewerSummary {
  points: number;
  cameras: number;
  meshName?: string;
}

export class Viewer {
  /** Fired with the selected camera on POV entry, and with null on exit. */
  onSelect?: (camera: CameraView | null) => void;
  /** Fired after loaded content changes (model set, mesh loaded). */
  onChange?: () => void;
  /** Fired when async content (e.g. a mesh) fails to load. */
  onError?: (message: string) => void;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly root: THREE.Group;
  private readonly cameras: CameraLayer;

  private points?: THREE.Points;
  private grid?: THREE.GridHelper;
  private box?: THREE.Box3Helper;
  private axes?: THREE.AxesHelper;
  private meshObject?: THREE.Object3D;

  private data?: ModelData;
  private modelBounds?: Bounds;
  private meshBounds?: Bounds;
  private meshName?: string;
  private bounds: Bounds = { min: [-1, -1, -1], max: [1, 1, 1] }; // union, for fit

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private pointerDown?: { x: number; y: number };
  private povActive = false;

  private readonly visibility: Record<Layer, boolean> = {
    points: true,
    frustums: true,
    images: true,
    box: true,
    grid: true,
    axes: false,
    mesh: true,
  };
  private orientation: Orientation = "raw";
  private pointSize = 1.5;
  private frustumScale = 0;
  private frustumScaleMax = 1;

  constructor(container: HTMLElement = document.body) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = themeColor("--vscode-editor-background", 0x1e1e1e);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    // Lighting for lit mesh materials (glTF PBR, PLY/OBJ). Point clouds, frustum
    // lines, and image planes use unlit materials and are unaffected.
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

    this.cameras = new CameraLayer(new ThumbnailLoader());
    this.root.add(this.cameras.object);

    window.addEventListener("resize", () => this.onResize());
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", (e) => {
      this.pointerDown = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener("pointerup", (e) => this.onPointerUp(e));
    el.addEventListener("pointermove", (e) => this.onPointerMove(e));

    this.animate();
  }

  // --- Public API -----------------------------------------------------------
  getState(): ViewerState {
    return {
      ...this.visibility,
      orientation: this.orientation,
      pointSize: this.pointSize,
      frustumScale: this.frustumScale,
      frustumScaleMax: this.frustumScaleMax,
      hasPoints: (this.data?.count ?? 0) > 0,
      hasCameras: (this.data?.cameras.length ?? 0) > 0,
      hasMesh: this.meshObject != null,
    };
  }

  getSummary(): ViewerSummary {
    return {
      points: this.data?.count ?? 0,
      cameras: this.data?.cameras.length ?? 0,
      meshName: this.meshName,
    };
  }

  setModel(data: ModelData): void {
    this.data = data;
    this.modelBounds = computeLocalBounds(data);
    this.frustumScaleMax = diagonalOf(this.modelBounds) * 0.16;
    this.frustumScale = this.frustumScaleMax / 80;
    this.resetPovState();

    disposeObject(this.points);
    disposeObject(this.box);
    this.points = this.box = undefined;

    if (data.count > 0) {
      this.points = buildPoints(data, this.pointSize);
      this.points.visible = this.visibility.points;
      this.root.add(this.points);

      this.box = buildBox(data.bounds);
      this.box.visible = this.visibility.box;
      this.root.add(this.box);
    }

    this.cameras.build(data, this.frustumScale, this.visibility.images);
    this.cameras.setVisible(this.visibility.frustums);

    this.recomputeBounds();
    this.rebuildHelpers();
    this.applyOrientation();
    this.refreshTextures();
    this.onChange?.();
  }

  /** Load a mesh and add it to the scene, coexisting with any COLMAP content. */
  setMesh(uri: string, name: string): void {
    loadMesh(uri, name)
      .then(({ object, bounds }) => {
        disposeObject(this.meshObject);
        this.meshObject = object;
        this.meshBounds = bounds;
        this.meshName = name;
        object.visible = this.visibility.mesh;
        this.root.add(object);
        this.recomputeBounds();
        this.rebuildHelpers();
        this.fitCamera();
        this.onChange?.();
      })
      .catch((err: Error) => this.onError?.(err.message));
  }

  setVisible(layer: Layer, visible: boolean): void {
    this.visibility[layer] = visible;
    switch (layer) {
      case "points":
        if (this.points) this.points.visible = visible;
        break;
      case "frustums":
        this.cameras.setVisible(visible);
        break;
      case "images":
        this.rebuildCameras();
        break;
      case "box":
        if (this.box) this.box.visible = visible;
        break;
      case "grid":
        if (this.grid) this.grid.visible = visible;
        break;
      case "axes":
        if (this.axes) this.axes.visible = visible;
        break;
      case "mesh":
        if (this.meshObject) this.meshObject.visible = visible;
        break;
    }
  }

  toggle(layer: Layer): void {
    this.setVisible(layer, !this.visibility[layer]);
  }

  setPointSize(size: number): void {
    this.pointSize = size;
    const mat = this.points?.material as THREE.PointsMaterial | undefined;
    if (mat) {
      mat.size = size;
    }
  }

  setFrustumScale(scale: number): void {
    this.frustumScale = scale;
    this.rebuildCameras();
  }

  setOrientation(orientation: Orientation): void {
    this.orientation = orientation;
    this.applyOrientation();
  }

  toggleOrientation(): void {
    this.setOrientation(this.orientation === "upright" ? "raw" : "upright");
  }

  resetView(): void {
    this.fitCamera();
  }

  /** Leave point-of-view mode and restore the global orbit view. */
  exitPov(): void {
    this.deselect();
    this.fitCamera();
  }

  // --- Internals ------------------------------------------------------------
  private rebuildCameras(): void {
    if (!this.data) {
      return;
    }
    this.cameras.build(this.data, this.frustumScale, this.visibility.images);
    this.cameras.setVisible(this.visibility.frustums);
    this.deselect();
    this.refreshTextures();
  }

  private applyOrientation(): void {
    // COLMAP is +y down / +z forward; "upright" flips 180° about x to read y-up.
    this.root.rotation.set(this.orientation === "upright" ? Math.PI : 0, 0, 0);
    this.fitCamera();
  }

  /** Fit bounds = union of whatever content is present (point/camera + mesh). */
  private recomputeBounds(): void {
    const parts: Bounds[] = [];
    if (this.data && this.modelBounds) {
      parts.push(this.modelBounds);
    }
    if (this.meshObject && this.meshBounds) {
      parts.push(this.meshBounds);
    }
    this.bounds = unionBounds(parts);
  }

  /** Rebuild grid + axes to match the current union bounds. */
  private rebuildHelpers(): void {
    disposeObject(this.grid);
    disposeObject(this.axes);
    this.axes = new THREE.AxesHelper(diagonalOf(this.bounds) * 0.5);
    this.axes.visible = this.visibility.axes;
    this.root.add(this.axes);
    this.grid = buildGrid(this.bounds);
    this.grid.visible = this.visibility.grid;
    this.root.add(this.grid);
  }

  private refreshTextures(): void {
    this.root.updateMatrixWorld(true);
    this.cameras.refreshTextures(this.camera.position, this.root.matrixWorld);
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
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  // --- Picking / selection --------------------------------------------------
  private onPointerUp(e: PointerEvent): void {
    if (!this.pointerDown) {
      return;
    }
    const moved = Math.hypot(e.clientX - this.pointerDown.x, e.clientY - this.pointerDown.y);
    this.pointerDown = undefined;
    if (moved > CLICK_DRAG_TOLERANCE_PX) {
      return; // an orbit drag, not a click
    }
    const index = this.pick(e.clientX, e.clientY);
    if (index >= 0) {
      this.select(index);
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.pointerDown) {
      return; // ignore movement while orbiting
    }
    const index = this.pick(e.clientX, e.clientY);
    this.cameras.setHover(index);
    document.body.style.cursor = index >= 0 ? "pointer" : "default";
  }

  private pick(clientX: number, clientY: number): number {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.raycaster.params.Line.threshold = this.frustumScale * 0.2;
    return this.cameras.pick(this.raycaster);
  }

  private select(index: number): void {
    if (!this.data) {
      return;
    }
    this.cameras.select(index);
    const cam = this.data.cameras[index];
    this.flyToCamera(cam);
    this.povActive = true;
    this.onSelect?.(cam);
  }

  private deselect(): void {
    this.cameras.clearSelection();
    if (this.povActive) {
      this.camera.fov = DEFAULT_FOV;
      this.camera.up.set(0, 1, 0);
      this.camera.updateProjectionMatrix();
    }
    this.povActive = false;
    this.onSelect?.(null);
  }

  private resetPovState(): void {
    this.cameras.clearSelection();
    this.povActive = false;
    this.camera.fov = DEFAULT_FOV;
    this.camera.up.set(0, 1, 0);
    this.camera.updateProjectionMatrix();
    this.onSelect?.(null);
  }

  /** Position the viewer camera at a reconstruction camera, looking where it did. */
  private flyToCamera(cam: CameraView): void {
    this.root.updateMatrixWorld(true);
    const m = cam.worldFromCamera; // row-major, maps camera dir -> world (local)
    const center = new THREE.Vector3(
      cam.center[0],
      cam.center[1],
      cam.center[2]
    ).applyMatrix4(this.root.matrixWorld);
    // COLMAP camera looks down +z; image +y is down, so view-up is -y axis.
    const forward = new THREE.Vector3(m[2], m[5], m[8])
      .transformDirection(this.root.matrixWorld)
      .normalize();
    const up = new THREE.Vector3(-m[1], -m[4], -m[7])
      .transformDirection(this.root.matrixWorld)
      .normalize();
    const dist = diagonalOf(this.bounds) * 0.15;

    this.camera.up.copy(up);
    this.camera.position.copy(center);
    this.controls.target.copy(center.clone().addScaledVector(forward, dist));
    if (cam.fy > 0) {
      const fovY = THREE.MathUtils.radToDeg(2 * Math.atan(cam.height / 2 / cam.fy));
      if (Number.isFinite(fovY) && fovY > 1 && fovY < 170) {
        this.camera.fov = fovY;
      }
    }
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
}
