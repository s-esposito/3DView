// Axis-aligned bounds over an interleaved xyz position array. Pure (no `vscode`,
// no Node) so it is shared by the VS Code host (`host/modelData.ts`) and the
// in-browser COLMAP loader (`webview/colmapLoader.ts`).
import type { Bounds } from "../shared/messages";

/** Axis-aligned bounds over an interleaved xyz position array. */
export function computeBounds(positions: Float32Array): Bounds {
  // Scalar locals (not tuple indexing) so the single O(n) scan JITs tightly.
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  // Empty cloud: fall back to a unit box so downstream math stays finite.
  if (!Number.isFinite(minX)) {
    return { min: [-1, -1, -1], max: [1, 1, 1] };
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}
