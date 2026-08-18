// How items are ordered and named when several are handled together.
import { test } from "node:test";
import assert from "node:assert/strict";

import { compareNatural, sharedFolderName } from "../src/shared/naming";

test("compareNatural orders labels the way a person reads them", () => {
  assert.deepEqual(
    ["frame_10", "frame_2", "frame_1"].sort(compareNatural),
    ["frame_1", "frame_2", "frame_10"]
  );
  assert.deepEqual(["sparse/10", "sparse/9"].sort(compareNatural), ["sparse/9", "sparse/10"]);
});

test("sharedFolderName names the deepest folder a set of items sits in", () => {
  // Each path is an item's own location, so its last segment doesn't count: these
  // are COLMAP models, and what they share is sparse/, not "0".
  assert.equal(sharedFolderName(["/data/cap/sparse/0", "/data/cap/sparse/1"]), "sparse");
  assert.equal(
    sharedFolderName(["/data/cap/frames/f_1.ply", "/data/cap/frames/f_2.ply"]),
    "frames"
  );
  // Whole segments only: a character-wise prefix would call these "1".
  assert.equal(sharedFolderName(["/cap/sparse/1", "/cap/sparse/10"]), "sparse");
  // Windows paths, from a native host.
  assert.equal(sharedFolderName(["C:\\cap\\frames\\a.ply", "C:\\cap\\frames\\b.ply"]), "frames");
});

test("sharedFolderName gives up rather than inventing a name", () => {
  assert.equal(sharedFolderName([]), undefined, "nothing to name");
  assert.equal(sharedFolderName(["a.ply", "b.ply"]), undefined, "no folder at all");
  assert.equal(sharedFolderName(["/x/a.ply", "/y/b.ply"]), undefined, "no folder in common");
});
