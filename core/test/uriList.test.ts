// Decoding a `text/uri-list` payload — what a drag out of the editor's file explorer
// carries instead of file bytes, read by the webview's drop zone and by the VS Code
// host's Recents-tree drop alike.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseUriList } from "../src/shared/uriList";

test("parseUriList reads one URI per line", () => {
  assert.deepEqual(parseUriList("file:///data/cap/frame_1.ply"), ["file:///data/cap/frame_1.ply"]);
  // VS Code separates a multi-select with CRLF; a remote window names files by their
  // vscode-remote URI, which the host maps back to a local path.
  assert.deepEqual(
    parseUriList("vscode-remote://ssh-remote%2Bbox/data/a.ply\r\nvscode-remote://ssh-remote%2Bbox/data/b.ply"),
    [
      "vscode-remote://ssh-remote%2Bbox/data/a.ply",
      "vscode-remote://ssh-remote%2Bbox/data/b.ply",
    ]
  );
});

test("parseUriList drops comments and blank lines", () => {
  // RFC 2483: a line starting with '#' is a comment, not a URI.
  assert.deepEqual(parseUriList("# a comment\nfile:///m.glb\n\n  \n"), ["file:///m.glb"]);
  assert.deepEqual(parseUriList(""), []);
  assert.deepEqual(parseUriList("   "), []);
});
