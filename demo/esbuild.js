// Build script for the demo. Produces:
//   dist/demo.js     – the host bridge + file picker (browser, ESM)
//   dist/webview.js  – copied from @3dview/core (the viewer bundle)
const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const CORE_WEBVIEW = path.resolve(__dirname, "..", "core", "out", "webview.js");

/** @type {import('esbuild').BuildOptions} */
const demoConfig = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "dist/demo.js",
  platform: "browser",
  format: "esm",
  target: "es2020",
  sourcemap: true,
  external: ["@3dview/core"], // Don't bundle the core, load from dist/webview.js
};

function copyWebview() {
  if (!fs.existsSync(CORE_WEBVIEW)) {
    console.warn(
      `[demo] WARNING: ${CORE_WEBVIEW} not found — build @3dview/core first ` +
        "(run `npm run build` at the repo root)."
    );
    return;
  }
  fs.mkdirSync("dist", { recursive: true });
  fs.copyFileSync(CORE_WEBVIEW, path.join("dist", "webview.js"));
  if (fs.existsSync(`${CORE_WEBVIEW}.map`)) {
    fs.copyFileSync(`${CORE_WEBVIEW}.map`, path.join("dist", "webview.js.map"));
  }
  console.log("[demo] webview.js copied from @3dview/core");
}

async function run() {
  try {
    await esbuild.build(demoConfig);
    console.log("[demo] demo.js built");
    copyWebview();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
