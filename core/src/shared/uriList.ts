// The `text/uri-list` payload: what a drag carries when it names files rather than
// handing over their bytes — a drag out of an editor's file explorer, or of an
// editor tab. Both the webview's drop zone and a host's own drop targets decode it,
// so they decode it the same way.

/** The MIME type a URI-naming drag publishes. */
export const URI_LIST_MIME = "text/uri-list";

/** The URIs of a `text/uri-list` payload: one per line, `#` lines being comments
 *  (RFC 2483). */
export function parseUriList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}
