// The embedding configuration's presets and merging (webview/config.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import { ALL_PANELS, expand, PRESETS } from "../src/webview/config";

test("no preset: the fields as given", () => {
  assert.deepEqual(expand({ theme: "light", show: { grid: false } }),
    { theme: "light", show: { grid: false }, ui: {}, interaction: {} });
});

test("a preset first, then the fields given, group by group", () => {
  const c = expand({ preset: "presentation", show: { box: true }, ui: { footer: true }, interaction: { select: true } });
  assert.deepEqual(c.show, { grid: false, axes: false, box: true }, "box turned back on, grid and axes kept off");
  assert.deepEqual(c.ui, { panels: ["scene"], open: "scene", footer: true });
  assert.deepEqual(c.interaction, { select: true, edit: false, physics: false });
});

test("the full preset is every panel and every control", () => {
  assert.deepEqual(PRESETS.full.ui?.panels, [...ALL_PANELS]);
  assert.ok(Object.values(PRESETS.full.interaction!).every(Boolean));
});
