// The physics of a chunked voxel object (box3d-wasm): one rigid body per chunk made of its
// boxes, a weld per pair of touching chunks, welds broken when their load per area passes the
// glue. No DOM, so `node --test` runs it as the viewer does. Ported from GenerativeReconstruction's
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
  substeps: 4,
  dt: 1 / 60,
};
export type SimOptions = typeof DEFAULTS;

const ROT0: Box3dQuat = { x: 0, y: 0, z: 0, w: 1 };
// Shape and body tags: chunk i is i + 1; the ground is tagged too, since box3d-wasm gives an
// untagged shape or body a tag from a global counter, which can land on a chunk's.
const GROUND_TAG = 2 ** 30;
const v3 = ([x, y, z]: readonly number[]): Box3dVec3 => ({ x, y, z });
const norm = (v: Box3dVec3): number => Math.hypot(v.x, v.y, v.z);
/** Quaternion product a * b. */
const qmul = (a: Box3dQuat, b: Box3dQuat): Box3dQuat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
/** ``v`` rotated by the inverse of ``q`` (a world offset into a body's frame). */
const unrotate = (q: Box3dQuat, [x, y, z]: V3): Box3dVec3 => {
  const p = qmul(qmul({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, { x, y, z, w: 0 }), q);
  return { x: p.x, y: p.y, z: p.z };
};

interface Weld { joint: Box3dJoint; area: number; alive: boolean }

export class Sim {
  readonly o: SimOptions;
  world!: Box3dWorld;
  bodies: Box3dBody[] = [];
  welds: Weld[] = [];
  /** Welds broken since the last reset. */
  broken = 0;
  /** Simulated seconds since the last reset. */
  time = 0;
  /** Each weld's load in the last step, Pa. */
  lastLoad = new Float32Array(0);
  /** Each weld's breaking load, Pa. */
  limit = new Float32Array(0);
  /** Per-weld base loads from calibrate(); null until then (every weld at ``glue``). */
  base: Float32Array | null = null;
  stats = { stepMs: 0, breakMs: 0 };
  /** Each weld's anchor in its two bodies' frames (they share the scene's rest rotation). */
  private readonly anchors: [Box3dVec3, Box3dVec3][];
  private readonly restRotation: Box3dQuat;
  /** Each chunk's welds, for brittle breaks and shots. */
  private readonly weldsOf: number[][];

  /** ``b3``: the engine (loadBox3d()); ``scene``: the chunked object. */
  constructor(private readonly b3: Box3dModule, readonly scene: PhysicsScene, options: Partial<SimOptions> = {}) {
    this.o = { ...DEFAULTS, ...options };
    const r = scene.rotation;
    this.restRotation = r ? { x: r[0], y: r[1], z: r[2], w: r[3] } : ROT0;
    this.anchors = scene.welds.map((w) => [w.a, w.b].map((c) => unrotate(this.restRotation,
      w.anchor.map((x, k) => x - scene.chunks[c].position[k]) as V3)) as [Box3dVec3, Box3dVec3]);
    this.weldsOf = scene.chunks.map(() => []);
    scene.welds.forEach((w, i) => { this.weldsOf[w.a].push(i); this.weldsOf[w.b].push(i); });
    this.reset();
  }

  /** Rebuild the world: the object at rest, lifted by ``lift`` metres, turned ``tilt`` rad about z. */
  reset({ lift = 0, tilt = 0 } = {}): void {
    this.world?.destroy();
    const { b3, scene, o } = this;
    this.world = new b3.World({ gravity: { x: 0, y: -9.81, z: 0 } });
    const ground = this.world.createBody({ type: "static", position: { x: 0, y: -0.5, z: 0 } });
    ground.createBox({ halfExtents: { x: 50, y: 0.5, z: 50 }, friction: o.friction, userData: GROUND_TAG });
    ground.setUserData(GROUND_TAG);
    // The tilt turns the object about the z axis through its footprint's centre (the origin).
    const c = Math.cos(tilt), s = Math.sin(tilt);
    const place = ([x, y, z]: V3): V3 => [c * x - s * y, s * x + c * y + lift, z];
    const rot = qmul({ x: 0, y: 0, z: Math.sin(tilt / 2), w: Math.cos(tilt / 2) }, this.restRotation);
    const shrink = 0.5 * scene.voxelSize * o.gap;
    this.bodies = scene.chunks.map((chunk, i) => {
      const body = this.world.createBody({ type: "dynamic", position: v3(place(chunk.position)), rotation: rot });
      for (const [cx, cy, cz, hx, hy, hz] of chunk.boxes)
        body.createBox({
          halfExtents: { x: hx - shrink, y: hy - shrink, z: hz - shrink }, offset: { x: cx, y: cy, z: cz },
          density: o.density, friction: o.friction, restitution: o.restitution,
          userData: i + 1, enableHitEvents: true, // tagged as its chunk, for hits
        });
      body.setUserData(i + 1); // shoot() reads the chunk off the body hit
      return body;
    });
    // Each weld's frame: the anchor in each body's frame (the bodies start with the same rotation).
    this.welds = scene.welds.map((w, i) => {
      const [anchorA, anchorB] = this.anchors[i];
      const joint = this.world.createWeldJoint(this.bodies[w.a], this.bodies[w.b], {
        localFrameA: { position: anchorA, rotation: ROT0 },
        localFrameB: { position: anchorB, rotation: ROT0 },
      });
      return { joint, area: w.area, alive: true };
    });
    this.broken = 0;
    this.time = 0;
    this.lastLoad = new Float32Array(this.welds.length);
    if (!this.base) this.limit = new Float32Array(this.welds.length).fill(o.glue);
    this.stats = { stepMs: 0, breakMs: 0 };
  }

  /** Per-weld strengths from the object's own loads, with unbreakable welds left ``settle`` s at
   *  rest (an object may first tip onto its stable side) then ``measure`` s more: each weld's base
   *  is the larger of the typical settled load (p90 over the welds) and its own peak over the run,
   *  and it breaks at ``setStrength(k)`` x that. So one glue holds most welds, the few that carry
   *  the object get their own margin, and the object stands for k > 1. A fixed glue does not
   *  carry over: loads concentrate (the sloth's settled p50/p90/max: 1.3/10/131 kPa, the blob's
   *  0.4/2.2/21), and the most loaded weld would set it for all. Returns the p90 load. */
  calibrate({ settle = 6, measure = 1 } = {}): number {
    this.o.glue = Number.POSITIVE_INFINITY;
    this.base = null;
    this.reset();
    const whole = new Float32Array(this.welds.length), settled = new Float32Array(this.welds.length);
    const steps = Math.round((settle + measure) / this.o.dt), from = Math.round(settle / this.o.dt);
    for (let i = 0; i < steps; i++) {
      this.step();
      this.lastLoad.forEach((l, j) => {
        whole[j] = Math.max(whole[j], l);
        if (i >= from) settled[j] = Math.max(settled[j], l);
      });
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

  /** Advance one fixed step, then break every weld whose load passes the glue. */
  step(): void {
    const t0 = performance.now();
    this.world.step(this.o.dt, this.o.substeps);
    const t1 = performance.now();
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
      for (const hit of this.world.getContactEvents().hit) {
        const excess = hit.approachSpeed - this.o.shatterSpeed;
        if (excess <= 0) continue;
        for (const tag of [hit.shapeUserDataA, hit.shapeUserDataB]) {
          if (tag === GROUND_TAG || !this.weldsOf[tag - 1].some((i) => this.welds[i].alive)) continue;
          for (const i of this.weldsOf[tag - 1]) this.breakWeld(i);
          const body = this.bodies[tag - 1], p = body.getPosition(), v = body.getLinearVelocity();
          const away: V3 = [p.x - hit.point.x, p.y - hit.point.y, p.z - hit.point.z];
          const k = (this.o.burst * excess) / (Math.hypot(...away) || 1);
          body.setLinearVelocity({ x: v.x + k * away[0], y: v.y + k * away[1], z: v.z + k * away[2] });
        }
      }
    this.time += this.o.dt;
    this.stats = { stepMs: t1 - t0, breakMs: performance.now() - t1 };
  }

  /** Each chunk's [x, y, z, qx, qy, qz, qw], packed. */
  transforms(out = new Float32Array(7 * this.bodies.length)): Float32Array {
    this.bodies.forEach((b, i) => {
      const p = b.getPosition(), q = b.getRotation();
      out.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w], 7 * i);
    });
    return out;
  }

  /** An explosion at ``point``: the welds within ``radius`` of it break, then every shape within
   *  ``radius`` is pushed away, about ``speed`` m/s to a voxel-thick piece (Box3D pushes per m² of
   *  shape, so the impulse per area is speed x density x voxel size: a thin shell's pieces fly as
   *  fast as a solid's, not faster). Breaking first is what makes it local: whole, the welds pass
   *  the push to the entire object. */
  explode(point: V3, { radius = 0.3, speed = 4 } = {}): void {
    this.breakNear(point, radius);
    this.world.explode({ position: v3(point), radius, falloff: 0.5 * radius,
      impulsePerArea: speed * this.o.density * this.scene.voxelSize });
  }

  /** A shot along ``dir`` (unit) from ``origin``: the chunk it hits first is knocked out (all its
   *  welds break, and those within ``radius`` of the hit) and kicked to about ``speed`` m/s
   *  there (impulse = speed x its mass). Returns the chunk, or -1 for a miss. */
  shoot(origin: V3, dir: V3, { speed = 6, radius = 0.1, range = 100 } = {}): number {
    const hit = this.world.castRayClosest(v3(origin), v3(dir.map((d) => d * range)));
    if (!hit.hit || hit.bodyUserData === GROUND_TAG) return -1;
    const chunk = hit.bodyUserData - 1, body = this.bodies[chunk];
    for (const i of this.weldsOf[chunk]) this.breakWeld(i);
    this.breakNear([hit.point.x, hit.point.y, hit.point.z], radius);
    body.applyLinearImpulse(v3(dir.map((d) => d * speed * body.getMass())), hit.point, true);
    return chunk;
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

  pieces(): number { return this.pieceSizes().length; }

  get aliveWelds(): number { return this.welds.length - this.broken; }

  /** Free the engine's world. */
  dispose(): void { this.world.destroy(); }
}
