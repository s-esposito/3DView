// A rigid asset on a physics body (roadmap R2): a node at the centre of mass of its collision shape
// (voxelize.ts), which the run moves, under the same turn a chunked object's group has (the World
// runs y-up; the scene's data frame is COLMAP's, y down — see chunkedObject.ts), so PhysicsRun moves
// either alike; the asset's content hangs on the node's holder, drawn exactly where it was.
import * as THREE from "three";
import type { PhysicsScene, V3 } from "./sim";
import { collisionShape, SHAPE_DEFAULTS, voxelizePoints, voxelizeTriangles, type Shape } from "./voxelize";

/** An item's geometry for its collision shape, in its layer's frame: points (splat centres, a
 *  cloud) or triangles (a mesh: xyz flat, three indices a triangle or none). */
export type CollisionGeometry = { points: Float32Array } | { positions: Float32Array; index: ArrayLike<number> | null };

/** The collision shape of an item's geometry, in the World's frame, at the defaults for a dynamic
 *  or a static body (SHAPE_DEFAULTS). */
export function geometryShape(geometry: CollisionGeometry, body: "dynamic" | "static",
  scale: THREE.Vector3 = new THREE.Vector3(1, 1, 1)): Shape {
  // The item's scale first (the layer's frame is unscaled), then into the World's frame.
  const pts = toWorldFrame("points" in geometry ? geometry.points : geometry.positions);
  for (let i = 0; i < pts.length; i += 3) {
    pts[i] *= scale.x;
    pts[i + 1] *= scale.y;
    pts[i + 2] *= scale.z;
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length; i += 3) for (let a = 0; a < 3; a++) {
    lo[a] = Math.min(lo[a], pts[i + a]);
    hi[a] = Math.max(hi[a], pts[i + a]);
  }
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const voxelize = "points" in geometry
    ? (v: number) => voxelizePoints(pts, v)
    : (v: number) => voxelizeTriangles(pts, geometry.index, v);
  return collisionShape(extent, voxelize, body === "static" ? SHAPE_DEFAULTS.static : SHAPE_DEFAULTS.dynamic);
}

/** From the scene's data frame (y down) into the World's (y up): the group's turn, (x, -y, -z). */
export function toWorldFrame(points: Float32Array): Float32Array {
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) out.set([points[i], -points[i + 1], -points[i + 2]], i);
  return out;
}

/**
 * Mount a body whose collision shape is ``shape`` (in the World's frame: geometry taken through
 * toWorldFrame) under ``parent``: a group turned 180° about x, a node in it at the shape's centre
 * of mass (what the run moves; ``parent``'s scale undone on it, as PhysicsRun.place does), and
 * under that node a ``holder`` that undoes both at rest, so whatever goes in the holder — the
 * asset's content, however often it is rebuilt — is drawn in ``parent``'s frame until the body
 * moves, then moves with it. The PhysicsScene is that one body:
 * one chunk, its boxes about the centre of mass, no welds.
 */
export function mountRigid(parent: THREE.Object3D, shape: Shape):
  { scene: PhysicsScene; node: THREE.Object3D; holder: THREE.Object3D } {
  const turn = new THREE.Group();
  turn.rotation.x = Math.PI;
  const node = new THREE.Group();
  node.position.set(...shape.centre);
  const holder = new THREE.Group();
  turn.updateMatrix();
  node.updateMatrix();
  node.matrix.premultiply(new THREE.Matrix4().makeScale(1 / parent.scale.x, 1 / parent.scale.y, 1 / parent.scale.z));
  node.matrixAutoUpdate = false;
  turn.matrix.clone().multiply(node.matrix).invert().decompose(holder.position, holder.quaternion, holder.scale);
  node.add(holder);
  turn.add(node);
  parent.add(turn);
  const [cx, cy, cz] = shape.centre;
  const scene: PhysicsScene = {
    voxelSize: shape.voxel,
    chunks: [{
      position: [cx, cy, cz] as V3,
      voxels: [],
      boxes: shape.boxes.map(([x, y, z, hx, hy, hz]) => [x - cx, y - cy, z - cz, hx, hy, hz]),
      color: [1, 1, 1],
    }],
    welds: [],
  };
  return { scene, node, holder };
}

/** Undo mountRigid, given its ``holder``: the turn group it added under ``parent`` goes (move
 *  the content out first). */
export function unmountRigid(holder: THREE.Object3D): void {
  holder.parent?.parent?.removeFromParent();
}
