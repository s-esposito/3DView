// embed.html's host: the viewer in an iframe, set up from the page's URL parameters (items.ts
// parseEmbedParams) and talking to the page that embeds it. Loaded before webview.js, it installs
// the host bridge: everything the viewer says goes to the parent window, and the parent's messages
// reach the viewer directly (it listens on its window). Not a module: a plain script, run first.
import type { HostBridge } from "../shared/hostBridge";
import type { HostToWebview, WebviewToHost } from "../shared/messages";
import { parseEmbedParams, type EmbedSetup } from "./items";

let setup: EmbedSetup;
try {
  setup = parseEmbedParams(location.search, location.href);
} catch (err) {
  setup = { messages: [{ type: "error", message: `embed.html: ${(err as Error).message}` }] };
}
const send = (msg: HostToWebview) => window.postMessage(msg, "*");
const bridge: HostBridge = {
  config: setup.config,
  postMessage(msg: WebviewToHost) {
    if (window.parent !== window) {
      window.parent.postMessage(msg, "*"); // the embedding page; nothing when opened on its own
    }
    if (msg.type === "ready") {
      setup.messages.forEach(send); // the URL's items, now that the viewer listens
    }
  },
};
(globalThis as { __viewerHost?: HostBridge }).__viewerHost = bridge;
