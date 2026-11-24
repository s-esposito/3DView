// One chunked object's physics in the viewer: the Sim behind its chunk SplatObjects, created and
// calibrated on first use, stepped on a fixed clock by the viewer's animation loop, its bodies'
// transforms copied onto the chunks (which live in the physics frame, under the chunked object's
// turn into the scene's data frame — chunkedObject.ts). Rays and points from the viewer arrive in
// world space and are taken into the physics frame here.
import * as THREE from "three";
import type { Bounds } from "../../shared/messages";
import type { ChunkedObject } from "./chunkedObject";
import type { SplatObject } from "../splats";
import { loadBox3d } from "./box3d";
import { DEFAULTS, Sim, type V3 } from "./sim";

export type PhysicsState = "rest" | "calibrating" | "running" | "paused";
export type PhysicsPreset = "shatter" | "explode" | "volley" | "crumble";

/** Most steps one frame catches up: past that the simulation slows down rather than the page. */
const MAX_STEPS_PER_FRAME = 3;
/** Calibration runs in slices of this many ms, so the page keeps drawing and shows progress. */
const SLICE_MS = 30;
/** The tilt a drop starts with (rad about z), so the object lands on an edge, not flat. */
const DROP_TILT = 0.3;
/** Shatter on impact (m/s): the shatter preset's, and the volley's — above a knocked-out chunk's
 *  slower kick-offs, so its shots punch through without a chain reaction (the prototype's tuning). */
const SHATTER_SPEED = 3;
const VOLLEY_SHATTER_SPEED = 6;
/** Box3D can keep a welded piece creeping for ever (mm/s, measured after the sloth's blast), so a
 *  second of sim time in which no chunk moved this far or turned this much puts it all to sleep. */
const CREEP_WINDOW = 1;
const CREEP_DISTANCE = 0.01;
const CREEP_ANGLE = (2 * Math.PI) / 180;

export class PhysicsRun {
  state: PhysicsState = "rest";
  /** Calibration progress, 0..1. */
  progress = 0;
  /** Glue: each weld breaks at this x the load it carries at rest (Sim.setStrength). */
  strength = DEFAULTS.strength;
  /** Shatter on impact: a chunk hit faster than this (m/s) comes loose; Infinity = off. */
  shatterSpeed = Number.POSITIVE_INFINITY;
  /** Called when the state, the settings or the calibration progress move (the viewer sets it). */
  onChange: () => void = () => {};

  private sim?: Sim;
  private preparing?: Promise<Sim>;
  private carry = 0;
  private lastTick = 0;
  /** Sim time since running, and the transforms and time of the last creep check. */
  private simTime = 0;
  private markTime = 0;
  private readonly mark: Float32Array;
  private readonly xf: Float32Array;
  /** Each chunk's reach from its body's origin (its farthest box corner), for the extent. */
  private readonly reach: number[];
  /** The median chunk at rest (physics frame). */
  private readonly restMiddle: V3;

  constructor(private readonly chunked: ChunkedObject, private readonly chunks: SplatObject[]) {
    this.xf = new Float32Array(7 * chunks.length);
    this.mark = new Float32Array(7 * chunks.length);
    this.reach = chunked.scene.chunks.map((c) => Math.max(...c.boxes.map(([x, y, z, hx, hy, hz]) =>
      Math.hypot(Math.abs(x) + hx, Math.abs(y) + hy, Math.abs(z) + hz))));
    this.restMiddle = this.median(); // the chunks are built at rest
  }

  /** Simulate from where it is (at first, the rest pose: it may settle or tip onto its side). */
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
    this.start(sim);
  }

  /** Back to rest, whole; nothing moves until played again. */
  reset(): void {
    if (this.sim) {
      this.sim.reset();
      this.place(this.sim);
    }
    this.setState(this.sim ? "paused" : "rest");
  }

  setStrength(k: number): void {
    this.strength = k;
    this.sim?.setStrength(k);
    this.onChange();
  }

  setShatterSpeed(speed: number): void {
    this.shatterSpeed = speed;
    if (this.sim) this.sim.o.shatterSpeed = speed;
    this.onChange();
  }

  /** A shot along a world-space ray: knocks out the first chunk it hits. Whether it hit. */
  async shoot(ray: THREE.Ray): Promise<boolean> {
    const sim = await this.prepared();
    const hit = sim.shoot(...this.toLocal(ray)) >= 0;
    if (hit) this.start(sim);
    return hit;
  }

  /** A blast where a world-space ray first meets the object. Whether it hit. */
  async blast(ray: THREE.Ray): Promise<boolean> {
    const sim = await this.prepared();
    const [origin, dir] = this.toLocal(ray);
    const hit = sim.world.castRayClosest(
      { x: origin[0], y: origin[1], z: origin[2] },
      { x: 100 * dir[0], y: 100 * dir[1], z: 100 * dir[2] });
    if (!hit.hit) return false;
    sim.explode([hit.point.x, hit.point.y, hit.point.z], { radius: 0.3 });
    this.start(sim);
    return true;
  }

  /**
   * A preset, from the default glue and a reset, so it repeats: shatter = a brittle 3 m drop;
   * explode = a blast at the middle (the welds near it break, the chunks around fly out); volley
   * = a row of brittle shots (``aim`` gives their world-space rays at the object's middle — the
   * viewer aims from its camera); crumble = the glue vanishes (Sim.unglue: a hollow object
   * collapses, a solid one stands).
   */
  async preset(name: PhysicsPreset, aim: (middle: THREE.Vector3) => THREE.Ray[] = () => []): Promise<void> {
    this.setStrength(DEFAULTS.strength); // before the first await: the panel shows them at once
    this.setShatterSpeed(name === "shatter" ? SHATTER_SPEED
      : name === "volley" ? VOLLEY_SHATTER_SPEED : Number.POSITIVE_INFINITY);
    if (name === "shatter") return this.drop(3);
    const sim = await this.prepared();
    sim.reset();
    this.place(sim); // the blast's middle and the volley's aim are the rest pose's
    if (name === "explode") sim.explode(this.middle(), { radius: 0.5 });
    else if (name === "crumble") sim.unglue();
    else for (const ray of aim(this.middleWorld())) sim.shoot(...this.toLocal(ray), { speed: 10 });
    this.start(sim);
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
      this.simTime += sim.o.dt;
      stepped = true;
    }
    if (stepped) {
      this.place(sim);
      if (this.simTime - this.markTime >= CREEP_WINDOW) this.checkCreep(sim);
    }
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

  /** Where the chunks are now, in the scene's data frame (the chunked object's parent's): the
   *  union of each chunk's reach around its body. */
  extent(): Bounds {
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    this.chunks.forEach((chunk, i) => {
      if (!chunk.visible) return; // fell off the ground
      // The group's turn (180° about x) takes the physics frame's (x, y, z) to (x, -y, -z).
      const p = [chunk.position.x, -chunk.position.y, -chunk.position.z];
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], p[a] - this.reach[i]);
        max[a] = Math.max(max[a], p[a] + this.reach[i]);
      }
    });
    return { min, max };
  }

  /** The median chunk in world space, now or at rest: what a camera following the object looks
   *  at (a few pieces thrown far must not drag it away). */
  middleWorld(atRest = false): THREE.Vector3 {
    return this.group.localToWorld(new THREE.Vector3(...(atRest ? this.restMiddle : this.median())));
  }

  dispose(): void {
    this.sim?.dispose();
    this.sim = undefined;
  }

  /** The group the chunks live in: the physics frame, under the object's turn. */
  private get group(): THREE.Object3D {
    return this.chunks[0].parent!;
  }

  /** The median chunk position, per axis, in the physics frame. */
  private median(): V3 {
    const at = (a: "x" | "y" | "z") => {
      const v = this.chunks.map((c) => c.position[a]).sort((p, q) => p - q);
      return v[v.length >> 1];
    };
    return [at("x"), at("y"), at("z")];
  }

  /** The chunks' centroid in the physics frame (a blast's centre). */
  private middle(): V3 {
    const c: V3 = [0, 0, 0];
    for (const chunk of this.chunks) {
      c[0] += chunk.position.x / this.chunks.length;
      c[1] += chunk.position.y / this.chunks.length;
      c[2] += chunk.position.z / this.chunks.length;
    }
    return c;
  }

  /** A world-space ray as an origin and a unit direction in the physics frame. */
  private toLocal(ray: THREE.Ray): [V3, V3] {
    this.group.updateWorldMatrix(true, false);
    const inverse = this.group.matrixWorld.clone().invert();
    const origin = ray.origin.clone().applyMatrix4(inverse);
    const dir = ray.direction.clone().transformDirection(inverse);
    return [origin.toArray(), dir.toArray()];
  }

  /** The Sim, created and calibrated on first call, in slices with progress. */
  private prepared(): Promise<Sim> {
    this.preparing ??= (async () => {
      this.setState("calibrating");
      const sim = new Sim(await loadBox3d(), this.chunked.scene,
        { strength: this.strength, shatterSpeed: this.shatterSpeed });
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
      this.setState("paused");
      return sim;
    })();
    return this.preparing;
  }

  /** Run from the Sim's current state, showing it. */
  private start(sim: Sim): void {
    this.place(sim);
    this.setState("running");
  }

  /** Copy the bodies' transforms onto the chunks; a chunk that fell off the ground is hidden. */
  private place(sim: Sim): void {
    sim.transforms(this.xf);
    this.chunks.forEach((chunk, i) => {
      const x = this.xf, k = 7 * i;
      chunk.visible = !sim.lost.has(i);
      chunk.position.set(x[k], x[k + 1], x[k + 2]);
      chunk.quaternion.set(x[k + 3], x[k + 4], x[k + 5], x[k + 6]);
    });
  }

  /** Put the Sim to sleep if no chunk moved visibly since the last check (CREEP_*). */
  private checkCreep(sim: Sim): void {
    const a = this.mark, b = this.xf;
    let still = this.markTime > 0;
    for (let k = 0; still && k < b.length; k += 7) {
      const turn = 2 * Math.acos(Math.min(1, Math.abs(
        a[k + 3] * b[k + 3] + a[k + 4] * b[k + 4] + a[k + 5] * b[k + 5] + a[k + 6] * b[k + 6])));
      still = Math.hypot(b[k] - a[k], b[k + 1] - a[k + 1], b[k + 2] - a[k + 2]) < CREEP_DISTANCE
        && turn < CREEP_ANGLE;
    }
    if (still) sim.sleep();
    a.set(b);
    this.markTime = this.simTime;
  }

  private setState(state: PhysicsState): void {
    this.state = state;
    this.lastTick = 0;
    this.carry = 0;
    this.simTime = this.markTime = 0;
    this.onChange();
  }
}
