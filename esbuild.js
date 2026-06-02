// Build script for the 3DViewer extension.
// Produces two bundles:
//   out/extension.js  – the extension host code (Node, CommonJS)
//   out/webview.js     – the webview UI code (browser, IIFE)
const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
};

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

async function run() {
  if (watch) {
    const ctxExt = await esbuild.context(extensionConfig);
    const ctxWeb = await esbuild.context(webviewConfig);
    await Promise.all([ctxExt.watch(), ctxWeb.watch()]);
    console.log("[3dviewer] watching for changes...");
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
    ]);
    console.log("[3dviewer] build complete");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
