// Webview entry point. Wires the host message channel, keyboard shortcuts, and
// status text to the Viewer and its UI. All real work lives in the modules. This
// bundle is host-agnostic: it talks to the embedding IDE only through the
// `window.__viewerHost` bridge (see shared/hostBridge), never a host-specific API.
import type { HostToWebview, ColmapModelRef } from "../shared/messages";
import { getHostBridge } from "../shared/hostBridge";
import { Viewer, GlobalToggle } from "./viewer";
import { ControlPanel } from "./ui/controlPanel";
import { InfoPopup, showColmapChooser } from "./ui/overlays";
import { ensureStyles } from "./ui/styles";
import { loadColmapFromUrls } from "./colmapLoader";
import { installDropZone } from "./dropZone";

// The host (VS Code or PyCharm/JCEF) installs `window.__viewerHost` before this
// bundle runs; we never reference a host-specific API directly.
const host = getHostBridge();
const status = document.getElementById("status")!;

ensureStyles();
const viewer = new Viewer();
const panel = new ControlPanel(viewer);
const popup = new InfoPopup();

// Selecting a camera shows its info popup; closing it (✕) clears the highlight
// but keeps the view; deselecting (Esc / exit POV) hides it.
viewer.onSelect = (cam) => {
  if (cam) {
    popup.show(cam, () => viewer.clearSelection());
  } else {
    popup.hide();
  }
};

// Content changes re-render the panel and refresh the status line.
viewer.onChange = () => {
  panel.render();
  updateStatus();
};
viewer.onError = (message) => showStatus(`Error: ${message}`);
// Async loaders report their phase (download %, "Decoding…") here.
viewer.onProgress = (message) => showStatus(message, true);

// The Scene "+" asks the host to open a picker; removal tells the host to forget.
viewer.onRequestAdd = (kind) => host.postMessage({ type: "requestAdd", kind });
viewer.onRemoveItem = (id) => host.postMessage({ type: "removed", id });
// `suggestedName` is serialized before the multi-MB `png` so the PyCharm host's
// regex parser matches the short field without scanning the whole base64 payload.
viewer.onSaveImage = (png, suggestedName) => host.postMessage({ type: "saveImage", suggestedName, png });

// Show the empty scene and its controls immediately, before any content loads.
panel.render();
showStatus("Open a reconstruction or asset — drag & drop, or use + in the Scene panel.");

// Keyboard shortcuts map to the same Viewer API the panel uses.
const TOGGLE_KEYS: Record<string, GlobalToggle> = {
  p: "points",
  f: "frustums",
  i: "images",
  b: "box",
  g: "grid",
  a: "axes",
  w: "wireframe",
  s: "shaded",
};
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) {
    return; // don't hijack keys while a control is focused
  }
  const key = e.key.toLowerCase();
  if (key === "r") {
    viewer.resetView();
    return;
  }
  if (key === "escape") {
    viewer.exitPov();
    return;
  }
  if (key === "u") {
    viewer.toggleOrientation();
    panel.render();
    return;
  }
  const toggle = TOGGLE_KEYS[key];
  if (toggle) {
    viewer.toggleGlobal(toggle);
    panel.render();
  }
});

/** Show the centered overlay. When `busy`, prefix an animated spinner (the work
 *  runs off the main thread — e.g. a fetch or the Spark decode worker — so it
 *  keeps spinning, signalling progress even without a percentage). */
function showStatus(message: string, busy = false) {
  status.style.display = "flex";
  status.replaceChildren();
  const wrap = document.createElement("span");
  wrap.className = "viewer-status";
  if (busy) {
    const spinner = document.createElement("span");
    spinner.className = "viewer-spinner";
    wrap.append(spinner);
  }
  const text = document.createElement("span");
  text.textContent = message;
  wrap.append(text);
  status.append(wrap);
}

/** Hide the overlay once the scene has content; otherwise show a prompt. */
function updateStatus() {
  if (viewer.getState().items.length > 0) {
    status.style.display = "none";
  } else {
    showStatus("Open a reconstruction or asset — drag & drop, or use + in the Scene panel.");
  }
}

// Handle a content message, whether it arrives from the embedding host (the
// message channel below) or from an in-webview drag-and-drop (dropZone produces
// the same host-shaped messages from dropped files). Both converge here.
function handleHostMessage(msg: HostToWebview) {
  switch (msg.type) {
    case "loading":
      showStatus(msg.message, true);
      break;
    case "addReconstruction":
      viewer.addReconstruction(msg.id, msg.label, msg.data, msg.source); // fires onChange
      break;
    case "addAsset":
      showStatus(`Loading ${msg.label}…`, true);
      viewer.addAsset(msg.id, msg.label, msg.asset.uri, msg.asset.name); // async; onChange/onError
      break;
    case "loadColmap":
      // The host hands us URLs (not parsed data); fetch + parse in-browser, then
      // converge on the same addReconstruction path the inline `data` case uses.
      loadColmapModel(msg);
      break;
    case "chooseColmap":
      // Several models found (e.g. sparse/0, sparse/1); let the user pick which to
      // load. Unselected models' trio URLs are freed so dropped/demo blobs aren't
      // left pinned. (imageUrls are shared across models + needed lazily — see below.)
      showColmapChooser(
        msg.models, // ColmapModelRef has the label/source ChooserModel reads
        (selected) =>
          msg.models.forEach((m, i) =>
            selected.includes(i) ? loadColmapModel(m) : revokeColmapTrio(m.urls)
          ),
        () => msg.models.forEach((m) => revokeColmapTrio(m.urls))
      );
      break;
    case "error":
      showStatus(`Error: ${msg.message}`);
      break;
  }
}

/** Fetch + parse a URL-served COLMAP model and add it to the scene. */
function loadColmapModel(m: ColmapModelRef) {
  showStatus(`Loading ${m.label}…`, true);
  loadColmapFromUrls(m.urls, m.format, m.imageBaseUrl, m.imageUrls)
    .then((data) => viewer.addReconstruction(m.id, m.label, data, m.source))
    .catch((err) => showStatus(`Error: ${err instanceof Error ? err.message : String(err)}`))
    // The trio is fetched exactly once above; free the URLs so a dropped / demo
    // blob: model (a large points3D especially) isn't pinned for the session. A
    // no-op on non-blob host URLs (VS Code / PyCharm). The per-image `imageUrls`
    // are deliberately NOT revoked — frustum textures load lazily and re-fetch
    // after eviction (and the map is shared across a chooser's models).
    .finally(() => revokeColmapTrio(m.urls));
}

function revokeColmapTrio(urls: { cameras: string; images: string; points3d: string }) {
  URL.revokeObjectURL(urls.cameras);
  URL.revokeObjectURL(urls.images);
  URL.revokeObjectURL(urls.points3d);
}

window.addEventListener("message", (event: MessageEvent<HostToWebview>) =>
  handleHostMessage(event.data)
);

// Drag-and-drop is host-agnostic: dropped files are read into blob: URLs and fed
// through the same handler as host messages (see dropZone.ts).
installDropZone(handleHostMessage);

// Tell the host we are alive and ready to receive content.
host.postMessage({ type: "ready" });
