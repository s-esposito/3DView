// R2: rigid assets and static bodies — an asset's content mounted on one body with its collision
// shape (rigidObject.ts + voxelize.ts), moved by a PhysicsRun like a chunked object's chunks.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { loadBox3d } from "../src/webview/physics/box3d";
import { DEFAULTS, Sim, World, type PhysicsScene } from "../src/webview/physics/sim";
import { PhysicsRun, PhysicsRuntime } from "../src/webview/physics/run";
import { collisionShape, voxelizeTriangles, type Shape } from "../src/webview/physics/voxelize";
import { geometryShape, mountRigid, toWorldFrame } from "../src/webview/physics/rigidObject";
import { presetScene } from "../src/webview/physics/voxelScene";

let b3: Box3dModule;
before(async () => {
  b3 = await loadBox3d();
});

/** A box mesh's collision shape, ``w`` x ``h`` x ``w`` metres, its geometry as ``mesh`` places it
 *  in the data frame (y down), taken into the World's frame. */
function shapeOf(mesh: THREE.Mesh): Shape {
  mesh.updateMatrix();
  const g = mesh.geometry.clone().applyMatrix4(mesh.matrix);
  const positions = toWorldFrame(g.getAttribute("position").array as Float32Array);
  return collisionShape(1, (v) => voxelizeTriangles(positions, g.index!.array, v), { across: 16 });
}
const boxMesh = (w: number, h: number, at: [number, number, number]) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w));
  m.position.set(...at);
  return m;
};
const worldPos = (o: THREE.Object3D) => { o.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); };

test("whatever goes in the holder is drawn where it was", () => {
  const parent = new THREE.Group();
  const mesh = boxMesh(0.4, 0.4, [0.3, -1, 0.2]);
  parent.add(mesh);
  const before = worldPos(mesh);
  mountRigid(parent, shapeOf(mesh)).holder.add(mesh);
  assert.ok(worldPos(mesh).distanceTo(before) < 1e-6, `${worldPos(mesh).toArray()} vs ${before.toArray()}`);
});

test("a rigid cube, 1 m up, falls and rests on the ground, no calibration", async () => {
  const parent = new THREE.Group();
  const mesh = boxMesh(0.4, 0.4, [0, -1, 0]); // data frame: y down, so 1 m up
  parent.add(mesh);
  const { scene, node, holder } = mountRigid(parent, shapeOf(mesh));
  holder.add(mesh);
  const runtime = new PhysicsRuntime();
  const run = new PhysicsRun(scene, [node]);
  runtime.add(run);
  await runtime.play();
  assert.ok(!run.calibrating);
  let now = 0;
  for (let f = 0; f < 60 * 10 && runtime.tick((now += 1000 / 60)); f++);
  // Its centre rests at half its height above the ground (World frame, y up), drawn there too.
  assert.ok(Math.abs(node.position.y - 0.2) < 0.04, `centre at ${node.position.y}`);
  assert.ok(Math.abs(worldPos(mesh).y + 0.2) < 0.04, "and drawn there (data frame: -y)");
  runtime.dispose();
});

test("a static box stops a falling blob, which would otherwise reach the ground", () => {
  const blobScene = presetScene({ shape: "blob", radius: 10, chunks: 100, height: 1 });
  const probe = new Sim(b3, blobScene);
  probe.calibrate();
  const fall = (withTable: boolean): number => {
    const world = new World(b3);
    if (withTable) {
      const table = mountRigid(new THREE.Group(), shapeOf(boxMesh(3, 0.5, [0, -0.25, 0]))).scene;
      new Sim(b3, table, { body: "static" }, world);
    }
    const blob = new Sim(b3, blobScene, {}, world);
    blob.base = probe.base;
    blob.setStrength(DEFAULTS.strength);
    blob.reset({ lift: 1 });
    for (let i = 0; i < 180; i++) world.step();
    const x = blob.transforms();
    let low = Infinity;
    for (let k = 1; k < x.length; k += 7) low = Math.min(low, x[k]);
    world.dispose();
    return low;
  };
  const onTable = fall(true), onGround = fall(false);
  assert.ok(onTable > onGround + 0.4, `lowest chunk ${onTable.toFixed(2)} m on the table, ${onGround.toFixed(2)} m without`);
  probe.dispose();
});

test("a shot moves a rigid body and nothing breaks; a static one does not move", () => {
  const scene: PhysicsScene = mountRigid(new THREE.Group(), shapeOf(boxMesh(0.4, 0.4, [0, -0.2, 0]))).scene;
  for (const body of ["dynamic", "static"] as const) {
    const world = new World(b3);
    const sim = new Sim(b3, scene, { body }, world);
    const x0 = sim.transforms()[0];
    assert.equal(world.shoot([-3, 0.2, 0], [1, 0, 0], { speed: 3 })?.sim, sim, "hit");
    for (let i = 0; i < 30; i++) world.step();
    const moved = sim.transforms()[0] - x0;
    if (body === "dynamic") assert.ok(moved > 0.3, `pushed ${moved}`);
    else assert.equal(moved, 0);
    assert.equal(sim.pieceSizes().length, 1);
    world.dispose();
  }
});

test("a scaled item's body is its scaled shape, moves in metres and is drawn where it is", async () => {
  // A 0.4 m cube scaled 2x (0.8 m), its item 1 m up: it falls and rests with its centre at 0.4 m.
  const item = new THREE.Group();
  item.scale.setScalar(2);
  item.position.y = -1; // data frame: y down, so 1 m up
  const mesh = boxMesh(0.4, 0.4, [0, 0, 0]);
  item.add(mesh);
  item.updateMatrix();
  mesh.updateMatrix();
  const g = mesh.geometry.clone().applyMatrix4(mesh.matrix);
  const shape = geometryShape({ positions: g.getAttribute("position").array as Float32Array, index: g.index!.array }, "dynamic", item.scale);
  const { scene, node, holder } = mountRigid(item, shape);
  holder.add(mesh);
  const runtime = new PhysicsRuntime();
  const run = new PhysicsRun(scene, [node]);
  runtime.add(run);
  await runtime.play();
  let now = 0;
  for (let f = 0; f < 60 * 10 && runtime.tick((now += 1000 / 60)); f++);
  const centre = worldPos(mesh); // the item's frame is the world here: y down
  assert.ok(Math.abs(centre.y + 0.4) < 0.05, `drawn centre at ${centre.y} (expected -0.4)`);
  mesh.geometry.computeBoundingBox();
  const size = mesh.geometry.boundingBox!.getSize(new THREE.Vector3()).multiply(new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld));
  assert.ok(Math.abs(size.x - 0.8) < 1e-6, `drawn 0.8 m wide, ${size.x}`);
  runtime.dispose();
});

test("a shot at a scaled item goes where the ray points (the World is in metres)", async () => {
  // A 0.4 m cube scaled 2x, 2 m to the side, resting on the ground: a shot level with its centre
  // (0.4 m up) hits it; one at 0.9 m up, above it (it is 0.8 m tall), misses.
  const item = new THREE.Group();
  item.scale.setScalar(2);
  item.position.set(2, -0.4, 0); // data frame: y down
  const mesh = boxMesh(0.4, 0.4, [0, 0, 0]);
  item.add(mesh);
  item.updateMatrixWorld(true);
  const g = mesh.geometry.clone();
  const shape = geometryShape({ positions: g.getAttribute("position").array as Float32Array, index: g.index!.array }, "dynamic", item.scale);
  const { scene, node, holder } = mountRigid(item, shape);
  holder.add(mesh);
  const runtime = new PhysicsRuntime();
  const run = new PhysicsRun(scene, [node]);
  runtime.add(run);
  await runtime.prepared();
  item.updateMatrixWorld(true);
  const from = (y: number) => new THREE.Ray(new THREE.Vector3(-3, -y, 0), new THREE.Vector3(1, 0, 0)); // y down
  assert.equal(await run.shoot(from(0.9)), false, "above it: a miss");
  assert.equal(await run.shoot(from(0.4)), true, "level with its centre: a hit");
  runtime.dispose();
});
