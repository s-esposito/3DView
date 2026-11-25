// The scene's physics in the viewer. One PhysicsRuntime (the Viewer's) owns the World — one box3d
// world, one ground at the scene's y = 0, one clock — and every physics object's PhysicsRun joins
// it, so the objects collide. A breakable object calibrates its welds once, alone in a world of
// its own, before it joins; then its Sim moves its nodes (a chunked object's chunk SplatObjects,
// a rigid asset's one pivot — rigidObject.ts). The nodes live under a group (the turn into the
// scene's data frame — chunkedObject.ts — under the item's own
// transform); the World's frame is that turn alone, so an object rests where its item is placed.
// Rays and points from the viewer arrive in world space and are taken into the World's frame here.
import * as THREE from "three";
import type { Bounds } from "../../shared/messages";
import { loadBox3d } from "./box3d";
import { DEFAULTS, EARTH_GRAVITY, Sim, World, type PhysicsScene, type V3 } from "./sim";

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
/** A box's 12 edges, as pairs of its corners (corner k: bit 0 = +x, bit 1 = +y, bit 2 = +z). */
const BOX_EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

/** The scene's simulation: the World every physics object joins, its clock and its settings. */
export class PhysicsRuntime {
  running = false;
  /** Sim seconds per real second (slow motion below 1); the steps stay the same. */
  speed = 1;
  /** m/s². */
  gravity = EARTH_GRAVITY;
  /** Metres per scene unit (World.unit); 1 = the scene is in metres. */
  unit = 1;
  /** The floor's top (World y, scene units), or null for none (the Viewer keeps it at the scene's
   *  bottom). */
  floor: number | null = 0;
  readonly runs: PhysicsRun[] = [];
  /** Called when the clock starts or stops, or a run's state, settings or progress move. */
  onChange: () => void = () => {};

  private world?: World;
  private preparing?: Promise<World>;
  private carry = 0;
  private lastTick = 0;
  /** Sim time since the clock started, and the time of the last creep check. */
  private simTime = 0;
  private markTime = 0;

  add(run: PhysicsRun): void {
    run.runtime = this;
    this.runs.push(run);
  }

  remove(run: PhysicsRun): void {
    run.dispose();
    const i = this.runs.indexOf(run);
    if (i >= 0) this.runs.splice(i, 1);
  }

  /** The World with every run in it: each not yet in calibrates first (in turn, with progress),
   *  so nothing falls through an object that was never touched. Calls queue behind each other;
   *  one that failed does not stop the next from trying again. */
  prepared(): Promise<World> {
    const prepare = async (): Promise<World> => {
      const b3 = await loadBox3d();
      const world = (this.world ??= new World(b3, { gravity: this.gravity, unit: this.unit, floor: this.floor }));
      // One World for all: setUnit may replace it meanwhile, and the prepare it queues joins them anew.
      for (const run of [...this.runs]) await run.join(b3, world); // a run may go meanwhile
      return world;
    };
    this.preparing = (this.preparing?.catch(() => undefined) ?? Promise.resolve()).then(prepare);
    return this.preparing;
  }

  async play(): Promise<void> {
    await this.prepared();
    this.start();
  }

  pause(): void {
    this.setRunning(false);
  }

  /** Every object back to rest, whole; the clock stops. */
  resetAll(): void {
    for (const run of this.runs) run.reset();
    this.setRunning(false);
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.onChange();
  }

  /** Move the floor (World y, scene units) or take it away (null). */
  setFloor(y: number | null): void {
    this.floor = y;
    this.world?.setFloor(y);
    this.onChange();
  }

  /** Metres per scene unit. The World is built again in the new units and every object joins it
   *  anew, back at rest — a breakable one calibrated again, as its welds' loads are in units. */
  setUnit(metres: number): void {
    this.unit = metres;
    if (this.world) {
      for (const run of this.runs) run.dispose();
      this.world.dispose();
      this.world = undefined;
      this.setRunning(false);
      void this.prepared();
    }
    this.onChange();
  }

  setGravity(g: number): void {
    this.gravity = g;
    this.world?.setGravity(g);
    this.onChange();
  }

  /** (Re)start the clock: after an action, so the creep check starts over. */
  start(): void {
    this.setRunning(true);
  }

  /**
   * Advance by the time since the last tick, times the speed, in fixed steps (the viewer calls
   * this every frame). Returns whether anything still moves: the frame needs drawing, and a frame
   * too short for a step does not mean it came to rest.
   */
  tick(now: number): boolean {
    const world = this.world;
    if (!world || !this.running) {
      this.lastTick = 0;
      return false;
    }
    const elapsed = this.speed * (this.lastTick ? (now - this.lastTick) / 1000 : world.dt);
    this.lastTick = now;
    this.carry = Math.min(this.carry + elapsed, MAX_STEPS_PER_FRAME * world.dt);
    let stepped = false;
    while (this.carry >= world.dt) {
      world.step();
      this.carry -= world.dt;
      this.simTime += world.dt;
      stepped = true;
    }
    if (stepped) {
      for (const run of this.runs) run.place();
      if (this.simTime - this.markTime >= CREEP_WINDOW) {
        // Every run compares and re-marks, so map before every().
        const still = this.runs.map((run) => run.still()).every(Boolean);
        if (still && this.markTime > 0) world.sleep();
        this.markTime = this.simTime;
      }
    }
    return world.awake > 0;
  }

  /** The playback bar's line. */
  get status(): string {
    const n = this.runs.length;
    const objects = `${n} object${n === 1 ? "" : "s"}`;
    if (!this.running) return `${objects}, paused`;
    return `${objects}, ${(this.world?.awake ?? 0) > 0 ? "moving" : "at rest"}`;
  }

  dispose(): void {
    for (const run of this.runs) run.dispose();
    this.world?.dispose();
    this.world = undefined;
  }

  private setRunning(running: boolean): void {
    this.running = running;
    this.lastTick = 0;
    this.carry = 0;
    this.simTime = this.markTime = 0;
    this.onChange();
  }
}

/** One object's physics: its Sim in the runtime's World, and its nodes (one per body) on screen. */
export class PhysicsRun {
  /** Set by PhysicsRuntime.add. */
  runtime?: PhysicsRuntime;
  /** Calibrating (alone, before it joins the World). */
  calibrating = false;
  /** Calibration progress, 0..1. */
  progress = 0;
  /** In the World (its item shown) or out of it (hidden): nothing collides with a hidden one. */
  enabled = true;
  /** Glue: each weld breaks at this x the load it carries at rest (Sim.setStrength). */
  strength = DEFAULTS.strength;
  /** Shatter on impact: a chunk hit faster than this (m/s) comes loose; Infinity = off. */
  shatterSpeed = Number.POSITIVE_INFINITY;

  private sim?: Sim;

  /** A chunked object (welds to break) rather than a rigid one. */
  get breakable(): boolean {
    return this.scene.welds.length > 0;
  }

  /** A dynamic body (it moves) rather than a static one (it only stops others). */
  get dynamic(): boolean {
    return this.body === "dynamic";
  }
  /** Its pose in the World (the item's placement, taken at each reset) and that turn's inverse. */
  private readonly at = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();
  private readonly unturn = new THREE.Quaternion();
  private readonly xf: Float32Array;
  /** The transforms at the last creep check. */
  private readonly mark: Float32Array;
  /** Each chunk's reach from its body's origin (its farthest box corner), for the extent. */
  private readonly reach: number[];
  /** The median chunk at rest (the group's frame). */
  private readonly restMiddle: V3;

  /** ``scene``: its bodies (a breakable object's chunks and welds, or a rigid asset's one chunk);
   *  ``nodes``: what each body moves, at its rest pose, under one group in the World's frame;
   *  ``body``: dynamic, or static (an environment: it only stops others). */
  constructor(private readonly scene: PhysicsScene, private readonly nodes: THREE.Object3D[],
    private readonly body: "dynamic" | "static" = "dynamic") {
    this.xf = new Float32Array(7 * nodes.length);
    this.mark = new Float32Array(7 * nodes.length);
    this.reach = scene.chunks.map((c) => Math.max(...c.boxes.map(([x, y, z, hx, hy, hz]) =>
      Math.hypot(Math.abs(x) + hx, Math.abs(y) + hy, Math.abs(z) + hz))));
    this.restMiddle = this.median(); // the nodes are built at rest
  }

  /** Calibrate alone (in slices, with progress; only welds need it), then join ``world`` where its
   *  item is placed. A no-op once joined, and once removed from its runtime (it may be, between
   *  two slices). */
  async join(b3: Box3dModule, world: World): Promise<void> {
    if (this.sim || !this.runtime?.runs.includes(this) || world.disposed) return; // joined, removed, stale
    if (!this.breakable) {
      this.sim = new Sim(b3, this.scene, { body: this.body }, world);
      this.sim.setEnabled(this.enabled);
      this.reset();
      return;
    }
    this.calibrating = true;
    this.changed();
    const probeWorld = new World(b3, { unit: world.unit }); // calibrated in the scene's units
    const probe = new Sim(b3, this.scene, {}, probeWorld);
    try {
      const run = probe.calibrating();
      for (let done = false; !done;) {
        const until = performance.now() + SLICE_MS;
        while (performance.now() < until) {
          const r = run.next();
          if (r.done) { done = true; break; }
          this.progress = r.value;
        }
        this.changed();
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Removed meanwhile, or its World rebuilt (a new scene unit; the runtime joins it anew).
        if (!this.runtime?.runs.includes(this) || world.disposed) return;
      }
      this.sim = new Sim(b3, this.scene, { shatterSpeed: this.shatterSpeed }, world);
      this.sim.base = probe.base;
      this.sim.setStrength(this.strength);
      this.sim.setEnabled(this.enabled);
    } finally {
      probeWorld.dispose();
      this.calibrating = false;
    }
    this.reset();
  }

  /** Whether its collision shape is drawn (setShapeVisible). */
  shapeShown = false;
  private shapes?: THREE.LineSegments[];

  /** Draw each body's boxes as a wireframe on its node, so they move with it: a check that the
   *  collision shape follows the object. */
  setShapeVisible(on: boolean): void {
    this.shapeShown = on;
    this.shapes ??= this.nodes.map((node, i) => {
      const xyz: number[] = [];
      for (const [x, y, z, hx, hy, hz] of this.scene.chunks[i].boxes) {
        const c = (k: number) => [x + (k & 1 ? hx : -hx), y + (k & 2 ? hy : -hy), z + (k & 4 ? hz : -hz)];
        for (const [a, b] of BOX_EDGES) xyz.push(...c(a), ...c(b));
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(xyz, 3));
      const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xff8a1f }));
      node.add(lines);
      return lines;
    });
    for (const lines of this.shapes) lines.visible = on;
  }

  /** In or out of the World (its item shown or hidden). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.sim?.setEnabled(on);
  }

  /** Lift the object ``height`` metres, tilted, and let it fall. */
  async drop(height: number): Promise<void> {
    const sim = await this.prepared();
    this.repose(sim);
    sim.reset({ lift: height, tilt: DROP_TILT });
    this.start();
  }

  /** Back to rest, whole, where its item is placed (the clock runs on for the others). */
  reset(): void {
    if (!this.sim) return;
    this.repose(this.sim);
    this.sim.reset();
    this.place();
    this.changed();
  }

  setStrength(k: number): void {
    this.strength = k;
    this.sim?.setStrength(k);
    this.changed();
  }

  setShatterSpeed(speed: number): void {
    this.shatterSpeed = speed;
    if (this.sim) this.sim.o.shatterSpeed = speed;
    this.changed();
  }

  /** A shot along a world-space ray: knocks out the first chunk it meets (of any object).
   *  Whether it hit one. */
  async shoot(ray: THREE.Ray): Promise<boolean> {
    const sim = await this.prepared();
    const hit = sim.world.shoot(...this.toWorldFrame(ray)) !== null;
    if (hit) this.start();
    return hit;
  }

  /** A blast where a world-space ray first meets a chunk (of any object). Whether it hit one. */
  async blast(ray: THREE.Ray): Promise<boolean> {
    const sim = await this.prepared();
    const hit = sim.world.cast(...this.toWorldFrame(ray));
    if (!hit) return false;
    hit.sim.explode(hit.point, { radius: 0.3 });
    this.start();
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
    this.reset(); // the blast's middle and the volley's aim are the rest pose's
    if (name === "explode") sim.explode(this.worldPoint(this.middle()), { radius: 0.5 });
    else if (name === "crumble") sim.unglue();
    else for (const ray of aim(this.middleWorld())) sim.world.shoot(...this.toWorldFrame(ray), { speed: 10 });
    this.start();
  }

  /** Its panel line: the pieces once anything broke, and whether it still moves. */
  get status(): string {
    if (this.calibrating) return `calibrating ${Math.round(100 * this.progress)}%`;
    if (!this.sim) return "whole, at rest";
    if (this.sim.lost.size === this.nodes.length) return "fell out of the scene (Restore brings it back)";
    const sizes = this.sim.pieceSizes();
    const pieces = sizes.length === 1
      ? "whole"
      : `${sizes.length} pieces, largest ${Math.round((100 * sizes[0]) / this.nodes.length)}%`;
    const motion = !this.runtime?.running ? "paused" : this.sim.awake > 0 ? "moving" : "at rest";
    return `${pieces}, ${motion}`;
  }

  /** Where the chunks are now, in the scene's data frame (the chunked object's parent's): the
   *  union of each chunk's reach around its body. */
  extent(): Bounds {
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    this.nodes.forEach((chunk, i) => {
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
    const middle = new THREE.Vector3(...(atRest ? this.restMiddle : this.median())).applyMatrix4(this.unscale());
    return this.group.localToWorld(middle);
  }

  /** Copy the bodies' transforms onto the chunks, out of the World's frame into the group's; a
   *  chunk that fell off the ground is hidden. */
  place(): void {
    const sim = this.sim;
    if (!sim) return;
    sim.transforms(this.xf);
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    // The item's scale sits above the group: undo it on each node, so a body moves in metres
    // whatever the item's scale (exact per axis: the group's turn is diagonal, as a scale is).
    const unscale = this.unscale();
    this.nodes.forEach((node, i) => {
      const x = this.xf, k = 7 * i;
      node.visible = !sim.lost.has(i);
      node.position.copy(p.set(x[k], x[k + 1], x[k + 2]).sub(this.at).applyQuaternion(this.unturn));
      node.quaternion.copy(this.unturn).multiply(q.set(x[k + 3], x[k + 4], x[k + 5], x[k + 6]));
      node.updateMatrix();
      node.matrix.premultiply(unscale);
      node.matrixAutoUpdate = false;
    });
  }

  /** The inverse of the item's scale (its layer's object, above the group). */
  private unscale(): THREE.Matrix4 {
    const s = this.group.parent!.scale;
    return new THREE.Matrix4().makeScale(1 / s.x, 1 / s.y, 1 / s.z);
  }

  /** Whether no chunk moved visibly since the last call (CREEP_*); re-marks. */
  still(): boolean {
    if (!this.sim) return true;
    const a = this.mark, b = this.xf;
    let still = true;
    for (let k = 0; still && k < b.length; k += 7) {
      const turn = 2 * Math.acos(Math.min(1, Math.abs(
        a[k + 3] * b[k + 3] + a[k + 4] * b[k + 4] + a[k + 5] * b[k + 5] + a[k + 6] * b[k + 6])));
      still = Math.hypot(b[k] - a[k], b[k + 1] - a[k + 1], b[k + 2] - a[k + 2]) < CREEP_DISTANCE / this.sim.world.unit
        && turn < CREEP_ANGLE;
    }
    a.set(b);
    return still;
  }

  dispose(): void {
    this.sim?.dispose();
    this.sim = undefined;
    for (const lines of this.shapes ?? []) {
      lines.removeFromParent();
      lines.geometry.dispose();
      (lines.material as THREE.Material).dispose();
    }
    this.shapes = undefined;
    this.shapeShown = false;
  }

  /** The group the chunks live in: the World's frame, under the item's placement. */
  private get group(): THREE.Object3D {
    return this.nodes[0].parent!;
  }

  private prepared(): Promise<Sim> {
    if (!this.runtime) throw new Error("PhysicsRun: not added to a PhysicsRuntime");
    return this.runtime.prepared().then(() => this.sim!);
  }

  private start(): void {
    this.place();
    this.runtime?.start();
  }

  private changed(): void {
    this.runtime?.onChange();
  }

  /** Take the item's placement as the pose in the World: the group's turn T conjugating the
   *  item's matrix M (T⁻¹ M T). Its scale is not simulated. */
  private repose(sim: Sim): void {
    const group = this.group, item = group.parent!;
    group.updateMatrix();
    item.updateMatrix();
    const pose = group.matrix.clone().invert().multiply(item.matrix).multiply(group.matrix);
    pose.decompose(this.at, this.turn, new THREE.Vector3());
    this.unturn.copy(this.turn).invert();
    sim.pose = { position: this.at.toArray(), rotation: [this.turn.x, this.turn.y, this.turn.z, this.turn.w] };
  }

  /** The median chunk position, per axis, in the group's frame. */
  private median(): V3 {
    const at = (a: "x" | "y" | "z") => {
      const v = this.nodes.map((c) => c.position[a]).sort((p, q) => p - q);
      return v[v.length >> 1];
    };
    return [at("x"), at("y"), at("z")];
  }

  /** The chunks' centroid in the group's frame (a blast's centre). */
  private middle(): V3 {
    const c: V3 = [0, 0, 0];
    for (const chunk of this.nodes) {
      c[0] += chunk.position.x / this.nodes.length;
      c[1] += chunk.position.y / this.nodes.length;
      c[2] += chunk.position.z / this.nodes.length;
    }
    return c;
  }

  /** A point of the group's frame in the World's. */
  private worldPoint(p: V3): V3 {
    return new THREE.Vector3(...p).applyQuaternion(this.turn).add(this.at).toArray();
  }

  /** A world-space ray as an origin and a unit direction in the World's frame (the group's
   *  frame, then the pose). */
  private toWorldFrame(ray: THREE.Ray): [V3, V3] {
    this.group.updateWorldMatrix(true, false);
    // The group's frame carries the item's scale S; the World's is in metres: S · group⁻¹.
    const inverse = this.group.matrixWorld.clone().invert();
    const scale = this.group.parent!.scale;
    const origin = ray.origin.clone().applyMatrix4(inverse).multiply(scale).applyQuaternion(this.turn).add(this.at);
    const dir = ray.direction.clone().transformDirection(inverse).multiply(scale).normalize().applyQuaternion(this.turn);
    return [origin.toArray(), dir.toArray()];
  }
}
