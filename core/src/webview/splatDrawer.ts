// Gaussian splatting, drawn by Radix (https://sparkjs.dev/radix/). One Radix
// SplatRenderer per viewer projects and sorts every splat object together and draws
// them in a single call; this feeds it from the scene. Just before each frame the
// visible SplatObjects are gathered and handed over as a collection, each drawn
// through its own matrixWorld, so show/hide, per-item transforms and the upright flip
// apply with nothing to keep in sync.
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { GpuArrays, SplatCollection, SplatRenderer } from "@sparkjsdev/radix";
import type { AnySplatObject } from "@sparkjsdev/radix";
import { SplatObject } from "./splats";

/** A splat object as Radix holds it: uploaded once, re-uploaded when it changes. */
interface Uploaded {
  record: AnySplatObject;
  arrays: GpuArrays;
  version: number;
}

export class SplatDrawer {
  /** Goes in the scene (not `root`): it draws every object through that object's own
   *  matrixWorld, so its own placement must stay the identity. */
  readonly mesh: SplatRenderer;
  private readonly uploaded = new Map<SplatObject, Uploaded>();
  private drawn: SplatObject[] = [];
  private sortLanded?: () => void;

  /** `onDirty` fires when a sort lands after the frame it was for (the WebGL2
   *  backend sorts on a worker) — exactly when the last frame went stale. */
  constructor(
    private readonly renderer: WebGPURenderer,
    onDirty: () => void
  ) {
    this.mesh = new SplatRenderer({
      renderer,
      onInvalidate: () => {
        onDirty();
        this.sortLanded?.();
      },
    });
  }

  /** Whether sorts land after the frame that asked (WebGL2's worker sort) rather
   *  than within it (WebGPU sorts on the GPU, in the same frame). */
  get sortsLater(): boolean {
    return this.mesh.sortMode === "cpu";
  }

  /** Resolves when the next sort lands, or after `ms` if none does. */
  nextSort(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sortLanded = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.sortLanded = done;
    });
  }

  /**
   * Hand Radix what `scene` shows now. Call before every render. An object seen for
   * the first time is uploaded; one rewritten in place (a sequence frame) is
   * re-uploaded into the same GPU arrays and re-sorted, without changing the set.
   * An object that drops out (hidden, removed, an undrawn frame) is forgotten here;
   * Radix releases it — and its GPU arrays with it — once no pending sort needs it.
   */
  gather(scene: THREE.Object3D): void {
    const visible: SplatObject[] = [];
    scene.traverseVisible((object) => {
      if (object instanceof SplatObject) {
        visible.push(object);
      }
    });
    for (const object of visible) {
      const known = this.uploaded.get(object);
      if (!known) {
        this.uploaded.set(object, this.upload(object));
      } else if (known.version !== object.version) {
        known.arrays.upload(object.data);
        known.version = object.version;
        this.mesh.requestSort();
      }
    }
    if (visible.length !== this.drawn.length || visible.some((o, i) => o !== this.drawn[i])) {
      for (const object of this.uploaded.keys()) {
        if (!visible.includes(object)) {
          this.uploaded.delete(object);
        }
      }
      this.drawn = visible;
      this.mesh.collection = new SplatCollection(visible.map((o) => this.uploaded.get(o)!.record));
    }
  }

  private upload(object: SplatObject): Uploaded {
    const arrays = GpuArrays.fromData(this.renderer, object.data);
    const record = SplatCollection.arrays(arrays, {
      matrixWorld: () => object.matrixWorld,
      release: () => arrays.dispose(),
    });
    return { record, arrays, version: object.version };
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.uploaded.clear();
    this.drawn = [];
  }
}
