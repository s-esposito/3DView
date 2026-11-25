// The embedding kit's items and URL parameters as viewer messages (embed/items.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import { itemMessage, nameOf, parseEmbedParams } from "../src/embed/items";

const PAGE = "https://example.org/gallery/page.html";

test("names: a file's, a folder's, a numbered folder's with its parent", () => {
  assert.equal(nameOf("https://x.org/a/my%20mug.glb?v=2"), "my mug.glb");
  assert.equal(nameOf("https://x.org/scene/sparse/0/"), "sparse/0");
  assert.equal(nameOf("https://x.org/scene/model/"), "model");
});

test("one file: an asset, its URL resolved against the page", () => {
  assert.deepEqual(itemMessage({ url: "assets/mug.glb" }, "item-1", PAGE), {
    type: "addAsset", id: "item-1", label: "mug.glb",
    asset: { uri: "https://example.org/gallery/assets/mug.glb", name: "mug.glb" },
  });
  const own = itemMessage({ url: "/m.ply", id: "mine", label: "The mug" }, "item-1", PAGE);
  assert.equal((own as { id: string }).id, "mine");
  assert.equal((own as { label: string }).label, "The mug");
});

test("a COLMAP folder: its three files in the format asked, and its photos", () => {
  const m = itemMessage({ colmap: "scene/sparse/0", format: "txt", images: "scene/images" }, "c", PAGE);
  assert.deepEqual(m, {
    type: "loadColmap", id: "c", label: "sparse/0", format: "txt",
    urls: {
      cameras: "https://example.org/gallery/scene/sparse/0/cameras.txt",
      images: "https://example.org/gallery/scene/sparse/0/images.txt",
      points3d: "https://example.org/gallery/scene/sparse/0/points3D.txt",
    },
    source: "https://example.org/gallery/scene/sparse/0/",
    imageBaseUrl: "https://example.org/gallery/scene/images/",
  });
});

test("a sequence: one temporal group, members numbered under its id; one file is just an asset", () => {
  const m = itemMessage({ sequence: ["run/000.ply", "run/001.ply"] }, "s", PAGE);
  assert.equal(m.type, "addGroup");
  if (m.type !== "addGroup") return;
  assert.equal(m.label, "run");
  assert.equal(m.grouping, "temporal");
  assert.deepEqual(m.members.map((x) => [x.id, x.label]), [["s/0", "000.ply"], ["s/1", "001.ply"]]);
  assert.equal(itemMessage({ sequence: ["a.ply"] }, "s", PAGE).type, "addAsset");
});

test("URL parameters: items in their order, the view first, config with its shorthands", () => {
  const items = JSON.stringify([{ url: "https://x.org/b.glb", id: "b" }]);
  const { config, messages } = parseEmbedParams(
    `?asset=https://x.org/a.glb&items=${encodeURIComponent(items)}&sequence=https://x.org/1.ply,https://x.org/2.ply`
      + `&view=0,0,-3,0,0,0&config=${encodeURIComponent('{"theme":"dark","show":{"grid":false}}')}&theme=light&preset=presentation`,
    "https://host.org/v2/embed.html");
  assert.deepEqual(messages.map((m) => m.type), ["setView", "addAsset", "addAsset", "addGroup"]);
  assert.deepEqual(messages.slice(1).map((m) => (m as { id: string }).id), ["item-1", "b", "item-3"]);
  assert.deepEqual(config, { theme: "light", show: { grid: false }, preset: "presentation" });
});

test("URL parameters: nothing asked, nothing sent; malformed ones say which", () => {
  assert.deepEqual(parseEmbedParams("", PAGE), { config: undefined, messages: [] });
  assert.throws(() => parseEmbedParams("?config={oops", PAGE), /"config" is not valid JSON/);
  assert.throws(() => parseEmbedParams("?view=1,2,3", PAGE), /six numbers/);
});
