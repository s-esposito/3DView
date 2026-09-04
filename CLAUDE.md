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
  (`~/.conda/envs/groundsam3d/bin`). `.vscode/tasks.json` and
  `.vscode/settings.json` prepend it via `${env:HOME}` so VS Code tasks and
  integrated terminals work. In a raw shell, prepend it yourself.

Run from the repo root; npm workspaces orchestrate `@3dview/core`, `3dview`, and `3dview-demo`.
First time: `npm install` at the root (links the workspaces).

```bash
npm run build    # core → out/webview.js (+ check-boundaries); vscode → extension.js; demo → dist/demo.js + copies webview.js
npm run watch    # build core once, then watch-rebuild the extension
npm run lint     # tsc --noEmit in each package, sources AND tests (tsconfig.test.json,
                 # since tsconfig.json scopes the build to src) — MUST be clean:
                 # esbuild type-checks nothing, here or in the test bundle
npm run check    # boundary guard (host-agnostic core); also runs inside core's build
npm test         # esbuild --test per package, then node --test
./vscode_build.sh     # build monorepo + vsce package → vscode/*.vsix (then code --install-extension)
./jetbrains_build.sh  # build webview bundle + gradle buildPlugin → jetbrains/build/distributions/*.zip
```


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
                         (+ opensUris: whether this host can open files by path)
    naming.ts            compareNatural + sharedFolderName: how items opened together
                         are ordered and named, shared by the hosts and the webview
    uriList.ts           text/uri-list: the payload a drag that names files (rather
                         than handing over bytes) carries, decoded once for both the
                         webview's drop zone and a host's own drop targets
  src/colmap/            Pure COLMAP library: parsing + pose + bounds (byte buffers/strings)
    reader.ts            little-endian binary cursor
    cameras.ts/images.ts/points3d.ts   .bin + .txt parsers
    pose.ts              qvec/tvec → camera center (-R^T t) + worldFromCamera (R^T)
    bounds.ts            computeBounds(positions) → axis-aligned Bounds
    grouping.ts          pure path classification: basename/isImagePath +
                         groupColmapModels (a flat file list → the model trios in
                         it), shared by drag-drop and the demo's folder picker
    types.ts             Camera/Image/PointCloud + model→params, modelName()
    index.ts             pure public surface
  src/webview/           Browser UI (DOM + three) → out/webview.js
    main.ts              entry/glue: host bridge, message channel, keyboard, status
    colmapLoader.ts      loadColmapFromUrls(): fetch model files → pure parsers → ModelData
    dropZone.ts          drag-and-drop intake (all hosts): dropped files/folders → blob:
                         URLs → host-shaped loadColmap/addAsset, fed to main.ts's
                         handler; a drop carrying only URIs (a drag out of the
                         editor's file explorer) goes back to the host as openUris
    viewer.ts            Viewer: scene graph/camera/layers/global display — THE seam
    sceneLayer.ts        SceneLayer interface + ReconstructionLayer + DisplayOptions
                         (per-reconstruction) + AssetOptions (3DGS mode, track
                         trail/opacity/density — one object so the layer interface
                         doesn't grow a method per control)
    assetLayer.ts        AssetLayer (SceneLayer): loads a mesh (GLTF/OBJ/PLY), a bare
                         point cloud (.ply), a
                         3DGS splat (.ply/.splat/.spz/.ksplat) or 3D point tracks
                         (.npz/.npy) into a group, and rebuilds a
                         splat on a render-mode switch from its retained SplatCloud.
                         A .ply is one of three things, told apart by what is in it:
                         `f_dc_0`/`packed_position` in the header → splat, faces →
                         mesh, neither → point cloud (see the palette invariant).
                         Each mesh keeps its loaded (lit PBR, incl. GLB textures)
                         material + a derived unlit-albedo twin; "Shaded" swaps
                         between them (shaded is the default), "Wireframe" sets both
    temporalLayer.ts     TemporalLayer (SceneLayer): N frames — timesteps of one
                         capture — under one container, drawing one at a time, so
                         the Scene list holds one row with a timeline. Frames are
                         ordinary Reconstruction/Asset layers, unchanged — except a
                         3DGS sequence with a stable layout, which is ONE layer
                         swapping its buffer (a FrameSource; see below)
    splats.ts            3DGS: decodeSplats() (Spark, WASM in a worker) → SplatCloud,
                         then buildSplatObject() in one of three render modes —
                         "splatting" (default; a Spark SplatMesh adopting our packed
                         buffer, real per-view-sorted splatting drawn by the Viewer's
                         SparkRenderer), "ellipsoids" (one instanced icosphere per
                         Gaussian, opacity- and budget-culled), or
                         "points" (centers only). The latter two are approximations:
                         no per-view sort, SH, or alpha falloff
    tracks.ts            3D point tracks: decodeTracks() picks (steps, tracks, 3)
                         arrays + their visibility masks out of a NumPy archive,
                         buildTrackLines() draws one polyline per track in a single
                         LineSegments2 — a fat line, so a screen-px thickness takes
                         effect (time-major, so setTrackTrail() reveals a prefix of
                         the trail by capping instanceCount — no rebuild). Opacity
                         and width are material tweaks; density (a stable hashed
                         subset) and smoothTracks() (a Gaussian along time, over the
                         visible samples only) do rebuild
    npz.ts               dependency-free NumPy reader: .npy headers + the ZIP subset
                         np.savez writes (stored / raw-deflate via DecompressionStream)
    cameraLayer.ts       per-camera frustums (fat lines: LineSegments2/LineMaterial,
                         screen-px linewidth via setLineWidth) + image planes;
                         hover/select; lazy textures (cap)
    cameraInteraction.ts pointer pick/hover/select across layers + fly-to-POV
    builders.ts          pure three.js geometry builders + scene math (bounds, frustum
                         sizing, dispose)
    textures.ts          ThumbnailLoader: concurrency-limited, downscaling
    theme.ts             theme CSS var → THREE.Color (fallback when the var is unset)
    globals.d.ts         ambient types the bundle needs (__APP_VERSION__)
    ui/                  styles.ts, components.ts, controlPanel.ts (Scene list +
                         per-item timeline), overlays.ts (InfoPopup, model chooser,
                         temporal-grouping prompt)
  test/                  pure unit tests, run under `node --test`: colmap.test.ts
                         (parsers/poses/grouping), builders.test.ts (bounds + scene
                         math), splats.test.ts (3DGS render-mode geometry),
                         tracks.test.ts (NumPy reader + track polylines),
                         naming.test.ts, uriList.test.ts, temporal.test.ts
  scripts/check-boundaries.mjs   boundary guard (run by core's build)
vscode/                3dview — VS Code extension (Node + vscode) → out/extension.js
  src/host/
    extension.ts         activate(): commands (openReconstruction/openAsset/
                         openAssetFolder/openViewer), pickers, quick-pick
    colmapLoad.ts        fs discovery + load: detectFormat/findModelDirs/findImagesDir/loadModel (Node fs)
    panel.ts             ViewerPanel singleton: webview lifecycle, CSP, image URIs, scene-item
                         tracking (ids, + a group id for items opened in one action)
                         + replay; injects the VS Code __viewerHost adapter
    modelData.ts         parsed model → render-ready ModelData DTO
    recents.ts           the Activity Bar view: a recents launcher (workspaceState)
                         + the TreeView drop target that opens dropped URIs
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
(reconstructions + assets, where an asset is a mesh, a 3DGS splat, or 3D point
tracks) under a single
`root` group; helpers (grid/axes) and fit-to-view union over all layers. The UI
(`webview/ui/`) talks to the scene ONLY through the Viewer API (`addReconstruction`,
`addAsset`, `removeItem`,
`renameItem`, `setItemVisible`, `setItemTransform`/`resetItemTransform`,
`setGlobal`/`toggleGlobal`, `setPointSize`, `setFrustumScale`, `setFrustumLineWidth`,
`setFrustumColor`, `setTrackTrail`/`setTrackOpacity`/`setTrackDensity`/
`setTrackLineWidth`/`setTrackSmoothing`, `setSplatMode`/`toggleSplatMode`, `setFov`/`setRoll`/`resetCamera`,
`setOrientation`, `setTheme`, `resetView`, `exitPov`, `saveViewpoint`, `getState`,
`addTemporal`/`setItemFrame`/`setItemPlaying`/`setPlaybackFps`, +
`onSelect`/`onChange`/`onError`/`onFrame`/`onRequestAdd`/`onRemoveItem`/`onSaveImage`
callbacks) — never three.js directly. Adding
a new source = implement `SceneLayer`, add a `Viewer.addX`, and the
Scene list + global toggles adapt automatically. (3DGS arrived as a format inside
the existing `AssetLayer`, not a new layer — see `assetLayer.ts`.)

**A temporal item is one layer holding many** (`temporalLayer.ts`): N frames under
one container, **only the drawn one attached to it** (`.visible = false` is not
enough — Spark rebuilds its splat collection by walking the whole scene each update,
hidden meshes included, and runs per-mesh bookkeeping on every `SplatMesh` it finds,
so an undrawn frame it can still reach costs work on every rendered frame; detaching
costs Spark nothing, as it discovers meshes by traversal alone), so a capture's timesteps are a single Scene row
with a timeline instead of N rows drawn on top of each other. Its frames are
ordinary layers, so two rules follow. **`Viewer.drawnLayers()` is what the kind
filters read** — the top-level layers with a temporal item replaced by its drawn
frame — so nested frames stay reachable for picking, the texture budget and the
derived `hasX` flags, while the off-screen ones stay out of all three; `this.layers`
remains the source for the Scene list, bounds and the state fan-outs the container
forwards. And **a frame is re-synced when it becomes the drawn one**
(`syncLayerState` in `setItemFrame`): scene-wide state is pushed to layers when it
changes, and a hidden frame was not there to receive it. That is safe to do on every
switch, playback included, because both layer kinds rebuild only what actually
changed (`AssetLayer.applyAssetOptions` and `ReconstructionLayer.rebuildCameras` both
diff). Playback rides `animate()` rather than a timer of its own — see the
on-demand-rendering invariant.

**A 3DGS sequence plays back only if the mesh never changes.** Spark rebuilds its
splat collection from the scene each update and, whenever that collection's *mapping*
changes — a different mesh, or a different splat count — it withholds the new frame
until a full re-sort has landed (GPU→CPU depth readback + worker sort). One mesh per
frame therefore caps playback at one frame per sort: a slideshow. So when every frame
of a temporal item is 3DGS **and they share a packed layout** (same splat count, same
bytes per splat), the item is built as a single `AssetLayer` holding all the decoded
clouds (`adoptSplatFrames`) and scrubbing writes the next frame into that one mesh's
buffer (`splats.ts swapSplatCloud`): the mapping never changes, the frame shows at
once, and the re-sort follows behind it. Three rules come with it. Write the frame **into** the mesh's existing `packedArray` (`packedArray.set`), never
repoint it at the frame's own array — Spark then swaps the texture's data for a
`new Uint8Array(buffer)`, and this texture is RGBA32UI, so WebGL2 rejects the upload
and every frame silently renders as the first. The mesh therefore needs a buffer of
its own (`buildSplatMeshFrom`), or swapping would overwrite a frame's decoded data.
Keep the same `PackedSplats` object too — handing the mesh a *different*
`PackedSplats` rebuilds its generator, and Spark keys the compiled splat program on
generator identity, so that costs a shader compile per frame; and the layout check is
count **and** array length, since a differing SH degree changes the packed layout.
Anything else (mixed layouts, meshes, tracks, reconstructions) keeps the layer-per-frame
shape. The stale ordering is only invisible while consecutive frames are the same
Gaussians in motion; equal counts is evidence of that, not proof.

**Spark's renderer is the Viewer's, not a layer's.** "splatting" mode needs one
`SparkRenderer` in the scene — it gathers every visible `SplatMesh` each frame and
rasterizes them together. The Viewer creates it lazily on first use (it allocates GPU
accumulators) and adds it to `scene`, not `root`: its own transform is the origin
Spark encodes splat positions against, so it stays at identity. It fits the on-demand
loop through its `onDirty` callback — Spark fires it when a viewpoint sort or LoD
update lands, i.e. exactly when the last frame went stale — wired to `requestRender`.
Spark reads each mesh's `matrixWorld` and collects via `traverseVisible`, so per-item
transforms, the upright flip, and Scene-list show/hide all apply for free.

**Each layer carries its own placement.** `Viewer.setItemTransform` writes position /
rotation onto the layer's root group, so sources that don't share a coordinate frame
can be lined up by hand. Anything that turns layer-local data into world space must
therefore go through *that layer's* matrix, never the `root`'s: scene bounds
(`transformBounds`), fit-to-view, click-to-fly POV, and the frustum-texture LOD all do.

**Scene-item flow (multiple reconstructions + assets):** the host assigns each item
a stable `id` and tracks the list in `panel.ts`. The Scene "+" menu posts
`requestAdd` → host runs the matching command's picker → posts `addReconstruction`/
`addAsset` with the id. Removing an item (Scene list ✕) removes it webview-side and
posts `removed` so the host forgets it (won't replay it). Items opened by one action
(`ViewerPanel.openMany` — "all N models", a multi-file pick) also carry a **group
id**, travel as one `addGroup`, and are replayed together; `removed` matches an
item's id *or* its group's, so dropping a temporal item makes the host forget every
member. `addGroup` normally asks the user whether the members are one temporal item
or N separate ones; a host that **discovered** them itself (walking a per-frame
capture directory, so it already knows they are timesteps) answers in advance with
`grouping: "temporal" | "separate"`, and the modal is skipped. Omitted still asks, so
every host that does not set it behaves exactly as before. The group id lives on the panel's in-memory `Item`, never on `OpenTarget`,
which is the persisted Recents schema. Per-item controls are
visibility + remove; appearance (point/frustum size, images, grid, axes, orientation)
is global across the scene.

**Frustum size is measured, not guessed** (`frustumScaleFromDepth`, applied once in
`addReconstruction`). Each camera's frustum reaches `NEAR_FRACTION` of the way to
the nearest thing that camera actually sees: the cloud is projected into every
camera, points behind it or outside the image are dropped, and a low quantile is
taken of the depths — per camera, then across cameras, since one scale is drawn for
all of them. Sizing off the scene's diagonal instead (what this used to do) fails in
both directions: one far background point shrinks every frustum to nothing, and a
camera standing close to its subject gets one that buries it. The measurement
returns **0** when a model gives it nothing (no cloud, or cameras pointed away), so
the fallback stays where the policy belongs — at the `addReconstruction` seam, which
also caps the result at the slider's own `0.16 · diagonal` so the initial value is
one the slider can express.

**Drag-and-drop is a third, webview-owned intake path** (`dropZone.ts`), separate
from the host pickers — and what a drop carries decides which of two routes it takes.
**Bytes** (an OS file-manager drop): a sandboxed webview can read them but is never
told the filesystem *path*, so the webview reads them into `blob:` URLs and emits the
**same** `loadColmap`/`addAsset`/`addGroup` messages a host would (id self-assigned
`dnd-*`), converging on the same `main.ts` handler — it works identically in every
host with no host code and no CSP change (`blob:` is already allowed on
`connect-src`). Its by-design consequences: such items are NOT in the host's tracked
list, so they get no VS Code Recents entry and aren't replayed if the panel is ever
recreated, and images load in-memory rather than streamed on-demand. **URIs** (a drag
out of the editor's own file explorer, or of an editor tab): there are no bytes at
all, only `text/uri-list` (decoded by `shared/uriList.ts`, the one reader both the
webview and the hosts use), so the webview hands the URIs back to the host
(`openUris` → `ViewerPanel.onOpenUris` → `openDropped` in `extension.ts`, the same
funnel the Recents-tree drop and the Explorer right-click use) and the host opens
them by path — which is what restores Recents, replay and streamed images, and is
the *only* route that can work over a remote connection, where the dragged file
lives on the extension host and not on the machine running the webview. **A host
opts into that route at the bridge** (`HostBridge.opensUris`): only VS Code sets it,
so in the demo and PyCharm a URI drag isn't accepted at all and the overlay stays
dark — the drop zone never lights for a drop nothing can complete. Two VS Code facts
come with the route: such a drop only reaches a webview while **Shift** is held
(pointer events on the webview are suppressed mid-drag so the editor group wins the
drop — microsoft/vscode#182449, fixed in 1.91; the Explorer's right-click **Open in
3DView** needs no drag at all), and in a remote window the URIs are
`vscode-remote://…`, which `localUri` maps back to a plain path. Bytes win when a
drag somehow carries both, since an OS drag names paths on the machine running the
webview, not the one the host resolves against.
A drop holding several assets sends them as one `addGroup` (dropping a folder of
per-frame splats is how a temporal item is meant to arrive); a drop holding a COLMAP
model still wins outright over any asset files beside it, since a reconstruction tree
routinely carries `dense/fused.ply` and friends.

## Invariants & conventions (do not break)

- **Raw COLMAP axes (upright by default).** Points/poses stay in COLMAP's
  +x-right/+y-down/+z-forward world frame — never mutated. The "upright (U)"
  toggle (defaults **on**) only rotates `root` 180° about X for viewing;
  fit-to-view re-bounds in world space. The Viewer applies the default
  orientation at construction (`applyOrientation`), so the flip is present before
  any content loads.
- **Color theme (light/dark/dim).** `Viewer.setTheme` sets
  `document.body.dataset.viewerTheme`; the `body[data-viewer-theme=…]` blocks in
  `styles.ts` **override the `--vscode-*` vars** the UI reads (so every rule
  retones with no churn) plus the `--glass-reflex-*` rim knobs. The viewer also
  re-reads `--vscode-editor-background` to retint the 3D viewport. The constructor
  applies the default (`dark`) **before** first reading that var. It's webview-only
  state (no host message); the `controlPanel.ts` switcher reads `getState().theme`.
- **On-demand rendering (don't freeze the view).** `viewer.ts animate()` only
  calls `renderer.render` when `controls.update()` reports motion (incl. damping)
  OR `needsRender` is set. Anything that changes what's on screen *without moving
  the camera* MUST call `requestRender()` — every Viewer mutator
  (`setGlobal`/`setPointSize`/`setFrustumScale`/`setFrustumLineWidth`/`setTrack*`/
  `setFrustumColor`/`setFov`/`setRoll`/`setItemVisible`/`fitCamera`/`rebuildHelpers`/
  `onResize`), interaction hover/select/deselect (via
  `InteractionDeps.requestRender`), and async texture load/evict (via
  `CameraLayer`'s `onTextureChange` → `Viewer.requestRender`). Forgetting this
  leaves the view frozen until the next interaction. Don't also add an
  OrbitControls `'change'` listener — `update()` already covers damping.
- **Camera roll (tilt) rides on top of OrbitControls.** `animate()` applies the
  roll as `camera.rotateZ` *after* `controls.update()`, every frame. `update()`
  unconditionally rewrites the orientation from target + up (`lookAt`) each call,
  so the roll re-composes fresh and never accumulates, and orbit/pan/zoom are
  untouched (they own the un-rolled orientation). FOV is a plain
  `camera.fov`/`updateProjectionMatrix`. Both are webview-only camera state (no host
  message); `resetCamera` returns them to defaults (`DEFAULT_FOV`, roll 0).
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
  `loadColmap` (host ships a `ColmapModelRef` — URLs — the webview fetches +
  parses via `colmapLoader.ts`; used by URL-based hosts like PyCharm + drag-drop).
  Both converge on `viewer.addReconstruction`. When several models are found
  (`sparse/0`, `sparse/1`, …) the user picks one/some/all: the **native** hosts
  (VS Code quick-pick, PyCharm JBPopup) choose host-side and open the chosen dirs;
  the **browser** hosts (web demo + drag-drop), lacking a native dialog, send
  `chooseColmap` (a `ColmapModelRef[]`) and the webview shows a modal chooser
  (`overlays.ts showColmapChooser`), loading each picked model via `loadColmap`'s
  path and revoking the unpicked models' blob: URLs. Meshes, point clouds and 3DGS splats all arrive as **`addAsset`**
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
- **A panel scrolls in its body, and nowhere else.** Every host sets
  `html,body{overflow:hidden}`, so anything a panel pushes past the viewport is
  unreachable: `.viewer-body` carries the `--viewer-panel-max` cap and the scroller
  (the rule's own comment in `styles.ts` has why it must be that box, and why the cap
  is halved-viewport rather than a flat 40vh). `ControlPanel.render()` rebuilds the
  whole UI, so it carries each body's `scrollTop` across — like `transformOpen` and
  `playheads`.
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
- **Image-plane alpha remap** (`builders.ts buildImagePlane`, `patchImagePlaneAlpha`):
  the frustum image plane blends by the image's **own** alpha, per-pixel — opaque
  pixels keep their color at full opacity; fully-transparent pixels become white at
  `IMAGE_ALPHA_FLOOR` (0.5); in between interpolates. So a masked-out region reads
  as a faint white fill instead of vanishing. Done via a `MeshBasicMaterial`
  `onBeforeCompile` that rewrites `<map_fragment>` (keeps three's sRGB decode/encode,
  since the sampler returns linear and `vec3(1.0)` is white in linear too), with a
  `customProgramCacheKey` so it never shares a program with a plain textured
  material. The material's `opacity` stays the load/evict show-hide gate (1/0) and
  multiplies the result — don't repurpose it for translucency.
- **One palette color per scene ITEM, not per layer** (`builders.ts CLOUD_PALETTE`
  / `cloudColor`). A point cloud with no per-vertex colors of its own is drawn in a
  palette color, so two uncolored clouds in one scene are tellable apart. The turn
  is taken by the **Viewer** (`colorTurn`), once per item, and handed to the
  `AssetLayer` constructor — a temporal item takes ONE and passes it to every frame,
  because its frames are timesteps of one capture and must not change color as it is
  scrubbed. Don't move the counter into `AssetLayer` (a sequence would then strobe)
  and don't key it off the file name (two names can collide; the point is distinctness,
  not stability). An uncolored *mesh* keeps its neutral grey — it is read by its
  shading, not its tint.
- **"Point size" is one slider over two option bags**, all three defaults seeded from
  `builders.DEFAULT_POINT_SIZE`. Reconstruction clouds read `DisplayOptions.pointSize`;
  asset clouds read `AssetOptions.pointSize` (a plain PLY cloud, and a 3DGS asset in
  `points` mode). `Viewer.setPointSize` writes both and fans out. Size is **never** a
  build parameter — builders seed the default and `AssetLayer` applies the live value
  in `attachCurrent` (so a rebuild — mode switch, frame swap — comes back right) and
  in `applyAssetOptions` **only when it changed**, since `setPointsSize` walks the
  object where the track setters next to it are O(1). Same rule as `trackTrail` /
  `trackOpacity` / `trackLineWidth`: build parameters are what change which primitives
  exist or where they are (`trackDensity`, `trackSmoothing`, `splatMode`), material
  tweaks are re-applied on attach. The slider
  shows when `hasPoints || hasPointCloud`; `hasPointCloud` comes from a flag recorded
  at load time (beside `cloud`/`tracks`), not from the built object, so it doesn't
  flip as E cycles the render mode.
- **Don't preset a bounding sphere on loader-produced geometry.** `PLYLoader` already
  calls `computeBoundingSphere()`, and its sphere is fitted to the points; replacing it
  with one around the AABB costs the same scan for up to √3 the radius, i.e. strictly
  looser culling. `buildColoredPoints` presetting from `Bounds` is the *correct* use of
  that pattern — it builds the geometry itself, so there is nothing to overwrite.
- **Precision caveat:** point positions are downcast float64→float32 in
  `points3d.ts` (~7 sig digits). Fine for normalized scenes; revisit for
  geo-referenced coordinates (would need an origin offset).
- **Multi-file picking isn't available in every host.** VS Code substitutes its own
  file dialog over a **remote connection** (Remote-SSH / WSL / Codespaces), and that
  dialog ignores `canSelectMany` — only one file can be picked. Hence the
  `"assetFolder"` `AddKind`: it picks a *folder* and opens every asset file directly
  inside it (natural order) as one action, which is the only way into a per-frame
  capture in a remote window. Don't "simplify" it by letting the asset dialog accept
  folders too — a **native** dialog on Windows/Linux cannot offer files and folders
  at once (Electron falls back to a directory-only selector), which would break
  single-file picking for local users.
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
- **New asset format:** add a loader case in `assetLayer.ts`, the webview drop
  filter `ASSET_EXTS` in `core/src/webview/dropZone.ts` (the drag-and-drop path,
  shared by all hosts), and the picker filter in each host — `ASSET_EXTS` in
  `vscode/src/host/extension.ts` (plus the `explorer/context` `when` clause in
  `vscode/package.json`, which spells the same list out for VS Code's expression
  language), `input.accept` in `demo/src/host.ts`, and
  `ASSET_EXTS` in `jetbrains/.../ColmapViewerService.kt`. Splat formats decode
  through Spark; meshes through three's loaders; NumPy tracks through the local
  `npz.ts` reader. Also add it to `ASSET_KIND_EXTS` in `core/src/shared/messages.ts`
  (the one source every host filters by, and what the Scene "+" entries map to) and
  its Kotlin mirror. The kind only picks a filter: what an asset *is* comes from the
  file, so loading still works whichever entry was used.

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
  **`out/test/`** (the test bundle `npm test` leaves behind — `test/**` alone matches
  only the source dir, and the built tests shipped in the .vsix until it was added),
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
