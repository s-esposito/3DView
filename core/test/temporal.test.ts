// TemporalLayer: which frame is drawn, and what reaches the others. Frames are
// fakes — the real ones need a GPU or a file — so this stays a pure unit test.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { TemporalLayer } from "../src/webview/temporalLayer";
import type { AssetOptions, SceneLayer } from "../src/webview/sceneLayer";
import type { Bounds } from "../src/shared/messages";

class FakeFrame implements SceneLayer {
  readonly kind = "asset" as const;
  readonly object = new THREE.Group();
  visible = true;
  boxes = 0;
  wireframes = 0;
  shades = 0;
  assetOptionCalls = 0;
  disposed = 0;

  constructor(
    readonly id: string,
    public label: string,
    private readonly extent: Bounds = { min: [-1, -1, -1], max: [1, 1, 1] }
  ) {}

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.object.visible = visible;
  }
  setBoxVisible(): void {
    this.boxes++;
  }
  setWireframe(): void {
    this.wireframes++;
  }
  setShaded(): void {
    this.shades++;
  }
  applyAssetOptions(_opts: AssetOptions): void {
    this.assetOptionCalls++;
  }
  bounds(): Bounds {
    return this.extent;
  }
  dispose(): void {
    this.disposed++;
  }
}

/** A sequence of `labels`, added in the order given. */
function sequence(labels: string[], extents: Bounds[] = []): [TemporalLayer, FakeFrame[]] {
  const layer = new TemporalLayer("seq-1", "capture", "asset");
  const frames = labels.map((l, i) => new FakeFrame(`f-${i}`, l, extents[i]));
  frames.forEach((f) => layer.addFrame(f));
  return [layer, frames];
}

/** The labels of the frames, in the order the timeline scrubs through them. */
const order = (layer: TemporalLayer) => layer.frames.map((f) => f.label);
const shown = (frames: FakeFrame[]) => frames.filter((f) => f.visible).map((f) => f.label);
/** The labels of the frames actually in the scene graph under the container. */
const inScene = (layer: TemporalLayer, frames: FakeFrame[]) =>
  frames.filter((f) => layer.object.children.includes(f.object)).map((f) => f.label);

test("frames are kept in natural order however they arrive", () => {
  // Loads finish in whatever order their bytes do — frame 10 before frame 2.
  const [layer] = sequence(["cap_10.ply", "cap_2.ply", "cap_1.ply"]);
  assert.deepEqual(order(layer), ["cap_1.ply", "cap_2.ply", "cap_10.ply"]);
  assert.equal(layer.frameCount, 3);
});

test("exactly one frame is drawn, and it is the first by default", () => {
  const [layer, frames] = sequence(["a", "b", "c"]);
  assert.deepEqual(shown(frames), ["a"]);
  assert.equal(layer.frame, 0);
  assert.equal(layer.drawnFrame?.label, "a");
});

test("only the drawn frame is in the scene graph at all", () => {
  // Not merely `.visible = false`: the splat renderer rebuilds its collection by
  // walking the whole scene, hidden meshes included, so an undrawn frame it can
  // still find costs per-mesh work every rendered frame.
  const [layer, frames] = sequence(["a", "b", "c"]);
  assert.deepEqual(inScene(layer, frames), ["a"]);
  layer.setFrame(2);
  assert.deepEqual(inScene(layer, frames), ["c"]);
  assert.equal(layer.object.children.length, 1, "the outgoing frame was detached");
});

test("setFrame draws one frame and clamps to the sequence", () => {
  const [layer, frames] = sequence(["a", "b", "c"]);
  layer.setFrame(2);
  assert.deepEqual(shown(frames), ["c"]);
  layer.setFrame(99);
  assert.deepEqual(shown(frames), ["c"], "clamped to the last frame");
  layer.setFrame(-5);
  assert.deepEqual(shown(frames), ["a"], "clamped to the first frame");
  assert.equal(layer.frame, 0);
});

test("bounds union every frame, so the view doesn't jitter while scrubbing", () => {
  const [layer] = sequence(
    ["a", "b"],
    [
      { min: [-1, -1, -1], max: [1, 1, 1] },
      { min: [0, 0, 0], max: [5, 2, 2] },
    ]
  );
  assert.deepEqual(layer.bounds(), { min: [-1, -1, -1], max: [5, 2, 2] });
  // Undefined (not a unit box) when there is nothing to measure: the Viewer skips
  // a layer with no bounds rather than pulling the scene towards the origin.
  assert.equal(new TemporalLayer("empty", "empty", "asset").bounds(), undefined);
});

test("cheap state reaches every frame; a rebuild-capable one reaches only the drawn frame", () => {
  const [layer, frames] = sequence(["a", "b", "c"]);
  layer.setBoxVisible(true);
  layer.setWireframe(true);
  layer.setShaded(false);
  assert.deepEqual(
    frames.map((f) => [f.boxes, f.wireframes, f.shades]),
    [
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]
  );
  // Asset options can rebuild geometry, so hidden frames are left alone — they are
  // re-synced when shown (Viewer.setItemFrame).
  layer.applyAssetOptions({
    splatMode: "points",
    trackFrames: 1,
    trackOpacity: 1,
    trackDensity: 1,
  });
  assert.deepEqual(
    frames.map((f) => f.assetOptionCalls),
    [1, 0, 0]
  );
});

test("hiding the item hides the sequence without changing which frame is drawn", () => {
  const [layer, frames] = sequence(["a", "b"]);
  layer.setVisible(false);
  assert.equal(layer.object.visible, false);
  assert.deepEqual(shown(frames), ["a"], "frame visibility is a separate axis");
});

// --- the sequence shape: ONE layer holding every frame ----------------------
// What a 3DGS sequence with a stable layout uses, so the splat renderer's mapping
// never changes and a frame can be shown before it has been re-sorted.
class FakeSequence extends FakeFrame {
  shown: number[] = [];
  constructor(readonly frameCount: number) {
    super("seq", "capture");
  }
  showFrame(index: number): void {
    this.shown.push(index);
  }
}

test("a sequence layer is the item's only frame, however many it holds", () => {
  const held = new FakeSequence(40);
  const layer = new TemporalLayer("seq-1", "capture", "asset", undefined, held);
  assert.equal(layer.frameCount, 40, "the count comes from the sequence, not the child list");
  assert.equal(layer.drawnFrame, held);
  assert.equal(layer.object.children.length, 1, "attached once, and stays attached");
});

test("scrubbing a sequence swaps its data instead of swapping layers", () => {
  const held = new FakeSequence(40);
  const layer = new TemporalLayer("seq-1", "capture", "asset", undefined, held);
  layer.setFrame(7);
  layer.setFrame(39);
  layer.setFrame(120); // clamped
  assert.deepEqual(held.shown, [7, 39, 39]);
  assert.equal(layer.frame, 39);
  assert.equal(layer.object.children.length, 1, "no attach/detach churn while playing");
  assert.equal(held.visible, true, "the one layer is never hidden");
});

test("dispose frees every frame, not just the drawn one", () => {
  const [layer, frames] = sequence(["a", "b", "c"]);
  layer.dispose();
  assert.deepEqual(
    frames.map((f) => f.disposed),
    [1, 1, 1]
  );
  assert.equal(layer.frameCount, 0);
});
