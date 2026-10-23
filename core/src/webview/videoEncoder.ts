// Encode frames drawn into a canvas as a video file, in the webview, with
// WebCodecs (via Mediabunny, which also muxes the container). Frame timing comes
// from the frame index, not the wall clock, so a slow render still plays smoothly.
// The only module that touches Mediabunny.
import {
  BufferTarget,
  CanvasSource,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
} from "mediabunny";

export interface EncodedVideo {
  /** The whole file as a data URL, the form hosts receive files in. */
  dataUrl: string;
  /** File extension without the dot: "mp4" or "webm". */
  extension: string;
}

/**
 * Draw `frameCount` frames into `canvas` (each via `drawFrame(i)`, which must
 * leave frame i in the canvas when its promise resolves) and encode them at `fps`.
 * Prefers H.264 in MP4 and falls back to VP9/VP8 in WebM: which encoders exist
 * depends on the host's Chromium build (VS Code's Electron, for one, may lack
 * H.264). Returns null when `cancelled()` turns true between frames.
 */
export async function encodeVideo(
  canvas: HTMLCanvasElement,
  frameCount: number,
  fps: number,
  drawFrame: (index: number) => Promise<void>,
  cancelled: () => boolean
): Promise<EncodedVideo | null> {
  if (typeof VideoEncoder === "undefined") {
    throw new Error("this host can't encode video (no WebCodecs support)");
  }
  const { width, height } = canvas;
  const codec = await getFirstEncodableVideoCodec(["avc", "vp9", "vp8"], {
    width,
    height,
    frameRate: fps,
  });
  if (!codec) {
    throw new Error(`this host has no video encoder for ${width}×${height}`);
  }
  const mp4 = codec === "avc";
  const format = mp4 ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat();
  const target = new BufferTarget();
  const output = new Output({ format, target });
  const source = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  try {
    for (let i = 0; i < frameCount; i++) {
      if (cancelled()) {
        await output.cancel();
        return null;
      }
      await drawFrame(i);
      await source.add(i / fps, 1 / fps);
    }
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  }
  return {
    dataUrl: await toDataUrl(target.buffer!, format.mimeType),
    extension: mp4 ? "mp4" : "webm",
  };
}

function toDataUrl(buffer: ArrayBuffer, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([buffer], { type: mimeType }));
  });
}
