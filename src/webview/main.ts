// Webview entry point. Wires the VS Code message channel, keyboard shortcuts,
// and status text to the Viewer and its UI. All real work lives in the modules.
import type { HostToWebview, WebviewToHost } from "../shared/messages";
import { Viewer, Layer } from "./viewer";
import { ControlPanel } from "./ui/controlPanel";
import { InfoPopup, BackButton } from "./ui/overlays";
import { ensureStyles } from "./ui/styles";

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const status = document.getElementById("status")!;

ensureStyles();
const viewer = new Viewer();
const panel = new ControlPanel(viewer);
const popup = new InfoPopup();
const backButton = new BackButton(() => viewer.exitPov());

// POV entry/exit drives the popup and back button.
viewer.onSelect = (cam) => {
  if (cam) {
    popup.show(cam, () => viewer.exitPov());
    backButton.show();
  } else {
    popup.hide();
    backButton.hide();
  }
};

// Content changes re-render the panel and refresh the status line.
viewer.onChange = () => {
  panel.render();
  updateStatus();
};
viewer.onError = (message) => showStatus(`Error: ${message}`);

// Keyboard shortcuts map to the same Viewer API the panel uses.
const LAYER_KEYS: Record<string, Layer> = {
  p: "points",
  f: "frustums",
  i: "images",
  b: "box",
  g: "grid",
  a: "axes",
  m: "mesh",
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
  const layer = LAYER_KEYS[key];
  if (layer) {
    viewer.toggle(layer);
    panel.render();
  }
});

function showStatus(message: string) {
  status.style.display = "flex";
  status.textContent = message;
}

/** Reflect what's loaded; hide the overlay once there's something to see. */
function updateStatus() {
  const { points, cameras, meshName } = viewer.getSummary();
  if (points === 0 && cameras === 0 && !meshName) {
    showStatus("Nothing to display.");
  } else if (points === 0 && cameras > 0 && !meshName) {
    showStatus(`No points — showing ${cameras} cameras only.`);
  } else {
    status.style.display = "none";
  }
}

window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case "ready":
      showStatus("Open a reconstruction or mesh to begin.");
      break;
    case "loading":
      showStatus(msg.message);
      break;
    case "model":
      viewer.setModel(msg.data); // fires onChange → panel + status
      break;
    case "mesh":
      showStatus(`Loading ${msg.mesh.name}…`);
      viewer.setMesh(msg.mesh.uri, msg.mesh.name); // async; fires onChange/onError
      break;
    case "error":
      showStatus(`Error: ${msg.message}`);
      break;
  }
});

// Tell the host we are alive and ready to receive a model.
vscode.postMessage({ type: "ready" });
