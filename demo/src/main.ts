import { installHostBridge } from "./host";

// Order matters: the viewer bundle reads `window.__viewerHost` at startup and
// throws if it's missing. A plain `<script>` tag for the bundle placed *after*
// this module would actually run FIRST (module scripts are deferred, classic
// scripts are not), so we install the bridge here and then inject the bundle
// ourselves — guaranteeing the bridge exists before the bundle runs.
installHostBridge();

const bundle = document.createElement("script");
// Resolve next to this module (dist/demo.js → dist/webview.js), so it works both
// locally and under the GitHub Pages base path.
bundle.src = new URL("webview.js", import.meta.url).href;
document.body.appendChild(bundle);

console.log("[demo] host bridge installed; loading viewer bundle");

// Installable web app: the service worker lets the installed app open offline (see
// sw.js). Registered after load so it never competes with the viewer bundle's
// download; relative, so its scope is the Pages base path. Not on file:// or plain
// http — browsers only allow service workers on https and localhost.
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("[demo] no service worker", err));
  });
}
