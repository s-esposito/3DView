// A scene item whose content is a sequence: several frames — timesteps of one
// capture — drawn one at a time, so the Scene list holds ONE row with a timeline
// instead of N rows piled on top of each other.
//
// The frames are ordinary ReconstructionLayer / AssetLayer instances, unchanged;
// this class only owns their order and which one is on screen. Everything a frame
// needs to know about the scene's state is re-applied to it by the Viewer when it
// becomes the drawn frame (Viewer.syncLayerState), so nothing is mirrored here.
//
// Imports are type-only where the module they come from touches the DOM
// (sceneLayer pulls in CameraLayer/ThumbnailLoader), which is what keeps this
// module loadable in the Node test bundle. Don't "fix" them into value imports.
import * as THREE from "three";

import type { Bounds } from "../shared/messages";
import { compareNatural } from "../shared/naming";
import { unionBounds, disposeObject } from "./builders";
import type { AssetOptions, FrameSource, SceneLayer } from "./sceneLayer";

export class TemporalLayer implements SceneLayer {
  readonly object = new THREE.Group();
  /** Every frame, in the order the timeline scrubs through them. */
  readonly frames: SceneLayer[] = [];
  visible = true;
  private index = 0;
  private cachedBounds?: Bounds;

  constructor(
    readonly id: string,
    public label: string,
    /** Mirrors the frames' own kind, so the global Show toggles gate this item
     *  exactly as they would the frames loaded separately. Frames are homogeneous
     *  by construction — no intake path mixes reconstructions and assets. */
    readonly kind: "reconstruction" | "asset",
    readonly source?: string,
    /**
     * One layer that already holds every frame, instead of a layer per frame. Used
     * for a 3DGS sequence whose frames share a packed layout: swapping the data
     * under one mesh keeps the splat renderer's mapping intact, and only then does
     * it show a new frame without waiting for a re-sort (see `swapSplatCloud`).
     * Everything else here — bounds, state fan-out, disposal — treats it as the
     * sequence's single frame, so both shapes share one timeline.
     */
    private readonly sequence?: FrameSource
  ) {
    if (sequence) {
      this.frames.push(sequence);
      this.object.add(sequence.object);
    }
  }

  get frameCount(): number {
    return this.sequence ? this.sequence.frameCount : this.frames.length;
  }

  get frame(): number {
    return this.index;
  }

  /** The one frame the scene draws through this layer; undefined until the first
   *  one lands. This — not `frames` — is what the Viewer's layer flatten exposes,
   *  so picking, the texture budget and the derived state flags see only what is
   *  actually on screen. */
  get drawnFrame(): SceneLayer | undefined {
    return this.sequence ?? this.frames[this.index];
  }

  /** Add a loaded frame, keeping the sequence in natural label order (frames finish
   *  loading in whatever order their bytes arrive). Only the drawn frame is shown.
   *  For the layer-per-frame shape only — a sequence layer arrives whole. */
  addFrame(layer: SceneLayer): void {
    const before = this.frames.findIndex((f) => compareNatural(layer.label, f.label) < 0);
    this.frames.splice(before === -1 ? this.frames.length : before, 0, layer);
    this.cachedBounds = undefined;
    this.setFrame(this.index); // clamp, and attach the newcomer if it is the drawn one
  }

  /** Draw frame `i`, clamped to the sequence. The Viewer re-syncs the newcomer to
   *  the scene's state afterwards (it may have changed while the frame was hidden). */
  setFrame(i: number): void {
    this.index = Math.min(Math.max(Math.round(i), 0), Math.max(this.frameCount - 1, 0));
    if (this.sequence) {
      this.sequence.showFrame(this.index);
      return;
    }
    this.drawOnlyCurrent();
  }

  /**
   * Leave exactly one frame in the scene graph: the drawn one. Clearing `.visible`
   * would be enough for three.js, but not for the splat renderer — Spark rebuilds
   * its splat collection by walking the WHOLE scene each update, visible or not, and
   * runs per-mesh bookkeeping on every SplatMesh it finds. A fifty-frame sequence
   * would pay that fifty times per rendered frame, for forty-nine frames nobody can
   * see. A frame that isn't drawn isn't in the scene.
   *
   * Detaching costs Spark nothing extra: it discovers meshes by traversal alone (no
   * add/remove hooks), and an off-screen frame was already absent from the visible
   * set that decides whether a re-sort is needed.
   */
  private drawOnlyCurrent(): void {
    this.frames.forEach((frame, at) => {
      const drawn = at === this.index;
      frame.setVisible(drawn);
      if (drawn) {
        this.object.add(frame.object);
      } else {
        frame.object.removeFromParent();
      }
    });
  }

  /** The union across EVERY frame, not just the drawn one, so fit-to-view, the grid
   *  and the nudge step stay put while scrubbing. Frames sit at identity inside this
   *  container, so their local bounds compose directly. */
  bounds(): Bounds | undefined {
    if (this.cachedBounds) {
      return this.cachedBounds;
    }
    const parts = this.frames.map((f) => f.bounds()).filter((b): b is Bounds => b != null);
    this.cachedBounds = parts.length > 0 ? unionBounds(parts) : undefined;
    return this.cachedBounds;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.object.visible = visible; // gates the whole sequence; frame visibility is separate
  }

  // Cheap flag setters reach every frame, so a frame comes up already in the
  // scene's state the moment it is shown.
  setBoxVisible(visible: boolean): void {
    this.frames.forEach((f) => f.setBoxVisible(visible));
  }

  setWireframe(on: boolean): void {
    this.frames.forEach((f) => f.setWireframe(on));
  }

  setShaded(on: boolean): void {
    this.frames.forEach((f) => f.setShaded(on));
  }

  /** Unlike the setters above, this one reaches only the drawn frame: it can rebuild
   *  geometry (the 3DGS render mode, track density), and doing that for fifty hidden
   *  frames would stall the UI on a single click. Hidden frames catch up when they
   *  are shown — see Viewer.setItemFrame. */
  applyAssetOptions(opts: AssetOptions): void {
    this.drawnFrame?.applyAssetOptions(opts);
  }

  dispose(): void {
    this.frames.forEach((f) => f.dispose());
    this.frames.length = 0;
    this.cachedBounds = undefined;
    disposeObject(this.object);
  }
}
