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
