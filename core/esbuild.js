// Build script for @3dview/core. Produces the host-agnostic webview bundle:
//   out/webview.js   – the Three.js viewer UI (browser, IIFE), shipped as-is by
//                      every host (VS Code copies it; the PyCharm plugin copies it).
// Test mode (--test) bundles the pure COLMAP unit tests to out/test/.
const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const watch = process.argv.includes("--watch");
const buildTests = process.argv.includes("--test");

// Inject the package version so the webview can show which build is running. Read
// from package.json here so there's one source of truth (no hand-kept constant).
const version = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
const define = { __APP_VERSION__: JSON.stringify(version) };

// Every webview build is minified to keep the shipped bundle lean. Watch builds
// (`npm run watch`) still emit a sourcemap so the minified output is debuggable;
// production builds (`npm run build`, used for the VSIX + Pages demo) drop it.
const prod = !watch;

// box3d-wasm exports its JS entry points but not its .wasm: physics/box3d.ts imports the
// bytes as "box3d-wasm-binary", read here from the package's own folder and embedded.
const box3dWasm = {
  name: "box3d-wasm-binary",
  setup(build) {
    build.onResolve({ filter: /^box3d-wasm-binary$/ }, () => ({
      path: path.join(path.dirname(require.resolve("box3d-wasm/package.json")), "dist", "box3d.wasm"),
      namespace: "box3d-wasm-binary",
    }));
    build.onLoad({ filter: /.*/, namespace: "box3d-wasm-binary" }, (args) => ({
      contents: fs.readFileSync(args.path),
      loader: "binary",
    }));
  },
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "out/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  minify: true,
  sourcemap: !prod,
  define,
  plugins: [box3dWasm],
  // box3d's loader imports node's "module" only when it runs under Node, never here.
  external: ["node:module"],
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
    define, // in case a test bundles a module referencing __APP_VERSION__
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
