// How items are named and ordered when several are handled together. Pure and
// host-agnostic (see the boundary guard), so the hosts, the webview and the
// temporal layer all order and label things the same way.

/**
 * Compare labels the way a person reads them, so "frame_9" precedes "frame_10".
 * A plain sort puts "frame_10" first, which silently scrambles a capture's frames.
 */
export function compareNatural(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * The name of the deepest folder all of `paths` sit in — what to call a set of
 * items opened together. Each path is an item's own location (an asset file, or a
 * COLMAP model's directory), so its last segment is dropped before comparing:
 * `sparse/0` and `sparse/1` give "sparse", which reads better than "0". Whole
 * segments only, or `sparse/1` and `sparse/10` would "share" `sparse/1`.
 *
 * Undefined when they share no folder at all, leaving the fallback name to the
 * caller. Splits on both separators, so a host may pass native Windows paths.
 */
export function sharedFolderName(paths: string[]): string | undefined {
  if (paths.length === 0) {
    return undefined;
  }
  const dirs = paths.map((p) => p.split(/[/\\]/).slice(0, -1));
  const shared: string[] = [];
  for (let at = 0; at < dirs[0].length; at++) {
    if (!dirs.every((d) => d[at] === dirs[0][at])) {
      break;
    }
    shared.push(dirs[0][at]);
  }
  // `|| undefined`: an absolute path's first segment is empty, so paths that share
  // only their root would otherwise "share" a folder with no name.
  return shared[shared.length - 1] || undefined;
}
