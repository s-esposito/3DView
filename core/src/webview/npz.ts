// Minimal NumPy `.npy` / `.npz` reader for the browser — enough to load arrays a
// Python pipeline saved with `np.save` / `np.savez[_compressed]`, with no
// dependency: an `.npz` is a ZIP of `.npy` members, and the only compression
// NumPy uses is raw deflate, which the platform inflates via DecompressionStream.
//
// Deliberately strict: it reads C-order, little-endian arrays and throws a clear
// error on anything else (Fortran order, big-endian, ZIP64 payloads) rather than
// quietly returning wrong numbers.

/** One decoded array: a typed view plus the shape/dtype it was stored with. */
export interface NpyArray {
  /** NumPy dtype without byte order — "f4", "f8", "i4", "i8", "u1", "b1". */
  dtype: string;
  shape: number[];
  /** Row-major (C-order) elements. `b1` (bool) arrives as 0/1 bytes. */
  data: Float32Array | Float64Array | Int32Array | BigInt64Array | Uint8Array;
}

/** Total element count of a shape (an empty shape is a 0-d array: one element). */
function numel(shape: number[]): number {
  return shape.reduce((n, d) => n * d, 1);
}

/** Read every member of an `.npz` archive, keyed by member name without ".npy". */
export async function readNpz(bytes: Uint8Array): Promise<Map<string, NpyArray>> {
  const out = new Map<string, NpyArray>();
  for (const entry of listZipEntries(bytes)) {
    if (!entry.name.endsWith(".npy")) {
      continue; // np.savez writes nothing else, but be tolerant of extras
    }
    const raw = await inflateEntry(bytes, entry);
    out.set(entry.name.slice(0, -".npy".length), readNpy(raw));
  }
  return out;
}

/** Parse a single `.npy` buffer (the NumPy 1.0/2.0/3.0 header formats). */
export function readNpy(bytes: Uint8Array): NpyArray {
  const MAGIC = "\x93NUMPY";
  if (bytes.length < 10 || latin1(bytes.subarray(0, 6)) !== MAGIC) {
    throw new Error("Not a .npy file (bad magic)");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[6];
  // v1 stores the header length as uint16; v2+ widened it to uint32.
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = latin1(bytes.subarray(headerStart, headerStart + headerLength));

  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1];
  const shapeText = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  if (!descr || shapeText === undefined) {
    throw new Error(`Unreadable .npy header: ${header.trim()}`);
  }
  if (/'fortran_order'\s*:\s*True/.test(header)) {
    throw new Error("Fortran-order .npy arrays are not supported (re-save C-order)");
  }
  if (descr.startsWith(">")) {
    throw new Error(`Big-endian .npy arrays are not supported (dtype ${descr})`);
  }
  const shape = shapeText
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number);
  if (shape.some((d) => !Number.isInteger(d) || d < 0)) {
    throw new Error(`Unreadable .npy shape: (${shapeText})`);
  }

  const dtype = descr.replace(/^[<>|=]/, "");
  // Copy the payload so the typed view is aligned to its element size: the member
  // starts at an arbitrary offset inside the archive, and e.g. Float32Array cannot
  // be constructed on an offset that isn't a multiple of 4.
  const payload = bytes.slice(headerStart + headerLength);
  return { dtype, shape, data: typedView(dtype, payload, numel(shape)) };
}

function typedView(dtype: string, payload: Uint8Array, count: number): NpyArray["data"] {
  const need = (bytesPerElement: number) => {
    if (payload.byteLength < count * bytesPerElement) {
      throw new Error(`Truncated .npy data (${dtype}: want ${count * bytesPerElement} bytes)`);
    }
  };
  switch (dtype) {
    case "f4":
      need(4);
      return new Float32Array(payload.buffer, 0, count);
    case "f8":
      need(8);
      return new Float64Array(payload.buffer, 0, count);
    case "i4":
      need(4);
      return new Int32Array(payload.buffer, 0, count);
    case "i8":
      need(8);
      return new BigInt64Array(payload.buffer, 0, count);
    case "b1":
    case "u1":
      need(1);
      return new Uint8Array(payload.buffer, 0, count);
    default:
      throw new Error(`Unsupported .npy dtype "${dtype}"`);
  }
}

// --- ZIP (the subset np.savez writes) ---------------------------------------
interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate; anything else is rejected when read. */
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;

/**
 * Entries from the central directory — the authoritative copy. Sizes in the *local*
 * headers may be zeroed or ZIP64-escaped (NumPy writes members with
 * `force_zip64=True`), so only the name/extra lengths are read from there.
 */
function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === ZIP64_SENTINEL) {
    throw new Error("ZIP64 .npz archives are not supported (file too large)");
  }

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new Error("Corrupt .npz: bad central directory entry");
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    if (compressedSize === ZIP64_SENTINEL || localHeaderOffset === ZIP64_SENTINEL) {
      throw new Error("ZIP64 .npz archives are not supported (member too large)");
    }
    entries.push({
      name: latin1(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      method: view.getUint16(offset + 10, true),
      compressedSize,
      localHeaderOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The end-of-central-directory record, scanning back over its optional comment. */
function findEocd(view: DataView): number {
  const limit = Math.max(0, view.byteLength - 0xffff - 22);
  for (let i = view.byteLength - 22; i >= limit; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      return i;
    }
  }
  throw new Error("Not a .npz file (no ZIP end-of-central-directory record)");
}

async function inflateEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local = entry.localHeaderOffset;
  if (view.getUint32(local, true) !== LOCAL_SIGNATURE) {
    throw new Error(`Corrupt .npz: bad local header for "${entry.name}"`);
  }
  const start =
    local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const payload = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) {
    return payload;
  }
  if (entry.method !== 8) {
    throw new Error(`Unsupported .npz compression (method ${entry.method}) for "${entry.name}"`);
  }
  return inflateRaw(payload);
}

/** np.savez_compressed writes raw deflate; the platform has an inflater built in. */
async function inflateRaw(payload: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  // Not awaited: the writer only drains as the reader below pulls.
  void writer.write(payload.slice()).then(() => writer.close());

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** ZIP names and .npy headers are ASCII/latin-1, never UTF-16. */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += String.fromCharCode(byte);
  }
  return out;
}
