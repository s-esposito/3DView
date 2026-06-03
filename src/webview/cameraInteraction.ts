// Camera-frustum interaction: hover highlighting, click-to-select, and flying
// the viewer camera into a selected camera's point of view. Picking spans all
// reconstruction layers (each frustum group is stamped with its layer id). Kept
// separate from the Viewer so scene composition and interaction evolve apart.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CameraView } from "../shared/messages";
import type { ReconstructionLayer } from "./sceneLayer";
import type { CameraHit } from "./cameraLayer";

export const DEFAULT_FOV = 60;
const CLICK_DRAG_TOLERANCE_PX = 5;

export interface InteractionDeps {
  dom: HTMLElement;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  root: THREE.Group;
  /** Current reconstruction layers (cameras live in these). */
  reconstructions: () => ReconstructionLayer[];
  /** Current global frustum scale, for the line-pick threshold. */
  frustumScale: () => number;
  /** World-space diagonal of the scene, for the POV pivot distance. */
  boundsDiagonal: () => number;
  /** Notified with the selected camera on POV entry, and null on exit. */
  onSelect: (cam: CameraView | null) => void;
}

export class CameraInteraction {
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private pointerDown?: { x: number; y: number };
  private hovered?: CameraHit;
  private selected?: CameraHit;
  private povActive = false;

  constructor(private readonly deps: InteractionDeps) {
    const el = deps.dom;
    el.addEventListener("pointerdown", (e) => {
      this.pointerDown = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener("pointerup", (e) => this.onPointerUp(e));
    el.addEventListener("pointermove", (e) => this.onPointerMove(e));
  }

  /** Leave point-of-view mode (the Viewer re-fits the global view afterwards). */
  exitPov(): void {
    this.deselect();
  }

  /** Drop hover/selection that referenced a layer being removed. */
  handleRemoved(layerId: string): void {
    if (this.selected?.layerId === layerId) {
      this.deselect();
    }
    if (this.hovered?.layerId === layerId) {
      this.hovered = undefined;
    }
  }

  // --- Pointer handling -----------------------------------------------------
  private onPointerUp(e: PointerEvent): void {
    if (!this.pointerDown) {
      return;
    }
    const moved = Math.hypot(e.clientX - this.pointerDown.x, e.clientY - this.pointerDown.y);
    this.pointerDown = undefined;
    if (moved > CLICK_DRAG_TOLERANCE_PX) {
      return; // an orbit drag, not a click
    }
    const hit = this.pick(e.clientX, e.clientY);
    if (hit) {
      this.select(hit);
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.pointerDown) {
      return; // ignore movement while orbiting
    }
    this.setHover(this.pick(e.clientX, e.clientY));
  }

  /** Resolve the camera under the cursor across all visible reconstructions. */
  private pick(clientX: number, clientY: number): CameraHit | null {
    const objects = this.deps
      .reconstructions()
      .filter((l) => l.object.visible && l.cameras.object.visible)
      .map((l) => l.cameras.object);
    if (objects.length === 0) {
      return null;
    }
    const rect = this.deps.dom.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.deps.camera);
    this.raycaster.params.Line.threshold = this.deps.frustumScale() * 0.2;

    for (const hit of this.raycaster.intersectObjects(objects, true)) {
      let obj: THREE.Object3D | null = hit.object;
      while (obj && obj.userData.cameraIndex === undefined) {
        obj = obj.parent;
      }
      if (obj && typeof obj.userData.cameraIndex === "number") {
        return { layerId: obj.userData.layerId as string, index: obj.userData.cameraIndex };
      }
    }
    return null;
  }

  private layer(id: string): ReconstructionLayer | undefined {
    return this.deps.reconstructions().find((l) => l.id === id);
  }

  // --- Hover / selection ----------------------------------------------------
  private setHover(hit: CameraHit | null): void {
    if (sameHit(hit, this.hovered)) {
      return;
    }
    if (this.hovered) {
      this.layer(this.hovered.layerId)?.cameras.setHover(-1);
    }
    if (hit) {
      this.layer(hit.layerId)?.cameras.setHover(hit.index);
    }
    this.hovered = hit ?? undefined;
    document.body.style.cursor = hit ? "pointer" : "default";
  }

  private select(hit: CameraHit): void {
    const layer = this.layer(hit.layerId);
    const cam = layer?.cameraView(hit.index);
    if (!layer || !cam) {
      return;
    }
    this.deselect();
    layer.cameras.select(hit.index);
    this.selected = hit;
    this.flyTo(cam);
    this.povActive = true;
    this.deps.onSelect(cam);
  }

  private deselect(): void {
    if (this.selected) {
      this.layer(this.selected.layerId)?.cameras.clearSelection();
      this.selected = undefined;
    }
    if (this.povActive) {
      this.deps.camera.fov = DEFAULT_FOV;
      this.deps.camera.up.set(0, 1, 0);
      this.deps.camera.updateProjectionMatrix();
      this.povActive = false;
    }
    this.deps.onSelect(null);
  }

  /** Position the viewer camera at a reconstruction camera, looking where it did. */
  private flyTo(cam: CameraView): void {
    const { camera, controls, root } = this.deps;
    root.updateMatrixWorld(true);
    const m = cam.worldFromCamera; // row-major, maps camera dir -> world (local)
    const center = new THREE.Vector3(
      cam.center[0],
      cam.center[1],
      cam.center[2]
    ).applyMatrix4(root.matrixWorld);
    // COLMAP camera looks down +z; image +y is down, so view-up is -y axis.
    const forward = new THREE.Vector3(m[2], m[5], m[8])
      .transformDirection(root.matrixWorld)
      .normalize();
    const up = new THREE.Vector3(-m[1], -m[4], -m[7])
      .transformDirection(root.matrixWorld)
      .normalize();
    const dist = this.deps.boundsDiagonal() * 0.15;

    camera.up.copy(up);
    camera.position.copy(center);
    controls.target.copy(center.clone().addScaledVector(forward, dist));
    if (cam.fy > 0) {
      const fovY = THREE.MathUtils.radToDeg(2 * Math.atan(cam.height / 2 / cam.fy));
      if (Number.isFinite(fovY) && fovY > 1 && fovY < 170) {
        camera.fov = fovY;
      }
    }
    camera.updateProjectionMatrix();
    controls.update();
  }
}

function sameHit(a: CameraHit | null, b: CameraHit | undefined): boolean {
  return a?.layerId === b?.layerId && a?.index === b?.index;
}
