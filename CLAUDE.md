# CLAUDE.md — internal development guide

Internal architecture/convention reference for working on this codebase. Claude
Code auto-loads this file each session, so it is the single source of truth for
"how this project is built." **Keep it current: whenever you change architecture,
module responsibilities, invariants, build/commands, or conventions, update this
file in the same change.** Roadmap/status lives in [TODO.md](TODO.md); user-facing
docs live in [README.md](README.md).

## Names (intentional, don't "fix")

- Local folder: `colmapview` · npm `name`: `3dviewer` (must be lowercase) ·
  display name / commands: **3DViewer** · GitHub repo: `s-esposito/3DView`.
  These differing names are deliberate.

## Environment / commands

- **Node/npm are not on the system PATH** — they live in a conda env
  (`~/.conda/envs/sam3d-objects/bin`). `.vscode/tasks.json` and
  `.vscode/settings.json` prepend it via `${env:HOME}` so VS Code tasks and
  integrated terminals work. In a raw shell, prepend it yourself.

```bash
npm run build    # esbuild → out/extension.js (node/cjs) + out/webview.js (browser/iife)
npm run watch    # rebuild on change
npm run lint     # tsc --noEmit -p ./  — MUST be clean (esbuild does not type-check)
npm test         # node esbuild.js --test → out/test/, then node --test
./reinstall.sh   # build + vsce package + code --install-extension --force
```

Always run `npm run lint && npm run build && npm test` after changes; all three
must pass before considering work done.

## Architecture — runtime domains

Two bundles that talk only via `postMessage`, plus shared types and a pure
parsing layer. Dependencies point inward only.

```
src/
  shared/messages.ts   Message contract + DTOs. The ONLY module imported by both
                       runtimes — keep it free of vscode / Node / DOM / three.
  colmap/              Pure COLMAP parsing + pose math + fs locate/load. No vscode.
                       Unit-tested in test/colmap.test.ts.
    reader.ts            little-endian binary cursor
    cameras.ts/images.ts/points3d.ts   .bin + .txt parsers
    pose.ts              qvec/tvec → camera center (-R^T t) + worldFromCamera (R^T)
    types.ts             Camera/Image/PointCloud + model→params, modelName()
    load.ts              detectFormat, findModelDirs, findImagesDir, loadModel (fs)
    index.ts             public surface
  host/                Extension host (Node + vscode). → out/extension.js
    extension.ts         activate(): commands (openReconstruction/openMesh/openViewer),
                         folder/file pickers, quick-pick
    panel.ts             ViewerPanel singleton: webview lifecycle, CSP, image URIs,
                         scene-item tracking (ids) + replay (see invariants)
    modelData.ts         pure: parsed model → render-ready ModelData DTO
  webview/             Browser UI (DOM + three). → out/webview.js
    main.ts              entry/glue: message channel, keyboard, status text
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
    theme.ts             VS Code theme CSS var → THREE.Color
    ui/                  styles.ts (injected CSS), components.ts (dom helpers incl.
                         iconButton/menuButton), controlPanel.ts (Scene list + global
                         controls), overlays.ts (InfoPopup + BackButton)
```

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
  `main.ts`. Keep it dependency-free.
- **`colmap/` is pure** (no `vscode`, no DOM) so it stays unit-testable. New
  parsing logic goes here with a test.
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
