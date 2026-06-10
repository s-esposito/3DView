// Pure classification of a flat list of file paths into COLMAP model(s) — the
// shared core of the browser intake paths (drag-and-drop in `webview/dropZone.ts`
// and the demo's folder picker in `demo/src/host.ts`), which both receive a bag
// of files (with relative paths) and must locate every complete model trio. Kept
// here, pure and DOM-free, so the algorithm lives once and is unit-testable; each
// host maps the returned paths back to its own File objects / blob: URLs.

/** The three files (by relative path) that make up one located COLMAP model. */
export interface ColmapModelPaths {
  /** Directory the model lives in (relative to the drop/pick root); "" if at top level. */
  dir: string;
  format: "bin" | "txt";
  /** Full relative paths, as given in the input, so the caller can map back to its files. */
  cameras: string;
  images: string;
  points3d: string;
}

const MODEL_TRIOS = {
  bin: ["cameras.bin", "images.bin", "points3D.bin"],
  txt: ["cameras.txt", "images.txt", "points3D.txt"],
} as const;

/** Image extensions whose files are mapped to frustum textures by basename. */
const IMAGE_EXTENSIONS = /\.(jpe?g|png|bmp|gif|webp|tiff?)$/i;

/** True if a path names an image file (by extension) the viewer can texture a frustum with. */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.test(path);
}

/**
 * Group `paths` by directory and return every dir that holds a complete model
 * (a .bin or .txt trio), at any depth, sorted by path. A `sparse/` with several
 * models (`0/`, `1/`, …) yields one entry per dir for the user to choose from.
 * `.bin` is preferred over `.txt` when a dir has both. Files are keyed by basename
 * within their own dir, so same-named files in sibling dirs don't collide.
 */
export function groupColmapModels(paths: string[]): ColmapModelPaths[] {
  const byDir = new Map<string, Map<string, string>>();
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash) : "";
    const base = slash >= 0 ? path.slice(slash + 1) : path;
    let group = byDir.get(dir);
    if (!group) byDir.set(dir, (group = new Map()));
    group.set(base, path);
  }
  const models: ColmapModelPaths[] = [];
  for (const [dir, group] of byDir) {
    for (const format of ["bin", "txt"] as const) {
      const [cameras, images, points3d] = MODEL_TRIOS[format];
      if (group.has(cameras) && group.has(images) && group.has(points3d)) {
        models.push({
          dir,
          format,
          cameras: group.get(cameras)!,
          images: group.get(images)!,
          points3d: group.get(points3d)!,
        });
        break; // one model per dir (.bin preferred over .txt)
      }
    }
  }
  return models.sort((a, b) => a.dir.localeCompare(b.dir));
}
