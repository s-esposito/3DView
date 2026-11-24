// Physics (exp/physics, P1): the chunked-object simulation on the synthetic blob, the checks
// GenerativeReconstruction's prototype ran (physics_demo/app/check_sim.mjs) — the engine is the
// vendored box3d-wasm, loaded as the viewer loads it. Each test reports what it measured.
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { loadBox3d, physicsSmokeTest } from "../src/webview/physics/box3d";
import { DEFAULTS, Sim, type PhysicsScene } from "../src/webview/physics/sim";
import { presetScene } from "../src/webview/physics/voxelScene";

const scene: PhysicsScene = presetScene({ shape: "blob", radius: 10, chunks: 100, height: 1 });
let b3: Box3dModule;
/** Per-weld base loads from one calibration, shared by every test. */
let base: Float32Array;

before(async () => {
  b3 = await loadBox3d();
  const sim = new Sim(b3, scene);
  sim.calibrate();
  base = sim.base!;
  sim.dispose();
});

/** A sim of the blob, its welds calibrated, at ``strength`` x their base load. */
function calibrated(strength = DEFAULTS.strength, options: Partial<typeof DEFAULTS> = {}): Sim {
  const sim = new Sim(b3, scene, options);
  sim.base = base;
  sim.setStrength(strength);
  return sim;
}
const run = (sim: Sim, seconds: number): void => {
  for (let i = 0, n = Math.round(seconds / sim.o.dt); i < n; i++) sim.step();
};
const largest = (sim: Sim): number => sim.pieceSizes()[0] / scene.chunks.length;
/** Highest chunk centre, metres. */
const top = (sim: Sim): number => {
  const t = sim.transforms();
  let m = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < t.length; i += 7) m = Math.max(m, t[i]);
  return m;
};

test("the engine loads and a dropped box comes to rest on the ground", async () => {
  const r = await physicsSmokeTest();
  assert.ok(r.resting, JSON.stringify(r));
});

test("each chunk's boxes cover exactly its voxels", () => {
  for (const c of scene.chunks) {
    const volume = c.boxes.reduce((v, [, , , hx, hy, hz]) => v + 8 * hx * hy * hz, 0) / scene.voxelSize ** 3;
    assert.ok(Math.abs(volume - c.voxels.length) < 1e-6, `volume ${volume} for ${c.voxels.length} voxels`);
    for (const p of c.voxels)
      assert.ok(c.boxes.some(([x, y, z, hx, hy, hz]) =>
        Math.abs(p[0] - x) < hx && Math.abs(p[1] - y) < hy && Math.abs(p[2] - z) < hz));
  }
});

test("with unbreakable welds it keeps its shape once settled", (t) => {
  const sim = new Sim(b3, scene, { glue: Number.POSITIVE_INFINITY });
  run(sim, 6);
  const a = sim.transforms().slice();
  run(sim, 4);
  const b = sim.transforms();
  // Largest chunk displacement once the mean translation is removed, and that translation.
  const n = a.length / 7, ca = [0, 0, 0], cb = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { ca[k] += a[7 * i + k] / n; cb[k] += b[7 * i + k] / n; }
  let deform = 0;
  for (let i = 0; i < n; i++)
    deform = Math.max(deform, Math.hypot(...[0, 1, 2].map((k) => b[7 * i + k] - cb[k] - (a[7 * i + k] - ca[k]))));
  const move = Math.hypot(...[0, 1, 2].map((k) => cb[k] - ca[k]));
  t.diagnostic(`deformation ${(deform * 1000).toFixed(2)} mm, rigid motion ${(move * 1000).toFixed(2)} mm over 4 s`);
  assert.ok(deform < 0.001 && move < 0.005);
  sim.dispose();
});

test("calibrated, nothing breaks at rest", (t) => {
  const sim = calibrated();
  run(sim, 10);
  t.diagnostic(`${sim.broken} of ${sim.welds.length} welds broke in 10 s`);
  assert.equal(sim.broken, 0);
  sim.dispose();
});

test("set down from 2 cm it stays whole; dropped from 3 m it breaks", (t) => {
  const brokenAfter = (lift: number, tilt: number): number => {
    const sim = calibrated();
    sim.reset({ lift, tilt });
    run(sim, 4);
    const f = sim.broken / sim.welds.length;
    sim.dispose();
    return f;
  };
  const soft = brokenAfter(0.02, 0), hard = brokenAfter(3, 0.3);
  t.diagnostic(`welds broken: set down ${(100 * soft).toFixed(1)}%, 3 m drop ${(100 * hard).toFixed(1)}%`);
  assert.ok(soft < 0.05);
  assert.ok(hard > 0.2);
});

test("crumble: when the glue vanishes every chunk comes loose", (t) => {
  const sim = calibrated();
  const before = top(sim);
  sim.unglue();
  run(sim, 4);
  t.diagnostic(`${sim.pieces()} pieces; top ${before.toFixed(2)} -> ${top(sim).toFixed(2)} m (a solid blob stands)`);
  assert.equal(sim.pieces(), scene.chunks.length);
  sim.dispose();
});

test("brittle: set down it stays one piece; from 3 m it breaks apart, more than without", (t) => {
  const dropped = (lift: number, tilt: number, shatterSpeed: number): Sim => {
    const sim = calibrated(DEFAULTS.strength, { shatterSpeed });
    sim.reset({ lift, tilt });
    run(sim, 4);
    return sim;
  };
  const gentle = dropped(0.02, 0, 3), brittle = dropped(3, 0.3, 3), plain = dropped(3, 0.3, Number.POSITIVE_INFINITY);
  t.diagnostic(`set down ${gentle.pieces()} piece(s); 3 m brittle ${brittle.pieces()} pieces, largest ` +
    `${(100 * largest(brittle)).toFixed(0)}% (without: ${plain.pieces()}, ${(100 * largest(plain)).toFixed(0)}%)`);
  assert.equal(gentle.pieces(), 1);
  assert.ok(largest(brittle) <= 0.6 && brittle.pieces() > plain.pieces());
  for (const s of [gentle, brittle, plain]) s.dispose();
});

test("the same drop twice breaks the same welds", (t) => {
  const drop = (): Sim => {
    const sim = calibrated(DEFAULTS.strength, { shatterSpeed: 3 });
    sim.reset({ lift: 3, tilt: 0.3 });
    run(sim, 4);
    return sim;
  };
  const a = drop(), b = drop();
  t.diagnostic(`${a.broken} and ${b.broken} welds broke`);
  assert.deepEqual(a.welds.map((w) => w.alive), b.welds.map((w) => w.alive));
  a.dispose(); b.dispose();
});

test("a blast inside throws the chunks outward", (t) => {
  const centre = [0, 1, 2].map((k) => scene.chunks.reduce((s, c) => s + c.position[k], 0) / scene.chunks.length);
  const sim = calibrated();
  run(sim, 0.5);
  sim.explode(centre as [number, number, number], { radius: 0.5 });
  run(sim, 0.1);
  const outward = sim.bodies.filter((body, i) => {
    const v = body.getLinearVelocity(), d = scene.chunks[i].position.map((x, k) => x - centre[k]);
    return v.x * d[0] + v.y * d[1] + v.z * d[2] > 0;
  }).length / sim.bodies.length;
  t.diagnostic(`${(100 * outward).toFixed(0)}% of chunks move away from it`);
  assert.ok(outward > 0.8);
  sim.dispose();
});

test("a blast beside breaks the object there, not across it", (t) => {
  const sim = calibrated();
  run(sim, 0.5);
  const at: [number, number, number] = [Math.max(...scene.chunks.map((c) => c.position[0])) + 0.1, 0.3, 0];
  const radius = 0.3;
  sim.explode(at, { radius });
  run(sim, 0.1); // the blast's own damage, before anything lands
  const far = scene.welds.map((w, i) => [w, sim.welds[i]] as const)
    .filter(([w]) => Math.hypot(...w.anchor.map((x, k) => x - at[k])) > 2 * radius);
  const farBroken = far.filter(([, s]) => !s.alive).length / far.length;
  t.diagnostic(`${sim.broken} welds broke; ${(100 * farBroken).toFixed(1)}% of the ${far.length} beyond ${2 * radius} m`);
  assert.ok(farBroken < 0.1);
  sim.dispose();
});

test("sleep() stops every body mid-fall, and a shot wakes it again", () => {
  const sim = calibrated();
  sim.reset({ lift: 1 });
  run(sim, 0.2);
  assert.ok(sim.awake > 0);
  sim.sleep();
  assert.equal(sim.awake, 0);
  const before = sim.transforms();
  run(sim, 0.5);
  assert.deepEqual(sim.transforms(), before, "asleep, nothing moves");
  const y = sim.transforms().filter((_, k) => k % 7 === 1).reduce((a, b) => a + b, 0) / scene.chunks.length;
  assert.ok(sim.shoot([0, y, -5], [0, 0, 1]) >= 0, "the shot hits");
  run(sim, 0.1);
  assert.ok(sim.awake > 0, "and wakes it");
  sim.dispose();
});
