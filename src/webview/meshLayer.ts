// The mesh layer: holds at most one loaded mesh (glTF/GLB/OBJ/PLY) under a
// container group, mirroring CameraLayer so the Viewer treats all scene sources
// uniformly. Asset siblings (.bin, .mtl, textures) resolve relative to the
// file's webview URI.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import type { Bounds } from "../shared/messages";
import { buildBox, disposeObject } from "./builders";
import type { SceneLayer } from "./sceneLayer";

/** A single loaded mesh (glTF/GLB/OBJ/PLY) as a scene layer. */
export class MeshLayer implements SceneLayer {
  readonly kind = "mesh" as const;
  readonly object = new THREE.Group();
  visible = true;

  private current?: THREE.Object3D;
  private currentBounds?: Bounds;
  private box?: THREE.Box3Helper;

  constructor(
    readonly id: string,
    readonly label: string
  ) {}

  bounds(): Bounds | undefined {
    return this.currentBounds;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.object.visible = visible;
  }

  setBoxVisible(visible: boolean): void {
    if (this.box) {
      this.box.visible = visible;
    }
  }

  /** Load the mesh file and add it (plus a bounding box) under this layer's group. */
  async load(uri: string, name: string): Promise<void> {
    const { object, bounds } = await loadMesh(uri, name);
    this.current = object;
    this.currentBounds = bounds;
    this.object.add(object);
    this.box = buildBox(bounds);
    this.object.add(this.box);
  }

  dispose(): void {
    disposeObject(this.current);
    disposeObject(this.object); // also disposes the box (a child of object)
    this.current = undefined;
    this.currentBounds = undefined;
    this.box = undefined;
  }
}

interface LoadedMesh {
  object: THREE.Object3D;
  bounds: Bounds;
}

const gltfLoader = new GLTFLoader();
const objLoader = new OBJLoader();
const plyLoader = new PLYLoader();

function loadMesh(uri: string, name: string): Promise<LoadedMesh> {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "glb":
    case "gltf":
      return load(gltfLoader, uri).then((gltf) => finalize(gltf.scene));
    case "obj":
      return load(objLoader, uri).then((group) => finalize(group));
    case "ply":
      return load(plyLoader, uri).then((geometry) => finalize(plyToObject(geometry)));
    default:
      return Promise.reject(new Error(`Unsupported mesh format: .${ext ?? "?"}`));
  }
}

/** Promisified loader.load with normalized errors. */
function load<T>(
  loader: {
    load: (
      url: string,
      onLoad: (result: T) => void,
      onProgress?: (e: ProgressEvent) => void,
      onError?: (err: unknown) => void
    ) => void;
  },
  uri: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    loader.load(uri, resolve, undefined, (err) =>
      reject(err instanceof Error ? err : new Error(String(err)))
    );
  });
}

/** PLY can be a mesh (has faces) or a bare point cloud; build the right object. */
function plyToObject(geometry: THREE.BufferGeometry): THREE.Object3D {
  const hasColor = geometry.getAttribute("color") != null;
  const isMesh = geometry.getIndex() != null && geometry.getIndex()!.count > 0;
  if (isMesh) {
    if (!geometry.getAttribute("normal")) {
      geometry.computeVertexNormals();
    }
    return new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        vertexColors: hasColor,
        color: hasColor ? 0xffffff : 0xcccccc,
        metalness: 0,
        roughness: 1,
      })
    );
  }
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      vertexColors: hasColor,
      color: hasColor ? 0xffffff : 0xcccccc,
      size: 1.5,
      sizeAttenuation: false,
    })
  );
}

function finalize(object: THREE.Object3D): LoadedMesh {
  const box = new THREE.Box3().setFromObject(object);
  const bounds: Bounds = box.isEmpty()
    ? { min: [-1, -1, -1], max: [1, 1, 1] }
    : {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
      };
  return { object, bounds };
}
