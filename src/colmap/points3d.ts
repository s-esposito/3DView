// Parsers for COLMAP `points3D.{bin,txt}`. Pure functions, no I/O.
// Output is flat typed arrays (render-ready); per-point track info is skipped.
import { BinaryReader } from "./reader";
import { PointCloud } from "./types";

// Bytes per track element in the binary format: uint32 image_id, uint32 point2D_idx.
const TRACK_ELEM_BYTES = 4 + 4;

/**
 * Parse `points3D.bin`:
 *   uint64 num, then per point:
 *   uint64 point3D_id, float64x3 xyz, uint8x3 rgb, float64 error,
 *   uint64 track_len, then track_len x (uint32 image_id, uint32 point2D_idx).
 */
export function parsePoints3DBin(data: Uint8Array): PointCloud {
  const r = new BinaryReader(data);
  const count = r.readUint64();
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    r.readUint64(); // point3D_id (unused)
    positions[i * 3] = r.readFloat64();
    positions[i * 3 + 1] = r.readFloat64();
    positions[i * 3 + 2] = r.readFloat64();
    colors[i * 3] = r.readUint8();
    colors[i * 3 + 1] = r.readUint8();
    colors[i * 3 + 2] = r.readUint8();
    r.readFloat64(); // reprojection error (unused)
    const trackLen = r.readUint64();
    r.skip(trackLen * TRACK_ELEM_BYTES);
  }
  return { count, positions, colors };
}

/**
 * Parse `points3D.txt`. Lines (ignoring `#` comments):
 *   POINT3D_ID X Y Z R G B ERROR TRACK[]...
 */
export function parsePoints3DText(text: string): PointCloud {
  const xs: number[] = [];
  const rgb: number[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const tok = trimmed.split(/\s+/);
    xs.push(Number(tok[1]), Number(tok[2]), Number(tok[3]));
    rgb.push(Number(tok[4]), Number(tok[5]), Number(tok[6]));
  }
  return {
    count: xs.length / 3,
    positions: Float32Array.from(xs),
    colors: Uint8Array.from(rgb),
  };
}
