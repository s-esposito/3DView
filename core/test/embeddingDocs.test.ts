// docs/embedding.md is the embedding API's reference: everything the API offers must be in it.
// The lists are read from the sources (messages.ts, embed/items.ts, embed/sdk.ts), so a message,
// config field, URL parameter or SDK method added without its documentation fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CONFIG_SHORTHANDS } from "../src/embed/items";

const CORE = resolve(__dirname, "..", ".."); // out/test -> core
const read = (p: string) => readFileSync(resolve(CORE, p), "utf8");
const DOC = read("../docs/embedding.md");
const MESSAGES = read("src/shared/messages.ts");

/** The source between `start` and the first line after it that is exactly `end`. */
function block(src: string, start: string, end = "}"): string {
  const from = src.indexOf(start);
  assert.ok(from >= 0, `${start} not found`);
  const lines = src.slice(from).split("\n");
  return lines.slice(0, lines.findIndex((l, i) => i > 0 && l === end) + 1).join("\n");
}
const all = (src: string, re: RegExp) => [...new Set([...src.matchAll(re)].map((m) => m[1]))];
const missing = (names: string[], documented: (n: string) => boolean) => names.filter((n) => !documented(n));
const coded = (n: string) => DOC.includes(`\`${n}\``);

test("every message and event type is documented", () => {
  const types = all(MESSAGES, /type:\s*"(\w+)"/g);
  assert.ok(types.length > 25, `only ${types.length} types read`);
  assert.deepEqual(missing(types, coded), []);
});

test("every configuration field and display switch is documented", () => {
  const config = block(MESSAGES, "export interface ViewerConfig {");
  const fields = all(config, /^\s+(\w+)\?:/gm);
  assert.ok(fields.includes("themeSwitcher") && fields.includes("physics"), "nested fields read");
  assert.deepEqual(missing(fields, (f) => coded(f) || coded(`ui.${f}`) || coded(`interaction.${f}`)), []);
  const shows = all(block(MESSAGES, "export type ShowName", ""), /"(\w+)"/g);
  assert.deepEqual(missing(shows, (s) => DOC.includes(s)), []);
});

test("every embed.html URL parameter and item field is documented", () => {
  const items = read("src/embed/items.ts");
  const params = [...all(items, /(?:key === |params\.get\()"(\w+)"/g), ...CONFIG_SHORTHANDS];
  assert.ok(params.includes("asset") && params.includes("background"), `params read: ${params}`);
  assert.deepEqual(missing(params, (p) => DOC.includes(`| \`${p}\` |`)), []);
  const fields = all(block(items, "export type EmbedItem ="), /(\w+)\??:/g);
  assert.deepEqual(missing(fields, (f) => DOC.includes(`${f}?:`) || DOC.includes(`${f}:`)), []);
});

test("every SDK mount option and public method is documented", () => {
  const sdk = read("src/embed/sdk.ts");
  const options = all(block(sdk, "export interface MountOptions {"), /^\s+(\w+)\?:/gm);
  assert.deepEqual(missing(options, (o) => DOC.includes(`| \`${o}\` |`)), []);
  const methods = all(block(sdk, "export class EmbeddedViewer {"), /^ {2}(?!private |constructor)(\w+)(?:<[^>]*>)?\(/gm);
  assert.ok(methods.includes("add") && methods.includes("capture"), `methods read: ${methods}`);
  assert.deepEqual(missing(methods, (m) => DOC.includes(`\`${m}(`)), []);
});

test("every link inside the page lands on a heading", () => {
  const slug = (h: string) => h.trim().toLowerCase().replace(/[^\w\- ]/g, "").replace(/ /g, "-");
  const anchors = new Set(all(DOC, /^#{1,6} (.+)$/gm).map(slug));
  const links = all(DOC, /\]\(#([\w-]+)\)/g);
  assert.deepEqual(links.filter((l) => !anchors.has(l)), []);
});
