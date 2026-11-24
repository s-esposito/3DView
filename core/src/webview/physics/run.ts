// One chunked object's physics in the viewer: the Sim behind its chunk SplatObjects, created and
// calibrated on first use, stepped on a fixed clock by the viewer's animation loop, its bodies'
// transforms copied onto the chunks (which live in the physics frame, under the chunked object's
// turn into the scene's data frame — chunkedObject.ts).
import type { ChunkedObject } from "./chunkedObject";
import type { SplatObject } from "../splats";
import { loadBox3d } from "./box3d";
import { Sim } from "./sim";

export type PhysicsState = "rest" | "calibrating" | "running" | "paused";

/** Most steps one frame catches up: past that the simulation slows down rather than the page. */
const MAX_STEPS_PER_FRAME = 3;
/** Calibration runs in slices of this many ms, so the page keeps drawing and shows progress. */
const SLICE_MS = 30;
/** The tilt a drop starts with (rad about z), so the object lands on an edge, not flat. */
const DROP_TILT = 0.3;

export class PhysicsRun {
  state: PhysicsState = "rest";
  /** Calibration progress, 0..1. */
  progress = 0;
  private sim?: Sim;
  private preparing?: Promise<Sim>;
  private carry = 0;
  private lastTick = 0;
  private readonly xf: Float32Array;

  /** Called when the state or the calibration progress moves (the viewer sets it). */
  onChange: () => void = () => {};

  constructor(private readonly chunked: ChunkedObject, private readonly chunks: SplatObject[]) {
    this.xf = new Float32Array(7 * chunks.length);
  }

  /** Simulate from the rest pose (an object may first settle, or tip onto its stable side). */
  async play(): Promise<void> {
    await this.prepared();
    this.setState("running");
  }

  pause(): void {
    if (this.state === "running") this.setState("paused");
  }

  /** Lift the object ``height`` metres, tilted, and let it fall. */
  async drop(height: number): Promise<void> {
    const sim = await this.prepared();
    sim.reset({ lift: height, tilt: DROP_TILT });
    this.place(sim);
    this.setState("running");
  }

  /** Back to rest, whole; nothing moves until played again. */
  reset(): void {
    if (this.sim) {
      this.sim.reset();
      this.place(this.sim);
    }
    this.setState(this.sim ? "paused" : "rest");
  }

  /**
   * Advance by the time since the last tick in fixed steps (the viewer calls this every frame).
   * Returns whether it is still moving (running, a body awake): the frame needs drawing, and a
   * frame too short for a step does not mean it came to rest.
   */
  tick(now: number): boolean {
    const sim = this.sim;
    if (!sim || this.state !== "running") {
      this.lastTick = 0;
      return false;
    }
    const elapsed = this.lastTick ? (now - this.lastTick) / 1000 : sim.o.dt;
    this.lastTick = now;
    this.carry = Math.min(this.carry + elapsed, MAX_STEPS_PER_FRAME * sim.o.dt);
    let stepped = false;
    while (this.carry >= sim.o.dt) {
      sim.step();
      this.carry -= sim.o.dt;
      stepped = true;
    }
    if (stepped) this.place(sim);
    return sim.awake > 0;
  }

  /** What the panel shows: the pieces once anything broke, and whether it still moves. */
  get status(): string {
    if (this.state === "calibrating") return `calibrating ${Math.round(100 * this.progress)}%`;
    if (!this.sim || this.state === "rest") return "whole, at rest";
    const sizes = this.sim.pieceSizes();
    const pieces = sizes.length === 1
      ? "whole"
      : `${sizes.length} pieces, largest ${Math.round((100 * sizes[0]) / this.chunks.length)}%`;
    const motion = this.state === "paused" ? "paused" : this.sim.awake > 0 ? "moving" : "at rest";
    return `${pieces}, ${motion}`;
  }

  dispose(): void {
    this.sim?.dispose();
    this.sim = undefined;
  }

  /** The Sim, created and calibrated on first call, in slices with progress. */
  private prepared(): Promise<Sim> {
    this.preparing ??= (async () => {
      this.setState("calibrating");
      const sim = new Sim(await loadBox3d(), this.chunked.scene);
      const run = sim.calibrating();
      for (let done = false; !done;) {
        const until = performance.now() + SLICE_MS;
        while (performance.now() < until) {
          const r = run.next();
          if (r.done) { done = true; break; }
          this.progress = r.value;
        }
        this.onChange();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      this.sim = sim;
      this.place(sim);
      return sim;
    })();
    return this.preparing;
  }

  /** Copy the bodies' transforms onto the chunks. */
  private place(sim: Sim): void {
    sim.transforms(this.xf);
    this.chunks.forEach((chunk, i) => {
      const x = this.xf, k = 7 * i;
      chunk.position.set(x[k], x[k + 1], x[k + 2]);
      chunk.quaternion.set(x[k + 3], x[k + 4], x[k + 5], x[k + 6]);
    });
  }

  private setState(state: PhysicsState): void {
    this.state = state;
    this.lastTick = 0;
    this.carry = 0;
    this.onChange();
  }
}
