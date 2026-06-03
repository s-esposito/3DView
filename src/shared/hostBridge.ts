// The host bridge: the single, host-agnostic seam the webview uses to talk back
// to whatever host embeds it. Each host (VS Code, PyCharm/JCEF) installs a
// `window.__viewerHost` adapter BEFORE the webview bundle runs; the webview never
// references a host-specific API directly. Keep this free of `vscode`, Node,
// DOM-beyond-globalThis, and three.
import type { WebviewToHost } from "./messages";

/** Minimal channel the webview needs: post a message to the embedding host. */
export interface HostBridge {
  postMessage(msg: WebviewToHost): void;
}

/**
 * Return the host-installed bridge. The host must set `window.__viewerHost` to a
 * `HostBridge` before loading the bundle (the VS Code host wraps its native
 * webview API; PyCharm wires a `JBCefJSQuery`). Throws if missing so
 * misconfiguration is loud.
 */
export function getHostBridge(): HostBridge {
  const bridge = (globalThis as { __viewerHost?: HostBridge }).__viewerHost;
  if (!bridge || typeof bridge.postMessage !== "function") {
    throw new Error(
      "No host bridge: window.__viewerHost must be set before the viewer bundle loads."
    );
  }
  return bridge;
}
