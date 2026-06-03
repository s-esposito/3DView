// Parsers for COLMAP `cameras.{bin,txt}`. Pure functions, no I/O.
import { BinaryReader } from "./reader";
import {
  Camera,
  PARAMS_PER_MODEL,
  MODEL_NAME_TO_ID,
  intrinsicsFromParams,
} from "./types";

function makeCamera(
  cameraId: number,
  model: number,
  width: number,
  height: number,
  params: number[]
): Camera {
  return { cameraId, model, width, height, params, ...intrinsicsFromParams(model, params) };
}

/**
 * Parse `cameras.bin`:
 *   uint64 num, then per camera:
 *   uint32 camera_id, int32 model_id, uint64 width, uint64 height,
 *   float64[num_params] params.
 */
export function parseCamerasBin(data: Uint8Array): Map<number, Camera> {
  const r = new BinaryReader(data);
  const cameras = new Map<number, Camera>();
  const num = r.readUint64();
  for (let i = 0; i < num; i++) {
    const cameraId = r.readUint32();
    const model = r.readInt32();
    const width = r.readUint64();
    const height = r.readUint64();
    const numParams = PARAMS_PER_MODEL[model];
    if (numParams === undefined) {
      throw new Error(`Unknown COLMAP camera model id: ${model}`);
    }
    const params: number[] = new Array(numParams);
    for (let p = 0; p < numParams; p++) {
      params[p] = r.readFloat64();
    }
    cameras.set(cameraId, makeCamera(cameraId, model, width, height, params));
  }
  return cameras;
}

/**
 * Parse `cameras.txt`. Lines (ignoring `#` comments):
 *   CAMERA_ID MODEL WIDTH HEIGHT PARAMS[]
 * where MODEL is the model *name* (e.g. PINHOLE), not the numeric id.
 */
export function parseCamerasText(text: string): Map<number, Camera> {
  const cameras = new Map<number, Camera>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const tok = trimmed.split(/\s+/);
    const cameraId = Number(tok[0]);
    const modelName = tok[1];
    const model = MODEL_NAME_TO_ID[modelName];
    if (model === undefined) {
      throw new Error(`Unknown COLMAP camera model name: ${modelName}`);
    }
    const width = Number(tok[2]);
    const height = Number(tok[3]);
    const params = tok.slice(4).map(Number);
    cameras.set(cameraId, makeCamera(cameraId, model, width, height, params));
  }
  return cameras;
}
