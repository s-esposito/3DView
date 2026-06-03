// Transient overlay: the per-camera info popup shown while in point-of-view mode.
import type { CameraView } from "../../shared/messages";
import { keyValue } from "./components";

/** Bottom-left popup describing the selected camera and its image. */
export class InfoPopup {
  show(cam: CameraView, onClose: () => void): void {
    this.hide();
    const box = document.createElement("div");
    box.id = "popup";
    box.className = "viewer-popup";

    const head = document.createElement("div");
    head.className = "viewer-popup-head";
    const title = document.createElement("span");
    title.className = "viewer-popup-title";
    title.textContent = cam.name || `image ${cam.imageId}`;
    const close = document.createElement("button");
    close.className = "viewer-popup-close";
    close.title = "Close";
    close.textContent = "✕";
    close.addEventListener("click", onClose);
    head.append(title, close);
    box.appendChild(head);

    if (cam.imageUri) {
      const img = document.createElement("img");
      img.src = cam.imageUri;
      box.appendChild(img);
    }

    const body = document.createElement("div");
    body.className = "viewer-popup-body";
    const f = (n: number) => n.toFixed(2);
    if (!cam.imageUri) {
      body.appendChild(keyValue("image", "not found on disk"));
    }
    body.append(
      keyValue("image id", String(cam.imageId)),
      keyValue("camera id", `${cam.cameraId} (${cam.model})`),
      keyValue("resolution", `${cam.width} × ${cam.height}`),
      keyValue("focal fx, fy", `${f(cam.fx)}, ${f(cam.fy)}`),
      keyValue("principal cx, cy", `${f(cam.cx)}, ${f(cam.cy)}`),
      keyValue(
        "center xyz",
        `${cam.center[0].toFixed(3)}, ${cam.center[1].toFixed(3)}, ${cam.center[2].toFixed(3)}`
      )
    );
    box.appendChild(body);
    document.body.appendChild(box);
  }

  hide(): void {
    document.getElementById("popup")?.remove();
  }
}
