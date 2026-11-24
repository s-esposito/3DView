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
  createBox(options: {
    halfExtents: Box3dVec3; offset?: Box3dVec3; density?: number; friction?: number;
    restitution?: number; userData?: number; enableHitEvents?: boolean;
  }): unknown;
  setUserData(tag: number): void;
  getPosition(): Box3dVec3;
  getRotation(): Box3dQuat;
  getLinearVelocity(): Box3dVec3;
  setLinearVelocity(v: Box3dVec3): void;
  applyLinearImpulse(impulse: Box3dVec3, point: Box3dVec3, wake: boolean): void;
  getWorldPoint(local: Box3dVec3): Box3dVec3;
  getMass(): number;
  setAwake(awake: boolean): void;
  isAwake(): boolean;
  /** Remove the body, its shapes and joints from the world. */
  destroy(): void;
}

interface Box3dJoint {
  /** Last step's constraint force / torque (N, N·m). */
  getConstraintForce(): Box3dVec3;
  getConstraintTorque(): Box3dVec3;
  /** Remove the joint from the world (not just the JS handle, as delete() would). */
  destroy(wakeAttached: boolean): void;
}

interface Box3dWorld {
  createBody(options: { type: "static" | "dynamic"; position?: Box3dVec3; rotation?: Box3dQuat }): Box3dBody;
  createWeldJoint(a: Box3dBody, b: Box3dBody, options: {
    localFrameA: { position: Box3dVec3; rotation: Box3dQuat };
    localFrameB: { position: Box3dVec3; rotation: Box3dQuat };
  }): Box3dJoint;
  step(dt: number, substeps: number): void;
  setGravity(gravity: Box3dVec3): void;
  getAwakeBodyCount(): number;
  /** Hits (shapes created with enableHitEvents) in the last step, with their approach speed. */
  getContactEvents(): {
    hit: { shapeUserDataA: number; shapeUserDataB: number; point: Box3dVec3; approachSpeed: number }[];
  };
  castRayClosest(origin: Box3dVec3, translation: Box3dVec3): { hit: boolean; point: Box3dVec3; bodyUserData: number };
  explode(options: { position: Box3dVec3; radius: number; falloff: number; impulsePerArea: number }): void;
  destroy(): void;
}

interface Box3dModule {
  World: new (options: { gravity: Box3dVec3 }) => Box3dWorld;
}
