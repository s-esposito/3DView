// The physics of chunked voxel objects (box3d-wasm): one rigid body per chunk made of its boxes,
// a weld per pair of touching chunks, welds broken when their load per area passes the glue.
// Objects (Sim) live in a World — one box3d world with the ground — so several collide with each
// other. No DOM, so `node --test` runs it as the viewer does. Ported from GenerativeReconstruction's
// prototype (scripts/visualization/physics_demo/app/sim.js), whose ROADMAP.md records why each
// choice was made.

export type V3 = [number, number, number];
/** A box [cx, cy, cz, hx, hy, hz]: centre and half extents, metres, in its body's frame. */
export type Box = [number, number, number, number, number, number];

/** A chunked object: what export_chunks.py writes, and what voxelScene.ts generates. */
export interface PhysicsScene {
  /** Voxel side, metres. */
  voxelSize: number;
  /** Every body's rest orientation (the voxel grid's in the world), [x, y, z, w]; absent = identity. */
  rotation?: [number, number, number, number];
  chunks: {
    /** Rest position of the body (its centre of mass), world. */
    position: V3;
    /** Voxel centres in the body's frame (drawn). */
    voxels: V3[];
    /** The voxels merged into boxes (collided). */
    boxes: Box[];
    /** Chunk colour, 0..1. */
    color: V3;
    /** An exported object's [start, count] rows of its splats (chunkedObject.ts). */
    splats?: [number, number];
  }[];
  /** One per pair of chunks sharing faces: anchor at their faces' centre (world), area in m². */
  welds: { a: number; b: number; anchor: V3; area: number }[];
}

export const DEFAULTS = {
  /** Pa: a weld breaks when its force / area, or torque / area^1.5, passes it, until calibrate()
   *  replaces it with per-weld strengths from the object's own loads. */
  glue: 100e3,
  /** calibrate(): each weld breaks at this x its base load. */
  strength: 10,
  /** m/s: a chunk hit faster than this loses all its welds (brittle); Infinity = off. */
  shatterSpeed: Number.POSITIVE_INFINITY,
  /** Brittle: a loosened chunk is kicked away from the hit at this x the excess speed. */
  burst: 1,
  /** kg/m³. */
  density: 500,
  friction: 0.6,
  restitution: 0.05,
  /** Each box shrunk by this fraction of a voxel on every side pair, so neighbours never rest in contact. */
  gap: 0.02,
  /** The World's (a Sim's own World is made with these). */
  substeps: 4,
  dt: 1 / 60,
};
/** m/s², down -y. */
export const EARTH_GRAVITY = 9.81;
export type SimOptions = typeof DEFAULTS;

const ROT0: Box3dQuat = { x: 0, y: 0, z: 0, w: 1 };
// Shape and body tags: each Sim's chunks get a range of tags from its World (Sim.tag0 + chunk);
// the ground is tagged too, since box3d-wasm gives an untagged shape or body a tag from a global
// counter, which can land on a chunk's.
const GROUND_TAG = 2 ** 30;
/** m: a body below this went over the ground's edge (it is 100 m across); nothing would ever stop
 *  its fall, which would keep the world awake, so it is put to sleep there (Sim.lost). */
const FALL_LIMIT = -10;
const v3 = ([x, y, z]: readonly number[]): Box3dVec3 => ({ x, y, z });
const norm = (v: Box3dVec3): number => Math.hypot(v.x, v.y, v.z);
/** Quaternion product a * b. */
const qmul = (a: Box3dQuat, b: Box3dQuat): Box3dQuat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
const conj = (q: Box3dQuat): Box3dQuat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
/** ``v`` rotated by ``q``. */
const rotate = (q: Box3dQuat, [x, y, z]: V3): V3 => {
  const p = qmul(qmul(q, { x, y, z, w: 0 }), conj(q));
  return [p.x, p.y, p.z];
};

/** Where an object rests in its World: its rest pose (the scene's chunk positions and rotation)
 *  turned by ``rotation`` [x, y, z, w] about the origin, then moved by ``position``. */
export interface Pose { position: V3; rotation: [number, number, number, number] }

/** What a ray met first: a chunk of one of the World's objects, and where. */
export interface ChunkHit { sim: Sim; chunk: number; point: V3 }

interface Weld { joint: Box3dJoint; area: number; alive: boolean }

/**
 * One box3d world with the ground (100 m across, its top at y = 0), stepped as one, holding any
 * number of chunked objects (Sim), which collide with each other. Tags route the engine's hits,
 * rays and blasts back to the object and chunk they met.
 */
export class World {
  readonly box3d: Box3dWorld;
  readonly objects: Sim[] = [];
  gravity: number;
  /** Seconds per step, and box3d substeps per step. */
  readonly dt: number;
  readonly substeps: number;
  private nextTag = 1;

  constructor(b3: Box3dModule, { gravity = EARTH_GRAVITY, friction = DEFAULTS.friction,
    dt = DEFAULTS.dt, substeps = DEFAULTS.substeps } = {}) {
    this.gravity = gravity;
    this.dt = dt;
    this.substeps = substeps;
    this.box3d = new b3.World({ gravity: { x: 0, y: -gravity, z: 0 } });
    const ground = this.box3d.createBody({ type: "static", position: { x: 0, y: -0.5, z: 0 } });
    ground.createBox({ halfExtents: { x: 50, y: 0.5, z: 50 }, friction, userData: GROUND_TAG });
    ground.setUserData(GROUND_TAG);
  }

  /** ``n`` tags for a new object's chunks: the first. */
  claim(n: number): number {
    const tag = this.nextTag;
    this.nextTag += n;
    return tag;
  }

  /** Advance one fixed step; then each object breaks its overloaded welds and takes its hits. */
  step(): void {
    this.box3d.step(this.dt, this.substeps);
    const hits = this.box3d.getContactEvents().hit;
    for (const sim of this.objects) sim.afterStep(hits);
  }

  /** m/s², down -y. */
  setGravity(g: number): void {
    this.gravity = g;
    this.box3d.setGravity({ x: 0, y: -g, z: 0 });
    for (const sim of this.objects) for (const body of sim.bodies) body.setAwake(true);
  }

  /** The object and chunk a tag belongs to, if any. */
  private owner(tag: number): { sim: Sim; chunk: number } | null {
    for (const sim of this.objects) {
      const chunk = tag - sim.tag0;
      if (chunk >= 0 && chunk < sim.bodies.length) return { sim, chunk };
    }
    return null;
  }

  /** The first chunk along ``dir`` (unit) from ``origin``, within ``range`` m. */
  cast(origin: V3, dir: V3, range = 100): ChunkHit | null {
    const hit = this.box3d.castRayClosest(v3(origin), v3(dir.map((d) => d * range)));
    const owner = hit.hit ? this.owner(hit.bodyUserData) : null;
    return owner && { ...owner, point: [hit.point.x, hit.point.y, hit.point.z] };
  }

  /** A shot along ``dir`` (unit) from ``origin``: the chunk it meets first, of whichever object,
   *  is knocked out and kicked (Sim.knockOut). What it hit. */
  shoot(origin: V3, dir: V3, { speed = 6, radius = 0.1, range = 100 } = {}): ChunkHit | null {
    const hit = this.cast(origin, dir, range);
    hit?.sim.knockOut(hit.chunk, hit.point, dir, speed, radius);
    return hit;
  }

  /** A blast at ``point``: every object's welds within ``radius`` break, then every shape within
   *  it is pushed away with ``impulsePerArea`` (Sim.explode picks it). */
  explode(point: V3, radius: number, impulsePerArea: number): void {
    for (const sim of this.objects) sim.breakNear(point, radius);
    this.box3d.explode({ position: v3(point), radius, falloff: 0.5 * radius, impulsePerArea });
  }

  /** How many bodies still move (Box3D puts bodies at rest to sleep). */
  get awake(): number { return this.box3d.getAwakeBodyCount(); }

  /** Put every body to sleep (until something wakes it: a hit, a shot, a blast). */
  sleep(): void { for (const sim of this.objects) sim.sleep(); }

  dispose(): void { this.box3d.destroy(); }
}

/** One chunked object in a World. */
export class Sim {
  readonly o: SimOptions;
  readonly world: World;
  /** The tag of chunk 0 (World.claim). */
  readonly tag0: number;
  bodies: Box3dBody[] = [];
  welds: Weld[] = [];
  /** Welds broken since the last reset. */
  broken = 0;
  /** Chunks that fell off the ground since the last reset (FALL_LIMIT), asleep where they went. */
  lost = new Set<number>();
  /** Each weld's load in the last step, Pa. */
  lastLoad = new Float32Array(0);
  /** Each weld's breaking load, Pa. */
  limit = new Float32Array(0);
  /** Per-weld base loads from calibrate(); null until then (every weld at ``glue``). */
  base: Float32Array | null = null;
  /** Where it rests (reset() places it there); identity = the scene's own rest pose. */
  pose: Pose = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
  /** Each weld's anchor in its two bodies' frames (they share the scene's rest rotation). */
  private readonly anchors: [Box3dVec3, Box3dVec3][];
  private readonly restRotation: Box3dQuat;
  /** Each chunk's welds, for brittle breaks and shots. */
  private readonly weldsOf: number[][];
  private readonly ownsWorld: boolean;
  private enabled = true;

  /** ``b3``: the engine (loadBox3d()); ``scene``: the chunked object; ``world``: the World it
   *  joins (none: a World of its own, made with ``options``' dt and substeps). */
  constructor(b3: Box3dModule, readonly scene: PhysicsScene, options: Partial<SimOptions> = {}, world?: World) {
    this.o = { ...DEFAULTS, ...options };
    this.ownsWorld = !world;
    this.world = world ?? new World(b3, { friction: this.o.friction, dt: this.o.dt, substeps: this.o.substeps });
    this.tag0 = this.world.claim(scene.chunks.length);
    this.world.objects.push(this);
    const r = scene.rotation;
    this.restRotation = r ? { x: r[0], y: r[1], z: r[2], w: r[3] } : ROT0;
    this.anchors = scene.welds.map((w) => [w.a, w.b].map((c) => {
      const [x, y, z] = rotate(conj(this.restRotation), w.anchor.map((x, k) => x - scene.chunks[c].position[k]) as V3);
      return { x, y, z };
    }) as [Box3dVec3, Box3dVec3]);
    this.weldsOf = scene.chunks.map(() => []);
    scene.welds.forEach((w, i) => { this.weldsOf[w.a].push(i); this.weldsOf[w.b].push(i); });
    this.reset();
  }

  /** Rebuild the object, whole, at its pose: lifted by ``lift`` metres, turned ``tilt`` rad about
   *  its own z axis through its footprint's centre (its rest frame's origin). */
  reset({ lift = 0, tilt = 0 } = {}): void {
    for (const body of this.bodies) body.destroy(); // its welds with it
    this.lost.clear();
    const { scene, o } = this, [px, py, pz] = this.pose.position, [qx, qy, qz, qw] = this.pose.rotation;
    const turn = qmul({ x: qx, y: qy, z: qz, w: qw }, { x: 0, y: 0, z: Math.sin(tilt / 2), w: Math.cos(tilt / 2) });
    const place = (p: V3): V3 => {
      const [x, y, z] = rotate(turn, p);
      return [x + px, y + py + lift, z + pz];
    };
    const rot = qmul(turn, this.restRotation);
    const shrink = 0.5 * scene.voxelSize * o.gap;
    this.bodies = scene.chunks.map((chunk, i) => {
      const body = this.world.box3d.createBody({ type: "dynamic", position: v3(place(chunk.position)), rotation: rot });
      for (const [cx, cy, cz, hx, hy, hz] of chunk.boxes)
        body.createBox({
          halfExtents: { x: hx - shrink, y: hy - shrink, z: hz - shrink }, offset: { x: cx, y: cy, z: cz },
          density: o.density, friction: o.friction, restitution: o.restitution,
          userData: this.tag0 + i, enableHitEvents: true, // tagged as its chunk, for hits
        });
      body.setUserData(this.tag0 + i); // rays read the chunk off the body hit
      if (!this.enabled) body.setEnabled(false);
      return body;
    });
    // Each weld's frame: the anchor in each body's frame (the bodies start with the same rotation).
    this.welds = scene.welds.map((w, i) => {
      const [anchorA, anchorB] = this.anchors[i];
      const joint = this.world.box3d.createWeldJoint(this.bodies[w.a], this.bodies[w.b], {
        localFrameA: { position: anchorA, rotation: ROT0 },
        localFrameB: { position: anchorB, rotation: ROT0 },
      });
      return { joint, area: w.area, alive: true };
    });
    this.broken = 0;
    this.lastLoad = new Float32Array(this.welds.length);
    if (!this.base) this.limit = new Float32Array(this.welds.length).fill(o.glue);
  }

  /** Per-weld strengths from the object's own loads, with unbreakable welds left ``settle`` s at
   *  rest (an object may first tip onto its stable side) then ``measure`` s more: each weld's base
   *  is the larger of the typical settled load (p90 over the welds) and its own peak over the run,
   *  and it breaks at ``setStrength(k)`` x that. So one glue holds most welds, the few that carry
   *  the object get their own margin, and the object stands for k > 1. A fixed glue does not
   *  carry over: loads concentrate (the sloth's settled p50/p90/max: 1.3/10/131 kPa, the blob's
   *  0.4/2.2/21), and the most loaded weld would set it for all. Returns the p90 load.
   *  Steps the whole World, so calibrate a Sim alone in its own and hand its ``base`` on. */
  calibrate(options: { settle?: number; measure?: number } = {}): number {
    const run = this.calibrating(options);
    for (;;) {
      const r = run.next();
      if (r.done) return r.value;
    }
  }

  /** calibrate() one step at a time, yielding the fraction done, so a viewer can spread the
   *  ~7 simulated seconds over several frames and show progress. Returns the p90 load. */
  *calibrating({ settle = 6, measure = 1 } = {}): Generator<number, number> {
    this.o.glue = Number.POSITIVE_INFINITY;
    this.base = null;
    this.reset();
    const whole = new Float32Array(this.welds.length), settled = new Float32Array(this.welds.length);
    const steps = Math.round((settle + measure) / this.world.dt), from = Math.round(settle / this.world.dt);
    for (let i = 0; i < steps; i++) {
      this.step();
      this.lastLoad.forEach((l, j) => {
        whole[j] = Math.max(whole[j], l);
        if (i >= from) settled[j] = Math.max(settled[j], l);
      });
      yield (i + 1) / steps;
    }
    const typical = [...settled].sort((a, b) => a - b)[Math.floor(0.9 * (settled.length - 1))] ?? 0;
    this.base = whole.map((l) => Math.max(l, typical));
    this.setStrength(this.o.strength);
    this.reset();
    return typical;
  }

  /** Every weld breaks at ``k`` x its calibrated base load (needs calibrate()). */
  setStrength(k: number): void {
    if (!this.base) throw new Error("setStrength() needs calibrate() first");
    this.o.strength = k;
    this.limit = this.base.map((b) => k * b);
  }

  /** The glue vanishes: every weld breaks at once. A hollow object (the sloth) collapses under its
   *  own weight; a solid one stands like a dry-stone wall, its chunks nested in each other. Weak
   *  glue or glue dissolving over a few seconds does not do it: most welds carry far less than
   *  their base load, and pieces freed one by one settle onto each other and stay standing. */
  unglue(): void {
    this.welds.forEach((_, i) => this.breakWeld(i));
  }

  /** Step its World (with every object in it). */
  step(): void {
    this.world.step();
  }

  /** After a World step: break every weld whose load passes the glue; brittle, loosen the chunks
   *  hit too fast; put to sleep the chunks that fell off the ground. */
  afterStep(hits: ReturnType<Box3dWorld["getContactEvents"]>["hit"]): void {
    this.welds.forEach((w, i) => {
      if (!w.alive) return;
      const load = Math.max(norm(w.joint.getConstraintForce()) / w.area,
        norm(w.joint.getConstraintTorque()) / w.area ** 1.5);
      this.lastLoad[i] = load;
      if (load > this.limit[i]) this.breakWeld(i);
    });
    // Brittle: a chunk hit faster than shatterSpeed (by the ground or another chunk) comes loose,
    // kicked away from the hit by ``burst`` x the excess speed, so the pieces separate rather
    // than lie where they broke.
    if (Number.isFinite(this.o.shatterSpeed))
      for (const hit of hits) {
        const excess = hit.approachSpeed - this.o.shatterSpeed;
        if (excess <= 0) continue;
        for (const tag of [hit.shapeUserDataA, hit.shapeUserDataB]) {
          const chunk = tag - this.tag0;
          if (chunk < 0 || chunk >= this.bodies.length || !this.weldsOf[chunk].some((i) => this.welds[i].alive)) continue;
          for (const i of this.weldsOf[chunk]) this.breakWeld(i);
          const body = this.bodies[chunk], p = body.getPosition(), v = body.getLinearVelocity();
          const away: V3 = [p.x - hit.point.x, p.y - hit.point.y, p.z - hit.point.z];
          const k = (this.o.burst * excess) / (Math.hypot(...away) || 1);
          body.setLinearVelocity({ x: v.x + k * away[0], y: v.y + k * away[1], z: v.z + k * away[2] });
        }
      }
    this.bodies.forEach((body, i) => {
      if (!this.lost.has(i) && body.getPosition().y < FALL_LIMIT) {
        body.setAwake(false);
        this.lost.add(i);
      }
    });
  }

  /** Each chunk's [x, y, z, qx, qy, qz, qw] in the World, packed. */
  transforms(out: Float32Array = new Float32Array(7 * this.bodies.length)): Float32Array {
    this.bodies.forEach((b, i) => {
      const p = b.getPosition(), q = b.getRotation();
      out.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w], 7 * i);
    });
    return out;
  }

  /** An explosion at ``point``: the welds within ``radius`` of it break (every object's), then
   *  every shape within ``radius`` is pushed away, about ``speed`` m/s to a voxel-thick piece of
   *  this object (Box3D pushes per m² of shape, so the impulse per area is speed x density x voxel
   *  size: a thin shell's pieces fly as fast as a solid's, not faster). Breaking first is what makes
   *  it local: whole, the welds pass the push to the entire object. */
  explode(point: V3, { radius = 0.3, speed = 4 } = {}): void {
    this.world.explode(point, radius, speed * this.o.density * this.scene.voxelSize);
  }

  /** Knock ``chunk`` out where ``point`` was hit along ``dir``: all its welds break, and those
   *  within ``radius`` of the hit, and it is kicked to about ``speed`` m/s (impulse = speed x its
   *  mass). */
  knockOut(chunk: number, point: V3, dir: V3, speed: number, radius: number): void {
    const body = this.bodies[chunk];
    for (const i of this.weldsOf[chunk]) this.breakWeld(i);
    this.breakNear(point, radius);
    body.applyLinearImpulse(v3(dir.map((d) => d * speed * body.getMass())), v3(point), true);
  }

  /** Break every live weld whose anchor (as body A carries it now) lies within ``radius`` of ``point``. */
  breakNear(point: V3, radius: number): void {
    this.scene.welds.forEach((w, i) => {
      if (!this.welds[i].alive) return;
      const p = this.bodies[w.a].getWorldPoint(this.anchors[i][0]);
      if (Math.hypot(p.x - point[0], p.y - point[1], p.z - point[2]) < radius) this.breakWeld(i);
    });
  }

  breakWeld(i: number): void {
    const w = this.welds[i];
    if (!w.alive) return;
    w.joint.destroy(true);
    w.alive = false;
    this.broken += 1;
  }

  /** The pieces the object is in (groups of chunks still welded together): their sizes in chunks,
   *  largest first. */
  pieceSizes(): number[] {
    const parent = this.scene.chunks.map((_, i) => i);
    const root = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    this.scene.welds.forEach((w, i) => { if (this.welds[i].alive) parent[root(w.a)] = root(w.b); });
    const size = new Map<number, number>();
    parent.forEach((_, i) => size.set(root(i), (size.get(root(i)) ?? 0) + 1));
    return [...size.values()].sort((a, b) => b - a);
  }

  /** How many of its chunks still move (Box3D puts bodies at rest to sleep). */
  get awake(): number { return this.bodies.reduce((n, b) => n + (b.isAwake() ? 1 : 0), 0); }

  /** Put its bodies to sleep (until something wakes them: a hit, a shot, a blast). */
  sleep(): void { for (const body of this.bodies) body.setAwake(false); }

  /** Take it out of the World (``false``: nothing collides with it, rays and blasts pass it, its
   *  bodies keep where they are) or back in; reset() keeps the setting. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    for (const body of this.bodies) body.setEnabled(on);
  }

  /** Leave the World (its own: free it). */
  dispose(): void {
    if (this.ownsWorld) {
      this.world.dispose();
      return;
    }
    for (const body of this.bodies) body.destroy();
    this.world.objects.splice(this.world.objects.indexOf(this), 1);
  }
}
