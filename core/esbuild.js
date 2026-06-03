// Build script for @3dviewer/core. Produces the host-agnostic webview bundle:
//   out/webview.js   – the Three.js viewer UI (browser, IIFE), shipped as-is by
//                      every host (VS Code copies it; the PyCharm plugin copies it).
// Test mode (--test) bundles the pure COLMAP unit tests to out/test/.
const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const watch = process.argv.includes("--watch");
const buildTests = process.argv.includes("--test");

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "out/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  sourcemap: true,
};

// Bundle each test/*.test.ts into out/test/ as a Node CJS module (node builtins
// are auto-externalized for platform "node"), so `node --test` runs them directly.
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

async function run() {
  if (buildTests) {
    await esbuild.build(testConfig());
    console.log("[core] tests built");
    return;
  }
  if (watch) {
    const ctx = await esbuild.context(webviewConfig);
    await ctx.watch();
    console.log("[core] watching webview for changes...");
  } else {
    await esbuild.build(webviewConfig);
    console.log("[core] webview built");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
