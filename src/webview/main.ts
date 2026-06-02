import type { HostToWebview, WebviewToHost } from "../messages";

// The VS Code webview API handle (injected at runtime).
declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const app = document.getElementById("app")!;

window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case "ready":
      // Host acknowledged us; the 3D scene will be initialized here later.
      app.textContent = "3DViewer ready — load a reconstruction to begin.";
      break;
  }
});

// Tell the host we are alive.
vscode.postMessage({ type: "ready" });
