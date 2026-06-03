// Boundary guard for the host-agnostic core (see CLAUDE.md "no-mixing boundary").
//
// Enforces, so the VS Code / PyCharm split can't silently erode:
//   1. Source: nothing under src/shared, src/colmap, src/webview may import
//      `vscode`, a Node builtin (fs/path/os/...), or anything from src/host.
//   2. Bundle: the built out/webview.js must not contain the literal
//      `acquireVsCodeApi` or a Node `require(...)` (it must be host-agnostic).
//
// Pure Node, no deps. Run via `node scripts/check-boundaries.mjs` (wired into
// `npm run build`). Exits non-zero with a report on any violation.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_DIRS = ["src/shared", "src/colmap", "src/webview"];

// Forbidden import specifiers in the shared core.
const NODE_BUILTINS = new Set([
  "fs", "fs/promises", "path", "os", "crypto", "child_process",
  "http", "https", "net", "stream", "zlib", "process", "module",
]);
function forbiddenSpecifier(spec) {
  if (spec === "vscode") return "imports `vscode`";
  if (spec.startsWith("node:")) return `imports Node builtin "${spec}"`;
  if (NODE_BUILTINS.has(spec)) return `imports Node builtin "${spec}"`;
  if (/(^|\/)host(\/|$)/.test(spec)) return `imports from the host layer ("${spec}")`;
  return null;
}

// Match `from "x"`, side-effect `import "x"`, and `require("x")`.
const SPEC_RE = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
}

const violations = [];

for (const rel of SHARED_DIRS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const files = [];
  walk(abs, files);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(SPEC_RE)) {
      const reason = forbiddenSpecifier(m[1]);
      if (reason) {
        violations.push(`${path.relative(ROOT, file)}: ${reason}`);
      }
    }
  }
}

// Bundle check (only if it has been built).
const bundle = path.join(ROOT, "out/webview.js");
if (fs.existsSync(bundle)) {
  const text = fs.readFileSync(bundle, "utf8");
  if (text.includes("acquireVsCodeApi")) {
    violations.push("out/webview.js: contains `acquireVsCodeApi` (host-specific symbol leaked into the shared bundle)");
  }
  if (/\brequire\(\s*["']node:/.test(text) || /\brequire\(\s*["'](?:fs|path|os)["']/.test(text)) {
    violations.push("out/webview.js: contains a Node `require(...)` (Node code leaked into the browser bundle)");
  }
} else {
  console.log("check-boundaries: out/webview.js not built yet — skipping bundle scan.");
}

if (violations.length > 0) {
  console.error("\nBoundary violations (host-agnostic core must not mix host code):");
  for (const v of violations) console.error("  ✗ " + v);
  console.error("\nSee CLAUDE.md → \"The no-mixing boundary\".\n");
  process.exit(1);
}
console.log("check-boundaries: OK — shared core is host-agnostic.");
