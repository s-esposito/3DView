// The camera sub-layer of a reconstruction: one Three.js group per registered
// image, each with a frustum wireframe and (optionally) a textured image plane.
// Owns hover/selection highlighting and lazy texture loading. Picking is done by
// the Viewer across all layers; each group is stamped with its owning layer id.
import * as THREE from "three";
import type { ModelData } from "../shared/messages";
import { ThumbnailLoader } from "./textures";
import {
  frustumCorners,
  buildFrustumLines,
  buildImagePlane,
  disposeObject,
  FRUSTUM_COLOR,
} from "./builders";

const FRUSTUM_HOVER = 0x9ad1ff;
const FRUSTUM_SELECTED = 0xffcc00;
// Cap on how many image textures are resident at once (per reconstruction). Only
// the cameras nearest the current view are loaded; the rest stay bare frustums.
const MAX_RESIDENT_TEXTURES = 48;

/** Identifies a picked camera: which reconstruction layer and which camera. */
export interface CameraHit {
  layerId: string;
  index: number;
}

interface CameraRecord {
  index: number;
  group: THREE.Group;
  lineMaterial: THREE.LineBasicMaterial;
  planeMaterial?: THREE.MeshBasicMaterial;
  uri?: string;
  width: number;
  height: number;
  centerLocal: THREE.Vector3;
  requested: boolean;
  loaded: boolean;
}

export class CameraLayer {
  readonly object = new THREE.Group();
  private records = new Map<number, CameraRecord>();
  private hovered = -1;
  private selected = -1;
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly loader: ThumbnailLoader,
    private readonly layerId: string,
    // Notified when a texture is applied or evicted (async), so the Viewer can
    // redraw under on-demand rendering. No-op by default.
    private readonly onTextureChange: () => void = () => {}
  ) {}

  /** (Re)build all per-camera objects for a model at the given frustum scale. */
  build(data: ModelData, scale: number, showImages: boolean): void {
    this.clear();
    data.cameras.forEach((cam, index) => {
      if (!cam.fx || !cam.fy) {
        return; // no usable intrinsics
      }
      const corners = frustumCorners(cam, scale);
      const group = new THREE.Group();
      const lines = buildFrustumLines(cam.center, corners, FRUSTUM_COLOR);
      group.add(lines);

      let planeMaterial: THREE.MeshBasicMaterial | undefined;
      if (showImages && cam.imageUri) {
        const plane = buildImagePlane(corners);
        planeMaterial = plane.material as THREE.MeshBasicMaterial;
        group.add(plane);
      }

      group.userData.cameraIndex = index;
      group.userData.layerId = this.layerId;
      this.object.add(group);
      this.records.set(index, {
        index,
        group,
        lineMaterial: lines.material as THREE.LineBasicMaterial,
        planeMaterial,
        uri: cam.imageUri,
        width: cam.width,
        height: cam.height,
        centerLocal: new THREE.Vector3(...cam.center),
        requested: false,
        loaded: false,
      });
    });
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  /**
   * Load textures for the cameras nearest the viewer (up to the resident cap)
   * and free those that have fallen outside it. Cheap to call on every view
   * change.
   */
  refreshTextures(viewerPosition: THREE.Vector3, rootMatrixWorld: THREE.Matrix4): void {
    const textured = [...this.records.values()].filter((r) => r.planeMaterial && r.uri);
    if (textured.length === 0) {
      return;
    }
    const ranked = textured
      .map((r) => {
        this.tmp.copy(r.centerLocal).applyMatrix4(rootMatrixWorld);
        return { record: r, dist: this.tmp.distanceTo(viewerPosition) };
      })
      .sort((a, b) => a.dist - b.dist);

    const keep = new Set<CameraRecord>();
    for (let i = 0; i < Math.min(MAX_RESIDENT_TEXTURES, ranked.length); i++) {
      const r = ranked[i].record;
      keep.add(r);
      if (!r.requested) {
        this.requestTexture(r);
      }
    }
    for (const r of textured) {
      if (!keep.has(r) && (r.loaded || r.requested)) {
        this.releaseTexture(r);
      }
    }
  }

  private requestTexture(r: CameraRecord): void {
    r.requested = true;
    const uri = r.uri!;
    this.loader.load(uri, { width: r.width, height: r.height }, (texture) => {
      // The record may have been evicted or rebuilt before the load finished.
      if (!r.planeMaterial || !r.requested) {
        texture.dispose();
        return;
      }
      r.planeMaterial.map?.dispose();
      r.planeMaterial.map = texture;
      r.planeMaterial.opacity = 1;
      r.planeMaterial.needsUpdate = true;
      r.loaded = true;
      this.onTextureChange();
    });
  }

  private releaseTexture(r: CameraRecord): void {
    if (r.planeMaterial) {
      r.planeMaterial.map?.dispose();
      r.planeMaterial.map = null;
      r.planeMaterial.opacity = 0;
      r.planeMaterial.needsUpdate = true;
    }
    r.requested = false;
    r.loaded = false;
    this.onTextureChange();
  }

  // --- Hover / selection ----------------------------------------------------
  setHover(index: number): void {
    if (index === this.hovered) {
      return;
    }
    const prev = this.hovered;
    this.hovered = index;
    this.applyColor(prev);
    this.applyColor(index);
  }

  /** Select a camera: highlight it and hide its own frustum (for POV). */
  select(index: number): void {
    this.clearSelection();
    this.selected = index;
    const group = this.records.get(index)?.group;
    if (group) {
      group.visible = false;
    }
  }

  clearSelection(): void {
    const prev = this.selected;
    this.selected = -1;
    if (prev >= 0) {
      const group = this.records.get(prev)?.group;
      if (group) {
        group.visible = true;
      }
      this.applyColor(prev);
    }
  }

  clear(): void {
    this.loader.clear();
    for (const child of [...this.object.children]) {
      disposeObject(child); // detaches from `object` and frees GPU resources
    }
    this.records.clear();
    this.hovered = -1;
    this.selected = -1;
  }

  private colorFor(index: number): number {
    if (index === this.selected) {
      return FRUSTUM_SELECTED;
    }
    if (index === this.hovered) {
      return FRUSTUM_HOVER;
    }
    return FRUSTUM_COLOR;
  }

  private applyColor(index: number): void {
    if (index < 0) {
      return;
    }
    this.records.get(index)?.lineMaterial.color.setHex(this.colorFor(index));
  }
}
