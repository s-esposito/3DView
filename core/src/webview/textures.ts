import * as THREE from "three";

/** Source-image pixel dimensions (from the COLMAP camera), to size the thumbnail. */
export interface ImageDims {
  width: number;
  height: number;
}

/**
 * Concurrency-limited, decode-at-scale image loader for frustum textures.
 *
 * Fast path: `fetch` the file as a blob and `createImageBitmap(blob, {resize…})`,
 * which lets the browser decode straight to the target size (e.g. JPEG DCT
 * scaling) instead of decoding full-resolution then shrinking — a large CPU and
 * peak-memory saving for big source photos. Fallback path (if `fetch` is blocked
 * by CSP, etc.): an `<img>` element + `createImageBitmap`. The flip is baked into
 * the bitmap (`imageOrientation: "flipY"`) since ImageBitmap ignores `flipY`.
 */
export class ThumbnailLoader {
  private readonly queue: Array<() => Promise<void>> = [];
  private active = 0;

  constructor(
    private readonly maxConcurrent = 8,
    private readonly maxSize = 256
  ) {}

  /** Drop not-yet-started loads. In-flight loads still complete. */
  clear(): void {
    this.queue.length = 0;
  }

  /** Queue a load; `onReady` receives a small, GPU-ready texture. */
  load(uri: string, dims: ImageDims, onReady: (texture: THREE.Texture) => void): void {
    this.queue.push(() => this.run(uri, dims, onReady));
    this.pump();
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.active++;
      task().finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async run(
    uri: string,
    dims: ImageDims,
    onReady: (texture: THREE.Texture) => void
  ): Promise<void> {
    try {
      const bitmap = await this.decode(uri, this.resizeOption(dims));
      onReady(toTexture(bitmap));
    } catch {
      /* ignore failures — the frustum simply stays a wireframe */
    }
  }

  /**
   * Cap the longer edge at `maxSize`, preserving aspect. Passing a single
   * dimension makes createImageBitmap compute the other from the source aspect.
   */
  private resizeOption(dims: ImageDims): ImageBitmapOptions {
    const base: ImageBitmapOptions = { resizeQuality: "low", imageOrientation: "flipY" };
    if (dims.width > 0 && dims.height > 0) {
      return dims.width >= dims.height
        ? { ...base, resizeWidth: Math.min(this.maxSize, dims.width) }
        : { ...base, resizeHeight: Math.min(this.maxSize, dims.height) };
    }
    return { ...base, resizeWidth: this.maxSize };
  }

  private async decode(uri: string, opts: ImageBitmapOptions): Promise<ImageBitmap> {
    try {
      const res = await fetch(uri);
      return await createImageBitmap(await res.blob(), opts);
    } catch {
      // Fallback: load via <img> (img-src is always allowed), then resize-decode.
      return await new Promise<ImageBitmap>((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => createImageBitmap(img, opts).then(resolve, reject);
        img.onerror = () => reject(new Error(`failed to load ${uri}`));
        img.src = uri;
      });
    }
  }
}

function toTexture(bitmap: ImageBitmap): THREE.Texture {
  const texture = new THREE.Texture(bitmap);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false; // flip already baked into the bitmap
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
