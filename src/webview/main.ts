// Webview entry point. Wires the VS Code message channel, keyboard shortcuts,
// and status text to the Viewer and its UI. All real work lives in the modules.
import type { HostToWebview, WebviewToHost } from "../shared/messages";
import { Viewer, GlobalToggle } from "./viewer";
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

// The Scene "+" asks the host to open a picker; removal tells the host to forget.
viewer.onRequestAdd = (kind) => vscode.postMessage({ type: "requestAdd", kind });
viewer.onRemoveItem = (id) => vscode.postMessage({ type: "removed", id });

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
      viewer.addReconstruction(msg.id, msg.label, msg.data); // fires onChange
      break;
    case "addMesh":
      showStatus(`Loading ${msg.label}…`);
      viewer.addMesh(msg.id, msg.label, msg.mesh.uri, msg.mesh.name); // async; onChange/onError
      break;
    case "error":
      showStatus(`Error: ${msg.message}`);
      break;
  }
});

// Tell the host we are alive and ready to receive content.
vscode.postMessage({ type: "ready" });
