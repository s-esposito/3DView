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
