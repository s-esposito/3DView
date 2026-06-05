// Webview entry point. Wires the host message channel, keyboard shortcuts, and
// status text to the Viewer and its UI. All real work lives in the modules. This
// bundle is host-agnostic: it talks to the embedding IDE only through the
// `window.__viewerHost` bridge (see shared/hostBridge), never a host-specific API.
import type { HostToWebview } from "../shared/messages";
import { getHostBridge } from "../shared/hostBridge";
import { Viewer, GlobalToggle } from "./viewer";
import { ControlPanel } from "./ui/controlPanel";
import { InfoPopup } from "./ui/overlays";
import { ensureStyles } from "./ui/styles";
import { loadColmapFromUrls } from "./colmapLoader";

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

// The Scene "+" asks the host to open a picker; removal tells the host to forget.
viewer.onRequestAdd = (kind) => host.postMessage({ type: "requestAdd", kind });
viewer.onRemoveItem = (id) => host.postMessage({ type: "removed", id });

// Show the empty scene and its controls immediately, before any content loads.
panel.render();
showStatus("Open a reconstruction or mesh — or use + in the Scene panel.");

// Keyboard shortcuts map to the same Viewer API the panel uses.
const TOGGLE_KEYS: Record<string, GlobalToggle> = {
  p: "points",
  f: "frustums",
  i: "images",
  b: "box",
  g: "grid",
  a: "axes",
  w: "wireframe",
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

function showStatus(message: string) {
  status.style.display = "flex";
  status.textContent = message;
}

/** Hide the overlay once the scene has content; otherwise show a prompt. */
function updateStatus() {
  if (viewer.getState().items.length > 0) {
    status.style.display = "none";
  } else {
    showStatus("Open a reconstruction or mesh — or use + in the Scene panel.");
  }
}

window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case "loading":
      showStatus(msg.message);
      break;
    case "addReconstruction":
      viewer.addReconstruction(msg.id, msg.label, msg.data, msg.source); // fires onChange
      break;
    case "addMesh":
      showStatus(`Loading ${msg.label}…`);
      viewer.addMesh(msg.id, msg.label, msg.mesh.uri, msg.mesh.name); // async; onChange/onError
      break;
    case "loadColmap":
      // The host hands us URLs (not parsed data); fetch + parse in-browser, then
      // converge on the same addReconstruction path the inline `data` case uses.
      showStatus(`Loading ${msg.label}…`);
      loadColmapFromUrls(msg.urls, msg.format, msg.imageBaseUrl, msg.imageUrls)
        .then((data) => viewer.addReconstruction(msg.id, msg.label, data, msg.source))
        .catch((err) =>
          showStatus(`Error: ${err instanceof Error ? err.message : String(err)}`)
        );
      break;
    case "error":
      showStatus(`Error: ${msg.message}`);
      break;
  }
});

// Tell the host we are alive and ready to receive content.
host.postMessage({ type: "ready" });
