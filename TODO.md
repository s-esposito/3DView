# 3DViewer — Handoff / TODO

A handoff doc for picking up this VS Code extension. Read this top-to-bottom and
you should be able to continue without re-discovering anything.

## What this is

A VS Code extension that views **COLMAP reconstructions** in the editor as a
colored point cloud with camera poses. UX target is the
[viser COLMAP visualizer](https://viser.studio/main/examples/demos/colmap_visualizer/)
(colored points + camera frustums, orbit controls).

- Folder/git repo: `colmapview/` (sibling of `sam-3d-objects`, its own git repo, branch `main`).
- App/display name: **3DViewer**. npm `name` is `3dviewer` (must be lowercase).
  Note the deliberate mismatch: the *folder* is `colmapview`, the *app* is `3DViewer`.
  Don't "fix" it unless asked.

## Current status: VIEWER WORKS END-TO-END (foundation = commit `c4e917f`)

The extension builds, typechecks, runs, and **renders**. *3DViewer: Open
Reconstruction* (also the activity-bar view's welcome button) opens a folder
picker, locates the model (quick-pick if several), parses it host-side, and
draws the colored point cloud + camera frustums in a Three.js webview with orbit
controls, fit-to-view, and a point-size / frustum-size overlay.

The **COLMAP parsing + pose math layer** is pure / `vscode`-free and unit-tested
(`src/colmap/`, 11 tests in `test/colmap.test.ts`, `npm test`). Remaining work is
**polish** (see Roadmap step 5) and the post-v1 features (meshes, 3DGS).

### Design decisions (locked)
- **Up axis: raw COLMAP frame, no rotation.** The parser keeps poses/points in
  COLMAP's native +x-right/+y-down/+z-forward world frame; the render step must
  *not* apply an up-flip. `src/colmap/pose.ts` documents this.
- **Multi-model: auto-locate + quick-pick.** `findModelDirs()` returns every
  model dir at/under the picked folder (`root`, `root/sparse`, and one level of
  subdirs → catches `sparse/0`, `sparse/1`, …). The command should `showQuickPick`
  when more than one is found and load a single model.

## Architecture

Two bundles that talk only via `postMessage`, plus shared types and a pure
parsing layer. Source is split by **runtime domain** so dependencies only point
"inward" (webview/host → shared; host → colmap; nothing imports the webview):

```
src/
  shared/messages.ts   Message contract + DTOs. The ONLY module both runtimes
                       import — keep it free of vscode / Node / DOM / three.
  colmap/              Pure COLMAP parsing + pose math + fs locate/load.
                       No vscode. Unit-tested in test/colmap.test.ts.
  host/                Extension host (Node + vscode). → out/extension.js
    extension.ts         activate(): command, folder picker, quick-pick.
    panel.ts             singleton ViewerPanel: webview lifecycle, CSP, image URIs.
    modelData.ts         pure: parsed model → render-ready ModelData.
  webview/             Browser UI (DOM + three). → out/webview.js
    main.ts              entry/glue: message channel, keyboard, status text.
    viewer.ts            Viewer: scene graph, camera, interaction, POV. Exposes
                         a small imperative API + onSelect callback.
    cameraLayer.ts       per-camera frustums + image planes; hover/select/pick;
                         lazy distance-based texture loading (resident cap).
    builders.ts          pure three.js geometry builders + scene math.
    textures.ts          ThumbnailLoader: concurrency-limited, downscaling.
    theme.ts             VS Code theme color → THREE.Color.
    ui/                  presentation: styles.ts, components.ts, controlPanel.ts,
                         overlays.ts (info popup + back button).
```

- **Dependency rule:** `shared/` depends on nothing; `colmap/` only on `shared`-free
  pure code; `host/` on `colmap` + `shared`; `webview/` on `shared` + three. The UI
  (`webview/ui/`) talks to the scene only through the `Viewer` API — never reaches
  into three.js directly — so the GUI and renderer evolve independently.
- Build: `esbuild.js` — extension entry `src/host/extension.ts` (node/cjs, `vscode`
  external), webview entry `src/webview/main.ts` (browser/iife). Tests bundle to
  `out/test/` via `--test`.
- Extending: a new scene element = a builder in `builders.ts` (or a layer class)
  wired into `Viewer`, plus a toggle in `controlPanel.ts`. A new host→webview
  message = add to the `messages.ts` union and handle in `main.ts`. This is the
  seam the post-v1 mesh / 3DGS layers should plug into.

## Build / run / verify

```bash
cd colmapview
npm install
npm run build      # or: npm run watch
npm run lint       # tsc --noEmit, must exit 0
```

F5 in VS Code (launch config "Run Extension") → Extension Development Host →
Command Palette → *3DViewer: Open Reconstruction*.

Tests: `npm test` bundles `test/*.test.ts` (esbuild, `node esbuild.js --test`) to
`out/test/` and runs them under `node --test`. Current suite covers the pure
COLMAP parser + pose math (no VS Code needed). If/when behavior that touches the
`vscode` API needs testing, add `@vscode/test-electron` separately.

## Roadmap (suggested order)

1. ~~**COLMAP parsing** (`src/colmap/`)~~ **DONE.** `cameras`/`images`/`points3D`
   in both `.bin` and `.txt`. Pure functions, unit-tested. See `src/colmap/`:
   `reader.ts` (LE cursor), `cameras.ts`, `images.ts`, `points3d.ts`, `types.ts`
   (model→param tables + intrinsics derivation), `load.ts` (fs locate + load),
   `index.ts` (public surface).
2. ~~**Pose math** (`src/colmap/pose.ts`)~~ **DONE.** `qvec`(wxyz)+`tvec` →
   camera center `-R^T·t` and world-from-camera basis `R^T`. Computed host-side;
   the webview will only ever see world-space data, never quaternions.
3. ~~**Open UX**~~ **DONE.** `extension.ts`: `showOpenDialog` folder picker →
   `findModelDirs` → `showQuickPick` if >1 → `ViewerPanel.createOrShow(ctx, dir)`.
4. ~~**Render**~~ **DONE.** `panel.ts` parses host-side (`loadModel` +
   `imagesToPoses`), computes bounds, and posts a `model` message; `webview/main.ts`
   draws `THREE.Points` (vertex colors), frustum `LineSegments` (from `center` +
   `worldFromCamera` + intrinsics), `OrbitControls`, fit-to-view, and a controls
   overlay. **No up-axis flip** (raw COLMAP frame). `three` is a dependency.
   NOTE: VS Code's `webview.postMessage` has **no transfer-list arg** — typed
   arrays are structured-cloned (copied), not transferred. Fine for now; revisit
   if huge clouds stress memory.
5. **Polish (partly done)**: DONE — view toggles (points/frustums/images/axes/
   grid), metric world grid, reset-view, raw↔upright-Y-up orientation toggle,
   keyboard shortcuts (R/P/F/I/A/G/U, Esc), theme-aware background/overlay, and
   graceful empty-cloud / error states (all in `webview/main.ts`; everything
   renders under a `root` group so the orientation toggle just rotates it and
   fit-to-view re-bounds in world).
   STILL TODO — incremental load progress for large `points3D`/`images`
   (currently one spinner), decimation/streaming for multi-million-point clouds,
   texture budget/lazy-by-distance for large image sets, remembering last-opened
   folder, per-camera labels.

### Images in frustums + clickable cameras (DONE)
- Host locates the source images via `findImagesDir(root, modelDir)` (probes
  `<root>/images`, `<modelDir>/images`, and one/two levels up). The dir is added
  to the panel's `localResourceRoots`; `panel.ts attachImageUris()` resolves each
  camera's file to a `webview.asWebviewUri` string (`CameraView.imageUri`), with a
  path-escape guard. `localResourceRoots` is fixed at panel creation, so opening a
  model whose images live elsewhere **recreates** the panel (`createOrShow`).
- Webview builds one `THREE.Group` per camera (`buildCameras`): frustum
  `LineSegments` + a textured image-plane `Mesh` (lazy `TextureLoader`). Picking
  raycasts that group (`pointerup`, drag-vs-click guarded); selection highlights
  the frustum and opens an HTML info popup (image + id/model/resolution/intrinsics/
  center). Toggle images with **I**; large sets are heavy (one texture/HTTP per
  image) — that's the texture-budget TODO above.

## Future (post-v1, requested — design for extensibility now)

These are **not v1**, but the scene/message architecture should not preclude them:
1. ~~**Mesh viewing**~~ **DONE** (multiple reconstructions + meshes in one scene).
   A scene is a list of `SceneLayer`s (`ReconstructionLayer` / `MeshLayer`). The
   **Scene** panel section lists items with show/hide + remove and a **"+"** menu
   to add a reconstruction or mesh; the "+" posts `requestAdd` → host runs the
   picker → `addReconstruction`/`addMesh` (id-keyed). Meshes load `.glb/.gltf/.obj/
   .ply` (`meshLayer.ts`); scene lighting added for lit materials. Loading uses
   `asWebviewUri` + `connect-src`. `host/panel.ts` tracks the item list and replays
   it after a `localResourceRoots` recreate. STILL TODO: OBJ **.mtl/textures**
   (default material only), PLY large-cloud handling, per-item transform UI.
2. **3D Gaussian Splatting** (à la the *gaussian-viewer*): render `.ply`/`.splat`
   3DGS reconstructions. This needs a splat rasterizer (custom shaders / sorting),
   which is heavier than `THREE.Points` and may warrant a dedicated renderer
   module rather than bolting onto the point-cloud path.

Implication for v1: keep the webview render code modular (a `Scene` that owns
swappable "layers") and keep `messages.ts` generic enough to carry more than just
COLMAP point data. Don't build these now — just don't paint into a corner.

## COLMAP binary format (little-endian) — for step 1

`cameras.bin`: `uint64 num` then per camera: `uint32 camera_id`, `int32 model_id`,
`uint64 width`, `uint64 height`, `float64[num_params] params`.
Params-per-model by id: 0→3, 1→4, 2→4, 3→5, 4→8, 5→8, 6→12, 7→5, 8→4, 9→5, 10→12.
For frustum intrinsics: single-focal models {0,2,3,7,8,9} → `fx=fy=params[0]`,
`cx=params[1]`, `cy=params[2]`; dual-focal {1,4,5,6,10} → `fx=params[0]`,
`fy=params[1]`, `cx=params[2]`, `cy=params[3]`.

`images.bin`: `uint64 num` then per image: `uint32 image_id`, `float64×4 qvec`
(qw,qx,qy,qz), `float64×3 tvec`, `uint32 camera_id`, null-terminated `char* name`,
`uint64 num_points2D`, then per point2D: `float64 x`, `float64 y`, `uint64 point3D_id`.

`points3D.bin`: `uint64 num` then per point: `uint64 point3D_id`, `float64×3 xyz`,
`uint8×3 rgb`, `float64 error`, `uint64 track_len`, then per track elem:
`uint32 image_id`, `uint32 point2D_idx`.

Text format mirrors this with `#`-comment headers; see
<https://colmap.github.io/format.html>.

## Conventions / gotchas

- Keep `src/shared/messages.ts` the single source of truth for the message contract.
- Webview can't load arbitrary files — read files host-side (Node `fs`), parse,
  and `postMessage` typed arrays (use transferables for large buffers).
- CSP in `panel.ts` only allows the nonce'd script + `webview.cspSource` styles/
  images. If you add assets/workers, update the CSP.
- Don't commit unless asked. End commit messages with the Co-Authored-By trailer
  already used on `c4e917f`.

## Done so far

- [x] Scaffolding: `package.json`, `tsconfig.json`, `esbuild.js`, `.gitignore`, `.vscodeignore`
- [x] Debug/build tooling: `.vscode/launch.json`, `.vscode/tasks.json`
- [x] Extension skeleton: `activate()`, open command, `ViewerPanel`, ready handshake
- [x] README + initial commit
- [x] COLMAP parser + pose math (`src/colmap/`), bin + txt, `vscode`-free
- [x] Test runner (`npm test`, esbuild + `node --test`) + 11 parser/pose tests
- [x] Activity-bar container + view + welcome button (`media/icon.svg`)
- [x] Open UX: folder picker + multi-model quick-pick
- [x] Render: Three.js point cloud + frustums + orbit + fit + controls overlay
- [x] Polish: view toggles, reset, orientation toggle, keyboard, theming, empty/error states
- [x] Metric world grid (1-unit cells, integer-aligned)
- [x] Bounding box around the point cloud (toggle B)
- [x] Images textured into frustums + clickable cameras with info popup
- [x] Frustum hover highlight; click → fly to that camera's POV (+ Back / Esc)
- [x] GUI overhaul: injected stylesheet, sectioned + collapsible panel (click
      header), 2-col toggle grid, live slider readouts, themed hover states
- [x] Texture perf: downscaled thumbnails + concurrency limit, then lazy
      distance-based loading with a resident cap (`cameraLayer.ts`)
- [x] Modular refactor: split runtime domains (shared/host/webview) and broke the
      webview monolith into Viewer + layers + ui modules (see Architecture)
- [x] Open empty viewer (default grid scene) + activity-bar button
- [x] Scene of multiple reconstructions + meshes: SceneLayer abstraction, Scene
      panel (add via "+", per-item show/hide + remove), cross-layer pick/POV
      (`cameraInteraction.ts`)
- [x] Bounding box around meshes too (global Box toggle spans all layers)
- [x] Large-cloud perf: on-demand rendering (dirty-flag + `requestRender`),
      pixel-ratio cap (1.5), precomputed bounding sphere, parser skip reads /
      no file copy / flattened bounds. STILL TODO: host-side decimation + a
      max-points VS Code setting (BI-2); interaction-time LOD (BI-3, if needed)
- [ ] Roadmap step 5 (remaining): load progress, large-cloud + texture-budget handling, last-folder memory
