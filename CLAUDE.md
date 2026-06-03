# CLAUDE.md — internal development guide

Internal architecture/convention reference for working on this codebase. Claude
Code auto-loads this file each session, so it is the single source of truth for
"how this project is built." **Keep it current: whenever you change architecture,
module responsibilities, invariants, build/commands, or conventions, update this
file in the same change.** Roadmap/status lives in [TODO.md](TODO.md); user-facing
docs live in [README.md](README.md).

## Names (intentional, don't "fix")

- Local folder: `colmapview` · GitHub repo: `s-esposito/3DView` · display name /
  commands: **3DViewer**. npm is a **workspaces monorepo**: root
  `3dviewer-monorepo`, packages `@3dviewer/core` (shared) and `3dviewer` (the
  published VS Code extension; must stay lowercase). The PyCharm plugin
  (`jetbrains/`) is a separate Gradle build. These differing names are deliberate.

## Environment / commands

- **Node/npm are not on the system PATH** — they live in a conda env
  (`~/.conda/envs/sam3d-objects/bin`). `.vscode/tasks.json` and
  `.vscode/settings.json` prepend it via `${env:HOME}` so VS Code tasks and
  integrated terminals work. In a raw shell, prepend it yourself.

Run from the repo root; npm workspaces orchestrate `@3dviewer/core` then `3dviewer`.
First time: `npm install` at the root (links the workspaces).

```bash
npm run build    # core → out/webview.js (+ check-boundaries); vscode → extension.js + copies webview.js
npm run watch    # build core once, then watch-rebuild the extension
npm run lint     # tsc --noEmit in each package — MUST be clean (esbuild does not type-check)
npm run check    # boundary guard (host-agnostic core); also runs inside core's build
npm test         # esbuild --test per package, then node --test
vscode/reinstall.sh   # build monorepo + vsce package + code --install-extension --force
```

Always run `npm run lint && npm run build && npm test` after changes; all three
must pass before considering work done. (`build` runs `core/scripts/check-boundaries.mjs`,
which fails if the host-agnostic core mixes host code — see the boundary below.)
The PyCharm plugin builds separately with Gradle — see `jetbrains/README.md`.

## Architecture — runtime domains

Two bundles that talk only via `postMessage`, plus a host-agnostic shared core
(contract + bridge) and a pure parsing layer. Dependencies point inward only.
See **The no-mixing boundary** below — the shared core carries no host code, so a
second host (the PyCharm/JCEF plugin in `jetbrains-plugin/`) reuses the webview
bundle as-is.

```
src/
  shared/              Host-agnostic seam imported by BOTH runtimes — no vscode /
                       Node / DOM / three.
    messages.ts          Message contract + DTOs (HostToWebview/WebviewToHost)
    hostBridge.ts        getHostBridge(): the neutral window.__viewerHost channel
  colmap/              Pure, host-agnostic COLMAP library: parsing + pose math +
                       bounds, over byte buffers/strings. No vscode, NO Node fs.
                       Unit-tested in test/colmap.test.ts.
    reader.ts            little-endian binary cursor
    cameras.ts/images.ts/points3d.ts   .bin + .txt parsers
    pose.ts              qvec/tvec → camera center (-R^T t) + worldFromCamera (R^T)
    bounds.ts            computeBounds(positions) → axis-aligned Bounds
    types.ts             Camera/Image/PointCloud + model→params, modelName()
    index.ts             public surface (pure only)
  host/                VS Code host (Node + vscode). → out/extension.js
    extension.ts         activate(): commands (openReconstruction/openMesh/openViewer),
                         folder/file pickers, quick-pick
    colmapLoad.ts        fs discovery + load: detectFormat/findModelDirs/
                         findImagesDir/loadModel (Node fs; VS-Code-host only)
    panel.ts             ViewerPanel singleton: webview lifecycle, CSP, image URIs,
                         scene-item tracking (ids) + replay; injects the VS Code
                         window.__viewerHost adapter into the page
    modelData.ts         pure: parsed model → render-ready ModelData DTO
  webview/             Host-agnostic browser UI (DOM + three). → out/webview.js
    main.ts              entry/glue: host bridge, message channel, keyboard, status
    colmapLoader.ts      loadColmapFromUrls(): fetch model files → pure parsers →
                         ModelData (used by URL-based hosts, e.g. PyCharm)
    viewer.ts            Viewer: scene graph, camera, layer list, global display
                         options, bounds/fit, helpers. THE seam the UI + host drive.
    sceneLayer.ts        SceneLayer interface + ReconstructionLayer (points+cameras+box)
                         + DisplayOptions
    meshLayer.ts         MeshLayer (SceneLayer): loads GLTF/OBJ/PLY into a group
    cameraLayer.ts       a reconstruction's per-camera frustums + image planes;
                         hover/select coloring; lazy distance-based textures (cap)
    cameraInteraction.ts pointer pick/hover/select across layers + fly-to-POV
    builders.ts          pure three.js geometry builders + scene math (bounds, dispose)
    textures.ts          ThumbnailLoader: concurrency-limited, downscaling
    theme.ts             theme CSS var → THREE.Color (fallback when the var is unset)
    ui/                  styles.ts (injected CSS), components.ts (dom helpers incl.
                         iconButton/menuButton), controlPanel.ts (Scene list + global
                         controls), overlays.ts (InfoPopup)
```

### The no-mixing boundary

`src/shared/`, `src/colmap/`, `src/webview/` are **host-agnostic** — no `vscode`,
no `node:*`, no JVM, no host-specific symbols. **All VS Code code lives in
`src/host/`; all PyCharm code lives in `jetbrains-plugin/`** (Kotlin/Gradle; see
its own README — it consumes only the built `out/webview.js`, no TS). The compiled
`out/webview.js` is identical for both hosts; each host installs its own
`window.__viewerHost` adapter (a `{ postMessage }`) before the bundle loads — the
VS Code one (wrapping its native webview API) is the inline script in
`panel.ts` `getHtml()`. Only two things couple a host to the core: the
`messages.ts` contract and the `window.__viewerHost` bridge. `scripts/check-boundaries.mjs`
(run by `npm run build`) fails the build if the core imports `vscode`/Node/`host`,
or if `out/webview.js` contains `acquireVsCodeApi`/a Node `require`. Don't add
host-specific code to the shared layers to "make it work" — adapt at the bridge.

**The `Viewer` is the central seam.** A scene is a **list of `SceneLayer`s**
(reconstructions + meshes) under a single `root` group; helpers (grid/axes) and
fit-to-view union over all layers. The UI (`webview/ui/`) talks to the scene ONLY
through the Viewer API (`addReconstruction`, `addMesh`, `removeItem`,
`setItemVisible`, `setGlobal`/`toggleGlobal`, `setPointSize`, `setFrustumScale`,
`setOrientation`, `resetView`, `exitPov`, `getState`, + `onSelect`/`onChange`/
`onError`/`onRequestAdd`/`onRemoveItem` callbacks) — never three.js directly. Adding
a new source (e.g. 3DGS) = implement `SceneLayer`, add a `Viewer.addX`, and the
Scene list + global toggles adapt automatically.

**Scene-item flow (multiple reconstructions + meshes):** the host assigns each item
a stable `id` and tracks the list in `panel.ts`. The Scene "+" menu posts
`requestAdd` → host runs the matching command's picker → posts `addReconstruction`/
`addMesh` with the id. Removing an item (Scene list ✕) removes it webview-side and
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
- **`shared/messages.ts` is the single source of truth** for the host↔webview
  contract. Extend the `HostToWebview`/`WebviewToHost` unions there and handle in
  `main.ts`. Keep it dependency-free. Reconstructions arrive two ways:
  `addReconstruction` (host ships a parsed `ModelData`; used by VS Code) and
  `loadColmap` (host ships URLs, the webview fetches + parses via
  `colmapLoader.ts`; used by URL-based hosts like PyCharm). Both converge on
  `viewer.addReconstruction`.
- **Host-agnostic bundle / the host bridge.** The webview never calls a
  host-specific API; it reads `window.__viewerHost` via
  `shared/hostBridge.getHostBridge()`. Each host installs that adapter before the
  bundle loads (VS Code: inline script in `panel.ts` `getHtml`). Keep
  `acquireVsCodeApi` and any Node/`vscode` import out of `shared`/`colmap`/`webview`
  — `npm run check` enforces it.
- **`colmap/` is pure** (no `vscode`, no DOM, **no Node `fs`/`path`**) so it stays
  unit-testable and reusable in the browser. New parsing/pose/bounds logic goes
  here with a test. Filesystem discovery/IO is host code (`host/colmapLoad.ts`),
  not part of this library.
- **CSP** (`host/panel.ts` getHtml): `default-src 'none'`; nonce'd script only;
  `img-src` + `connect-src` scoped to `webview.cspSource` (plus `blob:`/`data:`
  for images). Frustum images load via `<img>` (img-src); mesh loaders fetch via
  `connect-src`. If you add asset types/workers, update the CSP.
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

- **New scene element:** add a builder in `builders.ts` (or a layer class like
  `cameraLayer.ts`), wire it into `Viewer` (build/dispose/visibility/bounds), add
  a `Layer` key + a toggle in `controlPanel.ts` and a key in `main.ts`.
- **New host→webview message:** add to the union in `shared/messages.ts`, post
  from `host/panel.ts`, handle in `webview/main.ts`.
- **New mesh format:** add a loader case in `meshLayer.ts` and the extension to
  the picker `filters` in `host/extension.ts`.

## Build internals

- `esbuild.js`: extension entry `src/host/extension.ts`; webview entry
  `src/webview/main.ts`; test mode (`--test`) bundles `test/*.test.ts` → `out/test/`.
- `tsconfig.json`: `module: ESNext`, `moduleResolution: Bundler` (esbuild is the
  real bundler; needed for three's ESM example loaders). Lint covers `src` only.
- Packaging excludes (`.vscodeignore`): `src/`, `test/`, maps, `*.vsix`,
  `reinstall.sh`, `TODO.md`, `CLAUDE.md`. README + `media/` ship.

## Git

- Remote `origin` = `git@github.com:s-esposito/3DView.git`, branch `main`.
- Commit/push only when asked. End commit messages with the Co-Authored-By
  trailer used on existing commits.
