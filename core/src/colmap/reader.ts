// A tiny little-endian cursor over a byte buffer, for the COLMAP *.bin readers.
// COLMAP binary files are little-endian (see colmap.github.io/format.html).

export class BinaryReader {
  private readonly view: DataView;
  /** Current read position, in bytes from the start of the buffer. */
  public offset = 0;

  constructor(data: Uint8Array) {
    // Respect the view's window into its backing ArrayBuffer.
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  /** True once every byte has been consumed. */
  public eof(): boolean {
    return this.offset >= this.view.byteLength;
  }

  public readUint8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  public readInt32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  public readUint32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  /**
   * Read a uint64 and return it as a JS number. COLMAP counts and ids fit
   * comfortably under 2^53, so the precision loss vs BigInt is irrelevant here.
   */
  public readUint64(): number {
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return Number(v);
  }

  public readFloat64(): number {
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  /** Read a NUL-terminated ASCII string (used for image names). */
  public readCString(): string {
    let s = "";
    for (;;) {
      const c = this.readUint8();
      if (c === 0) {
        break;
      }
      s += String.fromCharCode(c);
    }
    return s;
  }

  /** Skip `n` bytes (e.g. observation tracks we don't need). */
  public skip(n: number): void {
    this.offset += n;
  }
}
