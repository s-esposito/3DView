// Locate and load COLMAP models from disk. Uses Node `fs`/`path` only — no
// `vscode` — so it stays out of the editor layer and is straightforward to test.
import * as fs from "node:fs";
import * as path from "node:path";

import { parseCamerasBin, parseCamerasText } from "./cameras";
import { parseImagesBin, parseImagesText } from "./images";
import { parsePoints3DBin, parsePoints3DText } from "./points3d";
import { ColmapModel, ColmapFormat } from "./types";

// The three files that make up a model, sans extension.
const STEMS = ["cameras", "images", "points3D"] as const;

/**
 * Determine whether `dir` holds a `.bin` or `.txt` model, or neither.
 * Prefers `.bin` when both are present (binary is the COLMAP default).
 */
export function detectFormat(dir: string): ColmapFormat | null {
  const has = (ext: string) =>
    STEMS.every((s) => fs.existsSync(path.join(dir, `${s}.${ext}`)));
  if (has("bin")) {
    return "bin";
  }
  if (has("txt")) {
    return "txt";
  }
  return null;
}

/**
 * Find candidate model directories at or beneath `root`. A "model directory"
 * is one that directly contains a full `cameras`/`images`/`points3D` triple.
 *
 * Looks at, in order: `root`, `root/sparse`, and one level of subdirectories
 * under each (so `sparse/0`, `sparse/1`, ... and `root/<sub>` are all found).
 * This covers the common COLMAP layouts without an unbounded recursive walk.
 */
export function findModelDirs(root: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const consider = (dir: string) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved) || !isDir(resolved)) {
      return;
    }
    seen.add(resolved);
    if (detectFormat(resolved) !== null) {
      found.push(resolved);
    }
  };

  const considerChildren = (dir: string) => {
    if (!isDir(dir)) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        consider(path.join(dir, entry.name));
      }
    }
  };

  consider(root);
  considerChildren(root);
  const sparse = path.join(root, "sparse");
  consider(sparse);
  considerChildren(sparse);

  return found;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locate the source-images directory for a model. COLMAP's usual layout puts
 * images at `<project>/images/` with the model under `<project>/sparse/0/`, so
 * we probe the picked root and a couple of levels up from the model dir.
 * Returns the first existing candidate, or undefined.
 */
export function findImagesDir(root: string, modelDir: string): string | undefined {
  const candidates = [
    path.join(root, "images"),
    path.join(modelDir, "images"),
    path.join(modelDir, "..", "images"),
    path.join(modelDir, "..", "..", "images"),
  ];
  for (const dir of candidates) {
    if (isDir(dir)) {
      return path.resolve(dir);
    }
  }
  return undefined;
}

/**
 * Load and parse the COLMAP model in `dir`. `dir` must directly contain the
 * model triple (use {@link findModelDirs} to locate one first).
 */
export function loadModel(dir: string): ColmapModel {
  const format = detectFormat(dir);
  if (format === null) {
    throw new Error(
      `No COLMAP model in ${dir}: expected cameras/images/points3D (.bin or .txt).`
    );
  }
  const file = (stem: string) => path.join(dir, `${stem}.${format}`);

  if (format === "bin") {
    return {
      cameras: parseCamerasBin(read(file("cameras"))),
      images: parseImagesBin(read(file("images"))),
      points: parsePoints3DBin(read(file("points3D"))),
    };
  }
  return {
    cameras: parseCamerasText(readText(file("cameras"))),
    images: parseImagesText(readText(file("images"))),
    points: parsePoints3DText(readText(file("points3D"))),
  };
}

function read(p: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(p));
}

function readText(p: string): string {
  return fs.readFileSync(p, "utf8");
}
