// Message contract between the extension host and the webview.
// Kept in one place so both sides import the same types.

/** Extension host -> webview. */
export type HostToWebview =
  | { type: "ready" };

/** Webview -> extension host. */
export type WebviewToHost =
  | { type: "ready" };
