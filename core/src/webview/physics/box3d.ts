// box3d-wasm (Erin Catto's Box3D, MIT): the rigid-body engine behind physics. Its
// WebAssembly rides in the bundle (a host may not serve a file beside webview.js) and is
// compiled only on the first loadBox3d() call, so a session that never uses physics pays
// for the bytes in the bundle and nothing else.
import Box3D from "box3d-wasm/standard";
import wasmBytes from "box3d-wasm-binary";

let module: Promise<Box3dModule> | null = null;

/** The engine, instantiated once from the bundled bytes. */
export function loadBox3d(): Promise<Box3dModule> {
  module ??= new Promise<Box3dModule>((resolve, reject) => {
    Box3D({
      // Hand box3d our bytes: its own path looks for box3d.wasm beside the script's URL,
      // which an IIFE bundle does not have.
      instantiateWasm(imports, done) {
        WebAssembly.instantiate(wasmBytes, imports).then((r) => done(r.instance, r.module), reject);
        return {};
      },
    }).then(resolve, reject);
  });
  return module;
}

/** P0 check that the engine runs in this host: a 10 cm box dropped from 1 m onto the
 *  ground, one simulated second at 60 steps. Resting means its centre is at its half
 *  height (5 cm) and it no longer moves. */
export async function physicsSmokeTest(): Promise<{ y: number; speed: number; resting: boolean }> {
  const b3 = await loadBox3d();
  const world = new b3.World({ gravity: { x: 0, y: -9.81, z: 0 } });
  try {
    const ground = world.createBody({ type: "static", position: { x: 0, y: -0.5, z: 0 } });
    ground.createBox({ halfExtents: { x: 5, y: 0.5, z: 5 } });
    const box = world.createBody({ type: "dynamic", position: { x: 0, y: 1, z: 0 } });
    box.createBox({ halfExtents: { x: 0.05, y: 0.05, z: 0.05 }, density: 500 });
    for (let i = 0; i < 60; i++) world.step(1 / 60, 4);
    const y = box.getPosition().y;
    const v = box.getLinearVelocity();
    const speed = Math.hypot(v.x, v.y, v.z);
    return { y, speed, resting: Math.abs(y - 0.05) < 0.005 && speed < 0.01 };
  } finally {
    world.destroy();
  }
}
