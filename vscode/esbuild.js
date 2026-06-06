// Build script for the 3DView VS Code extension.
//   out/extension.js – the extension host (Node, CommonJS; `vscode` is external)
//   out/webview.js    – copied from @3dview/core's build (the shared, host-agnostic
//                       Three.js bundle). Core must be built first; the root
//                       `npm run build` does that, then this.
const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const watch = process.argv.includes("--watch");
const buildTests = process.argv.includes("--test");

const CORE_WEBVIEW = path.resolve(__dirname, "..", "core", "out", "webview.js");

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/host/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
};

function testConfig() {
  const dir = "test";
  const entryPoints = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => path.join(dir, f));
  return {
    entryPoints,
    bundle: true,
    outdir: "out/test",
    platform: "node",
    format: "cjs",
    target: "node18",
    sourcemap: true,
  };
}

// Ship the shared webview bundle inside the extension by copying core's output.
function copyWebview() {
  if (!fs.existsSync(CORE_WEBVIEW)) {
    console.warn(
      `[vscode] WARNING: ${CORE_WEBVIEW} not found — build @3dview/core first ` +
        "(run `npm run build` at the repo root)."
    );
    return;
  }
  fs.mkdirSync("out", { recursive: true });
  fs.copyFileSync(CORE_WEBVIEW, path.join("out", "webview.js"));
  if (fs.existsSync(`${CORE_WEBVIEW}.map`)) {
    fs.copyFileSync(`${CORE_WEBVIEW}.map`, path.join("out", "webview.js.map"));
  }
  console.log("[vscode] webview.js copied from @3dview/core");
}

async function run() {
  if (buildTests) {
    await esbuild.build(testConfig());
    console.log("[vscode] tests built");
    return;
  }
  copyWebview();
  if (watch) {
    const ctx = await esbuild.context(extensionConfig);
    await ctx.watch();
    console.log("[vscode] watching extension for changes...");
  } else {
    await esbuild.build(extensionConfig);
    console.log("[vscode] extension built");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
