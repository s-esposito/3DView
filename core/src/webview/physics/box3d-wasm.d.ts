// Types for the parts of box3d-wasm physics uses (the package ships none for its embind API).

/** box3d's WebAssembly bytes, embedded by core/esbuild.js's box3d-wasm-binary plugin. */
declare module "box3d-wasm-binary" {
  const bytes: Uint8Array<ArrayBuffer>;
  export default bytes;
}

declare module "box3d-wasm/standard" {
  interface Box3dOptions {
    instantiateWasm?: (
      imports: WebAssembly.Imports,
      done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) => object;
  }
  const Box3D: (options?: Box3dOptions) => Promise<Box3dModule>;
  export default Box3D;
}

interface Box3dVec3 { x: number; y: number; z: number }
interface Box3dQuat { x: number; y: number; z: number; w: number }

interface Box3dBody {
  createBox(options: { halfExtents: Box3dVec3; offset?: Box3dVec3; density?: number; friction?: number;
    restitution?: number; userData?: number; enableHitEvents?: boolean }): unknown;
  getPosition(): Box3dVec3;
  getRotation(): Box3dQuat;
  getLinearVelocity(): Box3dVec3;
}

interface Box3dWorld {
  createBody(options: { type: "static" | "dynamic"; position?: Box3dVec3; rotation?: Box3dQuat }): Box3dBody;
  step(dt: number, substeps: number): void;
  destroy(): void;
}

interface Box3dModule {
  World: new (options: { gravity: Box3dVec3 }) => Box3dWorld;
}
