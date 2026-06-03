# 3DViewer — PyCharm / JetBrains plugin

A second host for the 3DViewer Three.js viewer (the [VS Code extension](../vscode/)
is the first). It embeds the **same** `core/out/webview.js` bundle inside a JCEF
(Chromium) tool window and feeds it COLMAP reconstructions + meshes. No viewer
code is duplicated — see [CLAUDE.md](../CLAUDE.md) → "The no-mixing boundary".

## How it works

- The webview bundle is host-agnostic: it talks to its host only through
  `window.__viewerHost` (see `core/src/shared/hostBridge.ts`) and fetches
  images/meshes and (here) the COLMAP `.bin`/`.txt` files from plain URLs.
- This plugin provides that bridge with a `JBCefJSQuery` and serves all content —
  the bundle, the model files, images, meshes — from a single in-process origin
  (`http://colmapview/…`) via a CEF resource handler, guarded to allowed roots.
- COLMAP is parsed **in the webview** (`webview/colmapLoader.ts`); the plugin only
  discovers the model directory and serves bytes. So Kotlin never parses COLMAP.

## Build & run

Two steps — the webview bundle is built by the repo's npm toolchain, then Gradle
packages the plugin:

```bash
# 1) from the repo root — produce core/out/webview.js (Node/npm live in the conda env)
npm run build

# 2) from this directory — run a sandbox IDE with the plugin, or build the zip
cd jetbrains
gradle wrapper            # one-time: creates ./gradlew + wrapper jar (or open in IDE)
./gradlew runIde          # launches PyCharm Community with the plugin
./gradlew buildPlugin     # -> build/distributions/*.zip (Install Plugin from Disk)
./gradlew verifyPlugin    # plugin-verifier against the configured IDE
```

> The Gradle wrapper jar is binary and isn't committed; run `gradle wrapper` once
> (needs a local Gradle), or just open this folder in IntelliJ IDEA / PyCharm and
> let it generate the wrapper. `copyWebview` will fail with a clear message if
> `../core/out/webview.js` is missing — run step 1 first.

## Use

Open the **3D Viewer** tool window (right dock), or run *Tools ▸ 3DViewer: Open …*.
Pick a COLMAP folder (a dir containing `cameras`/`images`/`points3D`, e.g.
`sparse/0`) or a mesh (`.glb`/`.gltf`/`.obj`/`.ply`). Controls match the VS Code
host (orbit/zoom/pan; click a frustum to fly to it; P/F/I/B/W/G/A/U; R to reset).
