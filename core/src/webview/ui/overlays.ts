// Transient overlays: the per-camera info popup (point-of-view mode) and the
// modal model chooser (multiple COLMAP models in one drop / picked folder).
import type { CameraView } from "../../shared/messages";
import { keyValue } from "./components";

/** Build the shared popup/modal header (title + ✕ close button); the caller wires
 *  the close click. Returns the header element and its close button. */
function popupHead(
  titleText: string,
  closeTitle: string
): { head: HTMLElement; close: HTMLButtonElement } {
  const head = document.createElement("div");
  head.className = "viewer-popup-head";
  const title = document.createElement("span");
  title.className = "viewer-popup-title";
  title.textContent = titleText;
  const close = document.createElement("button");
  close.className = "viewer-popup-close";
  close.title = closeTitle;
  close.textContent = "✕";
  head.append(title, close);
  return { head, close };
}

/** Bottom-left popup describing the selected camera and its image. */
export class InfoPopup {
  show(cam: CameraView, onClose: () => void): void {
    this.hide();
    const box = document.createElement("div");
    box.id = "popup";
    box.className = "viewer-popup";

    const { head, close } = popupHead(cam.name || `image ${cam.imageId}`, "Close");
    close.addEventListener("click", onClose);
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

/** One model offered in the chooser: a display label + optional source path.
 *  `ColmapModelRef` (what callers actually pass) is structurally compatible. */
interface ChooserModel {
  label: string;
  source?: string;
}

/**
 * Modal chooser for when a host finds several COLMAP models. Lists them with
 * checkboxes (all selected by default) and a Load button; the user can pick one,
 * some, or all. `onConfirm` gets the selected indices (always ≥1); `onCancel`
 * fires on ✕ / Esc / backdrop click (so the host can free unused blob: URLs).
 * Only one chooser exists at a time.
 */
export function showColmapChooser(
  models: ChooserModel[],
  onConfirm: (selected: number[]) => void,
  onCancel: () => void
): void {
  document.getElementById("viewer-modal")?.remove();
  const selected = models.map(() => true);

  const backdrop = document.createElement("div");
  backdrop.id = "viewer-modal";
  backdrop.className = "viewer-modal-backdrop";
  const box = document.createElement("div");
  box.className = "viewer-modal";

  const { head, close } = popupHead(`${models.length} reconstructions found`, "Cancel");

  const list = document.createElement("div");
  list.className = "viewer-modal-list";

  const footer = document.createElement("div");
  footer.className = "viewer-modal-foot";
  const load = document.createElement("button");
  load.className = "viewer-btn";
  const refreshLoad = () => {
    const n = selected.filter(Boolean).length;
    load.textContent = n === models.length ? "Load all" : `Load ${n}`;
    load.disabled = n === 0;
  };

  models.forEach((m, i) => {
    const row = document.createElement("label");
    row.className = "viewer-modal-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.addEventListener("change", () => {
      selected[i] = input.checked;
      refreshLoad();
    });
    const text = document.createElement("div");
    text.className = "viewer-modal-rowtext";
    const name = document.createElement("span");
    name.className = "viewer-modal-name";
    name.textContent = m.label;
    text.append(name);
    if (m.source && m.source !== m.label) {
      const sub = document.createElement("span");
      sub.className = "viewer-modal-sub";
      sub.textContent = m.source;
      text.append(sub);
    }
    row.append(input, text);
    list.append(row);
  });

  const dismiss = (run: (() => void) | null) => {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    run?.();
  };
  const confirm = () => {
    const indices = selected.flatMap((on, i) => (on ? [i] : []));
    if (indices.length > 0) {
      dismiss(() => onConfirm(indices));
    }
  };
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      dismiss(onCancel);
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    }
  }

  close.addEventListener("click", () => dismiss(onCancel));
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) {
      dismiss(onCancel);
    }
  });
  load.addEventListener("click", confirm);
  document.addEventListener("keydown", onKey);

  footer.append(load);
  box.append(head, list, footer);
  backdrop.append(box);
  document.body.append(backdrop);
  refreshLoad();
}
