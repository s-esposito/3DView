// The scene-source abstraction. A scene is a list of SceneLayers; each is either
// a COLMAP reconstruction (points + cameras + box) or a mesh. The Viewer owns
// the list and treats every layer uniformly for visibility, bounds, and disposal.
import * as THREE from "three";
import type { ModelData, CameraView, Bounds } from "../shared/messages";
import { CameraLayer } from "./cameraLayer";
import { ThumbnailLoader } from "./textures";
import { buildPoints, buildBox, computeLocalBounds, disposeObject } from "./builders";

/** Scene-wide display options applied to every reconstruction layer. */
export interface DisplayOptions {
  points: boolean;
  frustums: boolean;
  images: boolean;
  box: boolean;
  pointSize: number;
  frustumScale: number;
}

/** One source of content in the scene. */
export interface SceneLayer {
  readonly id: string;
  readonly kind: "reconstruction" | "mesh";
  /** Display name in the Scene list; editable via Viewer.renameItem. */
  label: string;
  /** Source location (e.g. mesh file URI) for the Scene-list hover tooltip; undefined when unknown. */
  readonly source?: string;
  /** Root object added under the Viewer's `root` group. */
  readonly object: THREE.Object3D;
  /** Per-item visibility (the Scene list show/hide). */
  visible: boolean;
  setVisible(visible: boolean): void;
  /** Toggle this layer's bounding box (the global "Box" display option). */
  setBoxVisible(visible: boolean): void;
  /** Render meshes as wireframe (the global "Wireframe" option); no-op otherwise. */
  setWireframe(on: boolean): void;
  /** Local-space bounds for fit-to-view, or undefined if not yet known. */
  bounds(): Bounds | undefined;
  dispose(): void;
}

/** A COLMAP reconstruction: colored points, camera frustums, and a bounding box. */
export class ReconstructionLayer implements SceneLayer {
  readonly kind = "reconstruction" as const;
  readonly object = new THREE.Group();
  readonly cameras: CameraLayer;
  visible = true;

  private points?: THREE.Points;
  private box?: THREE.Box3Helper;
  private readonly localBounds: Bounds;

  constructor(
    readonly id: string,
    public label: string,
    readonly data: ModelData,
    opts: DisplayOptions,
    onTextureChange: () => void = () => {},
    readonly source?: string
  ) {
    this.localBounds = computeLocalBounds(data);
    this.cameras = new CameraLayer(new ThumbnailLoader(), id, onTextureChange);
    this.object.add(this.cameras.object);

    if (data.count > 0) {
      this.points = buildPoints(data, opts.pointSize);
      this.object.add(this.points);
      this.box = buildBox(data.bounds);
      this.object.add(this.box);
    }
    this.cameras.build(data, opts.frustumScale, opts.images);
    this.applyOptions(opts);
  }

  get pointCount(): number {
    return this.data.count;
  }
  get cameraCount(): number {
    return this.data.cameras.length;
  }
  cameraView(index: number): CameraView | undefined {
    return this.data.cameras[index];
  }

  bounds(): Bounds {
    return this.localBounds;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.object.visible = visible;
  }

  setBoxVisible(visible: boolean): void {
    if (this.box) {
      this.box.visible = visible;
    }
  }

  // Reconstructions are points + lines — no meaningful wireframe.
  setWireframe(): void {}

  /** Apply scene-wide options that don't require rebuilding geometry. */
  applyOptions(opts: DisplayOptions): void {
    if (this.points) {
      this.points.visible = opts.points;
      (this.points.material as THREE.PointsMaterial).size = opts.pointSize;
    }
    if (this.box) {
      this.box.visible = opts.box;
    }
    this.cameras.setVisible(opts.frustums);
  }

  /** Rebuild frustums (needed when frustum scale or the images toggle changes). */
  rebuildCameras(opts: DisplayOptions): void {
    this.cameras.build(this.data, opts.frustumScale, opts.images);
    this.cameras.setVisible(opts.frustums);
  }

  refreshTextures(viewerPosition: THREE.Vector3, rootMatrixWorld: THREE.Matrix4): void {
    this.cameras.refreshTextures(viewerPosition, rootMatrixWorld);
  }

  dispose(): void {
    disposeObject(this.points);
    disposeObject(this.box);
    this.cameras.clear();
    disposeObject(this.object);
  }
}
