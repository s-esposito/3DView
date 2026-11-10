import { unzip } from "fflate";
import { basename, extOf, isImagePath } from "@3dview/core";

// Reading a zipped COLMAP project as if its folder had been picked: the "archive"
// add kind, for browsers that can't pick folders (phones). Unpacked on the device,
// in fflate's workers; nothing is uploaded.

/** A picked file and its path relative to what was picked (a folder, or the zip). */
export interface PickedFile {
  path: string;
  file: File;
}

/** The COLMAP model files, by name — the rest of a project is images. */
const COLMAP_FILES = new Set(
  ["cameras", "images", "points3D"].flatMap((n) => [`${n}.bin`, `${n}.txt`])
);

const IMAGE_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/** Whether a zip entry is part of a COLMAP project: a model file or an image.
 *  Folders, macOS resource forks and hidden files are skipped, and so is everything
 *  else, so an archive with extras doesn't cost their decompression. */
function wanted(path: string): boolean {
  if (path.endsWith("/") || path.split("/").some((seg) => seg.startsWith(".") || seg === "__MACOSX")) {
    return false;
  }
  return COLMAP_FILES.has(basename(path)) || isImagePath(path);
}

/** Unpack the COLMAP model files and images in `zip`, each a File named by its own
 *  basename and keyed by its path inside the archive. */
export async function readZip(zip: File): Promise<PickedFile[]> {
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(bytes, { filter: (entry) => wanted(entry.name) }, (err, out) =>
      err ? reject(err) : resolve(out)
    )
  ).catch((err: unknown) => {
    throw new Error(`Can't read ${zip.name} as a zip archive (${err instanceof Error ? err.message : err}).`);
  });
  return Object.entries(entries).map(([path, data]) => ({
    path,
    // fflate allocates plain ArrayBuffers; TS only types the view loosely. Typed
    // images, as a picked file would be: decoders shouldn't have to sniff.
    file: new File([data as Uint8Array<ArrayBuffer>], basename(path), {
      type: IMAGE_TYPES[extOf(path)] ?? "",
    }),
  }));
}
