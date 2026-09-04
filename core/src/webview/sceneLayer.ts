// The scene-source abstraction. A scene is a list of SceneLayers; each is either
// a COLMAP reconstruction (points + cameras + box) or an asset (a mesh, a bare
// point cloud, a 3DGS splat cloud, or 3D point tracks). The Viewer owns the list
// and treats every layer uniformly for
// visibility, bounds, and disposal.
import * as THREE from "three";
import type { ModelData, CameraView, Bounds } from "../shared/messages";
import { CameraLayer } from "./cameraLayer";
import type { SplatRenderMode } from "./splats";
import { DEFAULT_TRACK_SMOOTHING, DEFAULT_TRACK_LINE_WIDTH } from "./tracks";
import { ThumbnailLoader } from "./textures";
import {
  buildPoints,
  buildBox,
  computeLocalBounds,
  DEFAULT_POINT_SIZE,
  disposeObject,
} from "./builders";

/**
 * Scene-wide options for what an asset *draws* (as opposed to how it is lit, which
 * is the Shaded/Wireframe pair). Grouped so the layer interface doesn't grow a
 * method per control, mirroring `DisplayOptions` for reconstructions.
 */
export interface AssetOptions {
  /** How 3DGS clouds render: real splatting, solid ellipsoids, or bare centers. */
  splatMode: SplatRenderMode;
  /** Screen-pixel size of any bare point cloud an asset draws — a plain PLY cloud,
   *  or a 3DGS asset in "points" mode. The same slider as DisplayOptions.pointSize,
   *  which is the reconstruction side of it. */
  pointSize: number;
  /** Point-track trail length in time steps; Infinity draws the whole trajectory. */
  trackTrail: number;
  /** Point-track line opacity, 0..1. */
  trackOpacity: number;
  /** Fraction of point tracks drawn, 0..1 — a stable random subset. */
  trackDensity: number;
  /** Point-track trail thickness in screen pixels. */
  trackLineWidth: number;
  /** Gaussian smoothing of each trajectory along time, in steps; 0 = raw. */
  trackSmoothing: number;
}

/** Splats render 3DGS as it was trained to look; tracks start whole, opaque and
 *  undecimated, thick enough to read, and lightly smoothed along time. */
export const DEFAULT_ASSET_OPTIONS: AssetOptions = {
  splatMode: "splatting",
  pointSize: DEFAULT_POINT_SIZE,
  trackTrail: Number.POSITIVE_INFINITY,
  trackOpacity: 1,
  trackDensity: 1,
  trackLineWidth: DEFAULT_TRACK_LINE_WIDTH,
  trackSmoothing: DEFAULT_TRACK_SMOOTHING,
};

/** Scene-wide display options applied to every reconstruction layer. */
export interface DisplayOptions {
  points: boolean;
  frustums: boolean;
  images: boolean;
  box: boolean;
  pointSize: number;
  frustumScale: number;
  /** Frustum wireframe thickness, in screen pixels. */
  frustumLineWidth: number;
  /** Frustum wireframe base color, as 0xRRGGBB. */
  frustumColor: number;
}

/** One source of content in the scene. */
export interface SceneLayer {
  readonly id: string;
  readonly kind: "reconstruction" | "asset";
  /** Display name in the Scene list; editable via Viewer.renameItem. */
  label: string;
  /** Source location (e.g. asset file URI) for the Scene-list hover tooltip; undefined when unknown. */
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
  /** Light mesh materials (the global "Shaded" option); off = unlit albedo. No-op otherwise. */
  setShaded(on: boolean): void;
  /** Apply the scene-wide asset options (3DGS mode, the track options).
   *  Rebuilds only what actually changed; a no-op for reconstructions. */
  applyAssetOptions(opts: AssetOptions): void;
  /** Local-space bounds for fit-to-view, or undefined if not yet known. */
  bounds(): Bounds | undefined;
  dispose(): void;
}

/**
 * A layer that already holds every frame of a sequence and can redraw itself as any
 * of them. This is what lets a temporal item swap the data under ONE layer instead
 * of attaching a layer per frame — `AssetLayer` implements it for 3DGS sequences,
 * where a fresh mesh per frame would make Spark withhold the frame until a full
 * re-sort landed (see `swapSplatCloud`).
 */
export interface FrameSource extends SceneLayer {
  /** Frames held; 0 when this layer holds a lone asset. */
  readonly frameCount: number;
  /** Redraw as frame `index` of the sequence. */
  showFrame(index: number): void;
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
  // What the frustums currently on screen were built from, so a rebuild that would
  // change nothing can be skipped (NaN: nothing built yet).
  private builtScale = NaN;
  private builtImages = false;

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
    this.rebuildCameras(opts);
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

  // Reconstructions are points + lines: no meshes to wireframe or shade, and none
  // of the asset content options apply.
  setWireframe(): void {}
  setShaded(): void {}
  applyAssetOptions(): void {}

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
    this.cameras.setLineWidth(opts.frustumLineWidth);
    this.cameras.setColor(opts.frustumColor);
  }

  /**
   * Rebuild frustums (needed when frustum scale or the images toggle changes).
   * Skipped when neither did: a rebuild re-creates every frustum's geometry and
   * drops the textures loaded so far, so it must not happen for a call that would
   * produce the same thing — which is what lets the Viewer re-apply the whole scene
   * state to any layer, at any time, without thinking about cost.
   */
  rebuildCameras(opts: DisplayOptions): void {
    if (this.builtScale !== opts.frustumScale || this.builtImages !== opts.images) {
      this.builtScale = opts.frustumScale;
      this.builtImages = opts.images;
      this.cameras.build(this.data, opts.frustumScale, opts.images, opts.frustumLineWidth, opts.frustumColor);
    }
    this.cameras.setVisible(opts.frustums);
  }

  /** Caller must have updated world matrices; distances are measured through this
   *  layer's own matrix, so its placement in the scene counts. */
  refreshTextures(viewerPosition: THREE.Vector3): void {
    this.cameras.refreshTextures(viewerPosition, this.object.matrixWorld);
  }

  dispose(): void {
    disposeObject(this.points);
    disposeObject(this.box);
    this.cameras.clear();
    disposeObject(this.object);
  }
}
