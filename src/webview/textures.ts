import * as THREE from "three";

/**
 * Concurrency-limited, downscaling image loader for frustum textures.
 *
 * Each image is loaded via an `<img>` element (the webview CSP allows `img-src`
 * but not `connect-src`, so `fetch` is out), then decoded and downscaled to at
 * most `maxSize` px in a single `createImageBitmap` step — so the full-resolution
 * bitmap is never uploaded to the GPU. Only `maxConcurrent` loads run at once,
 * keeping the UI responsive for large image sets.
 */
export class ThumbnailLoader {
  private readonly queue: Array<() => Promise<void>> = [];
  private active = 0;

  constructor(
    private readonly maxConcurrent = 6,
    private readonly maxSize = 512
  ) {}

  /** Drop not-yet-started loads. In-flight loads still complete. */
  clear(): void {
    this.queue.length = 0;
  }

  /** Queue a load; `onReady` receives a small, GPU-ready texture. */
  load(uri: string, onReady: (texture: THREE.Texture) => void): void {
    this.queue.push(() => this.run(uri, onReady));
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

  private run(uri: string, onReady: (texture: THREE.Texture) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const scale = Math.min(
          1,
          this.maxSize / Math.max(img.naturalWidth, img.naturalHeight)
        );
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        createImageBitmap(img, {
          resizeWidth: w,
          resizeHeight: h,
          resizeQuality: "medium",
        })
          .then((bitmap) => {
            const texture = new THREE.Texture(bitmap);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.minFilter = THREE.LinearFilter;
            texture.generateMipmaps = false;
            texture.needsUpdate = true;
            onReady(texture);
          })
          .catch(() => {
            /* ignore decode failures */
          })
          .finally(resolve);
      };
      img.onerror = () => resolve();
      img.src = uri;
    });
  }
}
