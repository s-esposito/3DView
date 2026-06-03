// Parsers for COLMAP `images.{bin,txt}`. Pure functions, no I/O.
// Per-image 2D observations are skipped — they aren't needed to view poses.
import { BinaryReader } from "./reader";
import { Image } from "./types";

// Bytes per 2D observation in the binary format: float64 x, float64 y, uint64 id.
const POINT2D_BYTES = 8 + 8 + 8;

/**
 * Parse `images.bin`:
 *   uint64 num, then per image:
 *   uint32 image_id, float64x4 qvec (qw,qx,qy,qz), float64x3 tvec,
 *   uint32 camera_id, NUL-terminated name, uint64 num_points2D,
 *   then num_points2D x (float64 x, float64 y, uint64 point3D_id).
 */
export function parseImagesBin(data: Uint8Array): Image[] {
  const r = new BinaryReader(data);
  const images: Image[] = [];
  const num = r.readUint64();
  for (let i = 0; i < num; i++) {
    const imageId = r.readUint32();
    const qvec: [number, number, number, number] = [
      r.readFloat64(),
      r.readFloat64(),
      r.readFloat64(),
      r.readFloat64(),
    ];
    const tvec: [number, number, number] = [
      r.readFloat64(),
      r.readFloat64(),
      r.readFloat64(),
    ];
    const cameraId = r.readUint32();
    const name = r.readCString();
    const numPoints2D = r.readUint64();
    r.skip(numPoints2D * POINT2D_BYTES);
    images.push({ imageId, qvec, tvec, cameraId, name });
  }
  return images;
}

/**
 * Parse `images.txt`. Two lines per image (ignoring `#` comments):
 *   line 1: IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME
 *   line 2: 2D observations (ignored)
 */
export function parseImagesText(text: string): Image[] {
  const images: Image[] = [];
  const lines = text.split("\n");
  let expectPose = true; // the next data line is a pose line, not an observations line
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    if (!expectPose) {
      // This is the (ignored) 2D-observations line; the next data line is a pose.
      expectPose = true;
      continue;
    }
    const tok = trimmed.split(/\s+/);
    const imageId = Number(tok[0]);
    const qvec: [number, number, number, number] = [
      Number(tok[1]),
      Number(tok[2]),
      Number(tok[3]),
      Number(tok[4]),
    ];
    const tvec: [number, number, number] = [
      Number(tok[5]),
      Number(tok[6]),
      Number(tok[7]),
    ];
    const cameraId = Number(tok[8]);
    // NAME may contain spaces; rejoin everything after the camera id.
    const name = tok.slice(9).join(" ");
    images.push({ imageId, qvec, tvec, cameraId, name });
    expectPose = false;
  }
  return images;
}
