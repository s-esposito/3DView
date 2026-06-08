# CLAUDE.md — internal development guide

Internal architecture/convention reference for working on this codebase. Claude
Code auto-loads this file each session, so it is the single source of truth for
"how this project is built." **Keep it current: whenever you change architecture,
module responsibilities, invariants, build/commands, or conventions, update this
file in the same change.** Roadmap/status lives in [TODO.md](TODO.md); user-facing
docs live in [README.md](README.md).

## Working Principles

1. **Think before coding.** State assumptions. Surface tradeoffs. If unclear, ask — don't guess.
2. **Simplicity first.** Minimum code that solves the problem. No speculative features, abstractions, or error handling for impossible scenarios.
3. **Surgical changes.** Touch only what the task requires. Don't improve adjacent code/comments/formatting. Remove only orphans YOUR changes created. Every changed line traces to the request.
4. **Goal-driven execution.** Define verifiable success criteria upfront. For multi-step tasks, state a brief plan with checks. Loop until verified.

## Names

- The brand is uniformly **3DView**: display name / command titles **3DView**,
  GitHub repo `s-esposito/3DView`, npm names lowercased to `3dview`. npm is a
  **workspaces monorepo**: root `3dview-monorepo`, packages `@3dview/core`
  (shared), `3dview` (VS Code extension), and `3dview-demo` (GitHub Pages demo);
  VS Code command/view IDs are `3dview.*`. The PyCharm plugin (`jetbrains/`) is a
  separate Gradle build. Two names differ for historical reasons and are
  intentional (don't "fix"): the local folder `colmapview` and the Kotlin package
  `dev.colmapview`.

## Environment / commands

- **Node/npm are not on the system PATH** — they live in a conda env
  (`~/.conda/envs/sam3d-objects/bin`). `.vscode/tasks.json` and
  `.vscode/settings.json` prepend it via `${env:HOME}` so VS Code tasks and
  integrated terminals work. In a raw shell, prepend it yourself.

Run from the repo root; npm workspaces orchestrate `@3dview/core`, `3dview`, and `3dview-demo`.
First time: `npm install` at the root (links the workspaces).

```bash
npm run build    # core → out/webview.js (+ check-boundaries); vscode → extension.js; demo → dist/demo.js + copies webview.js
npm run watch    # build core once, then watch-rebuild the extension
npm run lint     # tsc --noEmit in each package — MUST be clean (esbuild does not type-check)
npm run check    # boundary guard (host-agnostic core); also runs inside core's build
npm test         # esbuild --test per package, then node --test
./vscode_build.sh     # build monorepo + vsce package → vscode/*.vsix (then code --install-extension)
./jetbrains_build.sh  # build webview bundle + gradle buildPlugin → jetbrains/build/distributions/*.zip
```

The demo is deployed to GitHub Pages via `.github/workflows/deploy-demo.yml` on pushes to `main`.

## Architecture — runtime domains

An npm-workspaces monorepo: a host-agnostic **core** (`@3dview/core`) consumed by
thin hosts — the **vscode** extension (`3dview`), the **demo** web page
(`3dview-demo`), and the **jetbrains** PyCharm plugin (a separate Gradle build).
The webview bundle is byte-identical across hosts; each talks to it only via
`postMessage`. Dependencies point inward only. See **The no-mixing boundary** below.

```
core/                  @3dview/core — host-agnostic; builds out/webview.js. No vscode/Node/JVM.
  src/index.ts           public API consumed by hosts (re-exports shared + colmap)
  src/shared/
    messages.ts          host↔webview message contract + DTOs (HostToWebview/WebviewToHost)
    hostBridge.ts        getHostBridge(): the neutral window.__viewerHost channel
  src/colmap/            Pure COLMAP library: parsing + pose + bounds (byte buffers/strings)
    reader.ts            little-endian binary cursor
    cameras.ts/images.ts/points3d.ts   .bin + .txt parsers
    pose.ts              qvec/tvec → camera center (-R^T t) + worldFromCamera (R^T)
    bounds.ts            computeBounds(positions) → axis-aligned Bounds
    types.ts             Camera/Image/PointCloud + model→params, modelName()
    index.ts             pure public surface
  src/webview/           Browser UI (DOM + three) → out/webview.js
    main.ts              entry/glue: host bridge, message channel, keyboard, status
    colmapLoader.ts      loadColmapFromUrls(): fetch model files → pure parsers → ModelData
    viewer.ts            Viewer: scene graph/camera/layers/global display — THE seam
    sceneLayer.ts        SceneLayer interface + ReconstructionLayer + DisplayOptions
    assetLayer.ts        AssetLayer (SceneLayer): loads a mesh (GLTF/OBJ/PLY) or a
                         3DGS splat (.ply/.splat/.spz/.ksplat, via Spark → colored
                         points; .ply auto-disambiguated by `f_dc_0`) into a group.
                         Each mesh keeps its loaded (lit PBR, incl. GLB textures)
                         material + a derived unlit-albedo twin; "Shaded" swaps
                         between them (shaded is the default), "Wireframe" sets both
    cameraLayer.ts       per-camera frustums + image planes; hover/select; lazy textures (cap)
    cameraInteraction.ts pointer pick/hover/select across layers + fly-to-POV
    builders.ts          pure three.js geometry builders + scene math (bounds, dispose)
    textures.ts          ThumbnailLoader: concurrency-limited, downscaling
    theme.ts             theme CSS var → THREE.Color (fallback when the var is unset)
    ui/                  styles.ts, components.ts, controlPanel.ts (Scene list), overlays.ts (InfoPopup)
  test/colmap.test.ts    pure parser/pose unit tests
  scripts/check-boundaries.mjs   boundary guard (run by core's build)
vscode/                3dview — VS Code extension (Node + vscode) → out/extension.js
  src/host/
    extension.ts         activate(): commands (openReconstruction/openAsset/openViewer), pickers, quick-pick
    colmapLoad.ts        fs discovery + load: detectFormat/findModelDirs/findImagesDir/loadModel (Node fs)
    panel.ts             ViewerPanel singleton: webview lifecycle, CSP, image URIs, scene-item
                         tracking (ids) + replay; injects the VS Code __viewerHost adapter
    modelData.ts         parsed model → render-ready ModelData DTO
  test/colmapLoad.test.ts   fs discovery/load round-trip
  esbuild.js (extension + copies core's webview.js) · tsconfig · .vscodeignore · media/
demo/                  3dview-demo — GitHub Pages web host → dist/
  src/host.ts            installs window.__viewerHost (file-picker bridge; blob-URL loadColmap/addAsset)
  src/main.ts            entry: install the bridge before the bundle loads
  esbuild.js (demo.js + copies core's webview.js) · index.html · deployed by .github/workflows/deploy-demo.yml
jetbrains/             PyCharm/JCEF plugin (Kotlin/Gradle) — consumes core/out/webview.js. See its README.
```

### The no-mixing boundary

`core/src/` is **host-agnostic** — no `vscode`, no `node:*`, no JVM, no
host-specific symbols. Each host lives entirely in its own package: VS Code in
`vscode/src/host/`, the web demo in `demo/src/`, PyCharm in `jetbrains/` (Kotlin;
consumes only the built bundle, no TS). The compiled `core/out/webview.js` is
copied byte-identical into every host; each installs its own `window.__viewerHost`
adapter (a `{ postMessage }`) before the bundle loads — VS Code wraps its native
webview API (inline script in `vscode/src/host/panel.ts` `getHtml()`), the demo
installs a file-picker bridge (`demo/src/host.ts`), PyCharm wires a JBCefJSQuery.
Only two things couple a host to the core: the `messages.ts` contract (the Kotlin
side hand-mirrors it in `Messages.kt`) and the `window.__viewerHost` bridge.
`core/scripts/check-boundaries.mjs` (run by the core build) fails if `core/src`
imports `vscode`/Node/`host`, or if `out/webview.js` contains `acquireVsCodeApi`/a
Node `require`. Don't leak host code into core to "make it work" — adapt at the bridge.

**The `Viewer` is the central seam.** A scene is a **list of `SceneLayer`s**
(reconstructions + assets, where an asset is a mesh or a 3DGS splat) under a single
`root` group; helpers (grid/axes) and fit-to-view union over all layers. The UI
(`webview/ui/`) talks to the scene ONLY through the Viewer API (`addReconstruction`,
`addAsset`, `removeItem`,
`renameItem`, `setItemVisible`, `setGlobal`/`toggleGlobal`, `setPointSize`, `setFrustumScale`,
`setOrientation`, `resetView`, `exitPov`, `saveViewpoint`, `getState`, +
`onSelect`/`onChange`/`onError`/`onRequestAdd`/`onRemoveItem`/`onSaveImage`
callbacks) — never three.js directly. Adding
a new source = implement `SceneLayer`, add a `Viewer.addX`, and the
Scene list + global toggles adapt automatically. (3DGS arrived as a format inside
the existing `AssetLayer`, not a new layer — see `assetLayer.ts`.)

**Scene-item flow (multiple reconstructions + assets):** the host assigns each item
a stable `id` and tracks the list in `panel.ts`. The Scene "+" menu posts
`requestAdd` → host runs the matching command's picker → posts `addReconstruction`/
`addAsset` with the id. Removing an item (Scene list ✕) removes it webview-side and
posts `removed` so the host forgets it (won't replay it). Per-item controls are
visibility + remove; appearance (point/frustum size, images, grid, axes, orientation)
is global across the scene.

## Invariants & conventions (do not break)

- **Raw COLMAP axes.** Points/poses stay in COLMAP's +x-right/+y-down/+z-forward
  world frame. No implicit up-flip. The "upright (U)" toggle only rotates `root`
  180° about X for viewing; fit-to-view re-bounds in world space.
- **On-demand rendering (don't freeze the view).** `viewer.ts animate()` only
  calls `renderer.render` when `controls.update()` reports motion (incl. damping)
  OR `needsRender` is set. Anything that changes what's on screen *without moving
  the camera* MUST call `requestRender()` — every Viewer mutator
  (`setGlobal`/`setPointSize`/`setFrustumScale`/`setItemVisible`/`fitCamera`/
  `rebuildHelpers`/`onResize`), interaction hover/select/deselect (via
  `InteractionDeps.requestRender`), and async texture load/evict (via
  `CameraLayer`'s `onTextureChange` → `Viewer.requestRender`). Forgetting this
  leaves the view frozen until the next interaction. Don't also add an
  OrbitControls `'change'` listener — `update()` already covers damping.
- **Render cost knobs:** pixel ratio is capped at `MAX_PIXEL_RATIO` (1.5) in
  `viewer.ts` (re-applied on resize); `buildPoints` sets `geometry.boundingSphere`
  from `data.bounds` (radius = ½ space diagonal) to skip Three's O(n) first-frame
  scan. The point cloud is never raycast (picking is frustums only).
- **PBR meshes need the environment.** Lit meshes are shaded by `scene.environment`
  (a PMREM-filtered `RoomEnvironment`) plus a hemisphere + key light, set once in
  `viewer.ts`. The IBL is not decoration: a `metalness>0` glTF surface (e.g. a GLB
  with a `metallicRoughnessTexture` — its texture feeds both `metalnessMap` and
  `roughnessMap`) reflects the environment and renders black without it. Only
  `MeshStandard`/`Physical` sample `environment`; unlit points/lines/image planes
  and the albedo `MeshBasic` twins ignore it. Don't drop it to "simplify lighting."
- **`shared/messages.ts` is the single source of truth** for the host↔webview
  contract. Extend the `HostToWebview`/`WebviewToHost` unions there and handle in
  `main.ts`. Keep it dependency-free. Reconstructions arrive two ways:
  `addReconstruction` (host ships a parsed `ModelData`; used by VS Code) and
  `loadColmap` (host ships URLs, the webview fetches + parses via
  `colmapLoader.ts`; used by URL-based hosts like PyCharm). Both converge on
  `viewer.addReconstruction`. Meshes and 3DGS splats both arrive as **`addAsset`**
  (`{ asset: { uri, name } }`); the webview's `assetLayer.ts` picks the loader by
  extension and `viewer.addAsset` adds the layer.
- **Host-agnostic bundle / the host bridge.** The webview never calls a
  host-specific API; it reads `window.__viewerHost` via
  `shared/hostBridge.getHostBridge()`. Each host installs that adapter before the
  bundle loads (VS Code: inline script in `panel.ts` `getHtml`). Keep
  `acquireVsCodeApi` and any Node/`vscode` import out of `shared`/`colmap`/`webview`
  — `npm run check` enforces it.
- **`colmap/` is pure** (no `vscode`, no DOM, **no Node `fs`/`path`**) so it stays
  unit-testable and reusable in the browser. New parsing/pose/bounds logic goes
  here with a test. Filesystem discovery/IO is host code
  (`vscode/src/host/colmapLoad.ts`), not part of this library.
- **CSP** (`vscode/src/host/panel.ts` getHtml; VS Code host only): `default-src
  'none'`; nonce'd script (+ `'wasm-unsafe-eval'`) only;
  `img-src` and `connect-src` scoped to `webview.cspSource`, each also allowing
  `blob:`/`data:`; `worker-src blob:`. Frustum images load via `<img>` (img-src).
  Asset loaders fetch via `connect-src` — and crucially `connect-src` MUST include
  `blob:`: GLTFLoader decodes a GLB's **embedded (bufferView) textures** (e.g. the
  WebP images in this repo's GLBs) by wrapping their bytes in a `blob:` URL that its
  `ImageBitmapLoader` then `fetch`es, so without it those textures silently fail to
  load (img-src's `blob:` is for `<img>`, a different directive). `data:` on
  `connect-src` covers the Spark worker's inlined wasm. The splat decoder ([Spark](https://sparkjs.dev))
  runs WebAssembly inside a `blob:` Web Worker — hence `worker-src blob:` and
  `'wasm-unsafe-eval'` (the worker inherits the page policy). We fetch the splat
  bytes on the main thread and hand them to Spark, so the worker itself never
  fetches. If you add asset types/workers, update the CSP.
- **`localResourceRoots` is fixed at panel creation**, and recreating the panel
  reloads the whole webview ("restart from scratch"). To avoid that on every add,
  `rootsFor` allows the **filesystem/drive root** of each opened path, so adding
  content from any new folder is already covered and the panel is reused (no
  reload). `ViewerPanel` still tracks the scene-item list (id + `OpenTarget`) and
  **replays** it if a recreate is ever forced (e.g. a different drive on Windows);
  ids are stable across recreates (module-level counter). The broad root is safe
  because the host only ever builds URIs for opened content (mesh files; images
  under a model's dir, path-escape-guarded). Don't narrow `rootsFor` back to exact
  folders — it reintroduces the reload-on-add bug.
- **Fit-to-view only on the first item.** `Viewer.refreshScene(fit)` re-fits the
  camera only when the scene was empty; adding to an existing scene keeps the
  user's current view. `resetView()` (R) is the explicit re-fit.
- **Image-name path guard:** `attachImageUris` rejects names escaping the images
  root (`..`/absolute) before building a webview URI.
- **postMessage has no transfer list** in VS Code webviews — typed arrays are
  structured-cloned (copied), not transferred.
- **Texture budget:** frustum textures decode **at scale** (fetch blob →
  `createImageBitmap(blob, {resizeWidth/Height})`, sized from the camera's pixel
  dims; `<img>` fallback if `fetch` is blocked), downscaled to `maxSize=256`,
  concurrency-limited (8), and only the nearest `MAX_RESIDENT_TEXTURES=48` are
  resident (see `textures.ts`/`cameraLayer.ts`). The flip is baked into the
  bitmap (`imageOrientation:"flipY"` + `texture.flipY=false`) — ImageBitmap
  ignores `flipY`. The click-popup uses the full-res `<img>` (one at a time).
- **Precision caveat:** point positions are downcast float64→float32 in
  `points3d.ts` (~7 sig digits). Fine for normalized scenes; revisit for
  geo-referenced coordinates (would need an origin offset).
- **Disposal:** removing scene objects must free GPU resources — use
  `builders.disposeObject` (geometry + materials + maps). Rebuilding cameras
  bumps a generation so stale async texture loads are discarded.

## How to extend

All viewer changes live in `core/src/webview/`; host changes in each host package.
- **New scene element:** add a builder in `builders.ts` (or a layer class like
  `cameraLayer.ts`), wire it into `Viewer` (build/dispose/visibility/bounds), add
  a `Layer` key + a toggle in `controlPanel.ts` and a key in `main.ts`.
- **New host→webview message:** add to the union in `core/src/shared/messages.ts`,
  handle it in `core/src/webview/main.ts`, and post it from the host(s) that need
  it (`vscode/src/host/panel.ts`; `demo/src/host.ts`; PyCharm + its `Messages.kt`).
- **New asset format:** add a loader case in `assetLayer.ts` and the extension to
  the picker filters in each host — `ASSET_EXTS` in `vscode/src/host/extension.ts`,
  `input.accept` in `demo/src/host.ts`, and `ASSET_EXTS` in
  `jetbrains/.../ColmapViewerService.kt`. Splat formats decode through Spark; meshes
  through three's loaders.

## Build internals

- **Workspaces:** root `package.json` orchestrates `@3dview/core` → `3dview`
  → `3dview-demo`; `npm install` once at the root links them. `jetbrains/` is a
  separate Gradle build, not an npm workspace.
- **Dependencies:** `@3dview/core` depends on `three` (**>=0.180**, the
  `@sparkjsdev/spark` peer requirement) and `@sparkjsdev/spark` (the splat loader).
  esbuild inlines Spark — including its embedded WASM splat decoder + `blob:` worker —
  into `out/webview.js`, so the bundle is several MB (≈6.4M). The worker is
  self-contained (no `import.meta`/`new URL`, no Node `require`), so the boundary
  guard stays green; it just needs the CSP allowances above on the VS Code host.
- `core/esbuild.js`: webview entry `src/webview/main.ts` → `out/webview.js`
  (browser/iife); `--test` bundles `test/*.test.ts` → `out/test/`. `vscode/esbuild.js`:
  extension entry `src/host/extension.ts` → `out/extension.js` (node/cjs, `vscode`
  external) **and copies** `../core/out/webview.js`. `demo/esbuild.js`: `src/main.ts`
  → `dist/demo.js` (browser/esm, `@3dview/core` external) and copies the bundle.
- tsconfig per package: `module ESNext`, `moduleResolution Bundler` (esbuild is the
  real bundler; needed for three's ESM example loaders). Hosts resolve
  `@3dview/core` via the workspace symlink (its `types: src/index.ts`).
- Packaging (`vsce`, run in `vscode/`): `.vscodeignore` excludes `src/`, `test/`,
  maps, `*.vsix`, `esbuild.js`, `tsconfig.json`. `out/` + `media/` +
  README ship. `@3dview/core` is a devDependency (esbuild bundles it in), so it is
  not packaged. `vscode_build.sh` passes `vsce --no-dependencies`: because this is a
  workspace, `@3dview/core` is hoisted to the **root** `node_modules` and symlinked
  to `../../core` (outside the package), so without the flag vsce follows that symlink
  out of `vscode/` and tries to package the whole repo root (failing with `invalid
  relative path: extension/../…`). The flag is safe — esbuild already inlines core, so
  there are no runtime deps to ship. Don't remove it.
- The demo is deployed to GitHub Pages via `.github/workflows/deploy-demo.yml` on
  pushes to the `main` branch.

## Git

- Remote `origin` = `git@github.com:s-esposito/3DView.git`, branch `main`.
- Commit/push only when asked. End commit messages with the Co-Authored-By
  trailer used on existing commits.
- **`CLAUDE.md` is dev-only** — it's removed on `main` (and listed in
  `.gitignore`). It's force-tracked on `dev` despite the ignore entry, so
  promoting `dev`→`main` reintroduces it: the promotion is a real merge, not a
  fast-forward, and you must `git rm CLAUDE.md` on `main` after merging (before
  pushing). The `.gitignore` entry only guards against untracked re-adds, not the
  merge.
