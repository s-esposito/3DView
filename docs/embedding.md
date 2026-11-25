# Embedding 3DView

3DView can be put on any web page: a reconstruction, a mesh, 3D Gaussian splats or a sequence of
them, with the full viewer UI or a pared-down showcase, driven from the page by messages.
This page is the complete reference for that API: every URL parameter, configuration field,
message and event is listed here (a test fails if one is missing).

- **Base URL:** `https://s-esposito.github.io/3DView/v2/`. The `/v2/` pins the major version:
  everything below works the same for every 2.x release.
- **API version:** `2.0.0` ships API version `1`. It goes up whenever something is added; see
  [Versions](#versions).

## Contents

1. [Quick start](#quick-start): an iframe, the SDK, or the bundle in your own page
2. [Concepts](#concepts): items and ids, the scene's frame, files and CORS, before `ready`, versions
3. [embed.html URL parameters](#embedhtml-url-parameters)
4. [The SDK (embed.js)](#the-sdk-embedjs)
5. [Configuration](#configuration): how it looks, the UI, what a person may do
6. [Messages](#messages): page → viewer
7. [Events and replies](#events-and-replies): viewer → page
8. [Recipes](#recipes)
9. [Migrating from 1.x](#migrating-from-1x)

## Quick start

There are three ways in. All three speak the same protocol; they differ only in how much you write.

### 1. An iframe, no JavaScript

```html
<iframe
  src="https://s-esposito.github.io/3DView/v2/embed.html?asset=https://example.org/models/mug.glb&preset=presentation"
  style="width: 640px; height: 480px; border: 0"></iframe>
```

The URL says what to show and how; see [embed.html URL parameters](#embedhtml-url-parameters).
The files must be reachable from the viewer's origin; see [files and CORS](#files-and-cors).

### 2. The SDK

```html
<div id="viewer" style="width: 640px; height: 480px"></div>
<script src="https://s-esposito.github.io/3DView/v2/dist/embed.js"></script>
<script>
  ThreeDView.mount("#viewer", {
    config: { preset: "presentation", theme: "light" },
    items: [{ url: "models/mug.glb", id: "mug" }],   // relative URLs resolve against this page
  }).then(async (viewer) => {
    viewer.on("selected", (e) => console.log("selected", e.id));
    const id = await viewer.add({ colmap: "scenes/desk/sparse/0", images: "scenes/desk/images" });
    const png = await viewer.capture({ scale: 2 });
  });
</script>
```

`ThreeDView.mount` makes the iframe of option 1 and gives back an object with a method per
message and promises for the answers. See [The SDK](#the-sdk-embedjs).

### 3. The bundle in your own page

This is how the VS Code and PyCharm extensions host the viewer. Load the viewer bundle
(`/v2/dist/webview.js`) into a page you control, and install a *host bridge* before it runs:

```html
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  canvas { display: block; position: fixed; top: 0; left: 0; }   /* the viewer's, sized to the window */
</style>
<div id="status"></div>
<script>
  window.__viewerHost = {
    config: { preset: "presentation" },            // optional: Configuration, before the first frame
    postMessage(msg) { console.log("viewer says", msg); },   // events and replies
  };
</script>
<script src="https://s-esposito.github.io/3DView/v2/dist/webview.js"></script>
<script>
  // Messages go to the window the viewer runs in. The bundle posts `ready` as its script
  // finishes running, so a script after it may send at once.
  window.postMessage({ type: "addAsset", id: "mug", label: "Mug",
                       asset: { uri: "models/mug.glb", name: "mug.glb" } }, "*");
</script>
```

The viewer appends its canvas to the body and sizes it to the window, so it takes the whole
page. Put it in its own page, and that page in an iframe if it must share the screen. `#status`
is where it writes loading progress and errors; style it as you like. The bridge may also declare:
- `savesFiles: true`: the host saves captures itself, from `saveFile` events. Without it the
  viewer downloads them in the page.
- `opensUris`, `opensArchives`: hosts that own a filesystem, see [IDE host messages](#ide-host-messages).

## Concepts

### Items and ids

Everything in the scene is an **item**: a COLMAP reconstruction, one asset file, or a
**sequence** (several files shown one at a time, with a timeline). The page names each item with
an `id` of its choice when adding it. Every later message about the item and every event
about it carry that id. A sequence's members get the ids `<id>/0`, `<id>/1`, …; messages and
events use the sequence's own id. Ids should be unique; adding a second item with an id in use is
not supported.

### The scene's frame

Positions, matrices and bounds in messages are in the **scene's frame**: COLMAP's, with +x right,
+y **down** and +z forward. Files are placed in it as they are. The viewer shows the scene
upright (+y up on screen) by turning it 180° about x. That is a view setting (`upright` in the
[Configuration](#configuration)) and never changes the numbers in messages. To place the camera, give
`setView` a position and a target in the scene's frame.

### Files and CORS

The viewer fetches the files itself, from inside the iframe. Files on another origin than the
viewer (`s-esposito.github.io`) must be served with `Access-Control-Allow-Origin`; GitHub Pages
does this for every file. Relative URLs:
- in `embed.html`'s parameters, they resolve against embed.html itself. Use absolute URLs there.
- in the SDK, they resolve against your page.

Formats:

| Kind | Extensions | Notes |
|------|-----------|-------|
| Mesh | `.glb` `.gltf` `.obj` `.ply` | glTF with its textures; a `.gltf`'s side files resolve next to it |
| Point cloud | `.ply` | a `.ply` with points only |
| 3D Gaussian splats | `.ply` `.splat` `.spz` `.ksplat` | a `.ply` with a 3DGS header |
| Point tracks | `.npz` `.npy` | 3D tracks over time |
| Breakable physics object | `.npz` | holding `physics_scene` + `physics_splats` (the README's Features) |
| COLMAP model | a folder with `cameras`, `images`, `points3D` (`.bin` or `.txt`) | photos from a separate folder |

A `.ply` is told apart by what it holds, not by its name.

### Before `ready`

The viewer listens for messages from its `ready` event on; anything sent before is lost. The SDK
holds messages until then for you.

### Versions

- **Pin the major.** Load from `/v2/`. Unversioned paths (`/dist/webview.js`) follow the latest
  release and will break a page at the next major.
- **Within a major, the API only grows.** New messages, events, fields and parameters may appear;
  none are removed or change meaning.
- **Unknown things are ignored.** The viewer ignores message types and fields it does not know;
  a page should ignore event types and fields it does not know.
- **Feature-detect with `apiVersion`.** The `ready` event (and the SDK's `viewer.apiVersion`)
  carries it. Each section below notes the API version a feature arrived in when it is above 1.

## embed.html URL parameters

`https://s-esposito.github.io/3DView/v2/embed.html?<parameters>`. All are optional. The item
parameters can repeat, and items are added in the order of their parameters.

| Parameter | Value | Example |
|-----------|-------|---------|
| `asset` | a file URL: one item | `asset=https://x.org/mug.glb` |
| `colmap` | a COLMAP model folder URL (`.bin` files): one item | `colmap=https://x.org/desk/sparse/0` |
| `sequence` | file URLs, comma-separated: one item with a timeline | `sequence=https://x.org/f0.ply,https://x.org/f1.ply` |
| `items` | JSON array of [items](#items), for ids, labels, `.txt` models, photos | `items=[{"url":"https://x.org/a.glb","id":"a","label":"Mug"}]` |
| `view` | camera position and target, six numbers `px,py,pz,tx,ty,tz` ([scene frame](#the-scenes-frame)) | `view=0,-1,-4,0,0,0` |
| `config` | JSON [Configuration](#configuration) | `config={"ui":{"panels":false}}` |
| `preset` | a configuration preset, over `config` | `preset=presentation` |
| `theme` | `light` \| `dark` \| `dim`, over `config` | `theme=light` |
| `background` | a CSS colour, over `config` (`%23` for `#`) | `background=%23ffffff` |

Ids default to `item-1`, `item-2`, … in parameter order, and labels to the file or folder name.
A malformed parameter shows its error in the viewer and adds nothing. URL-encode values that hold
`&`, `#` or `+`.

embed.html posts every [event](#events-and-replies) to the page that embeds it (`window.parent`),
and takes [messages](#messages) posted to its window:

```js
const frame = document.querySelector("iframe");
window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow) return;        // another frame's, or not the viewer's
  if (e.data.type === "ready") frame.contentWindow.postMessage({ type: "selectItem", id: "item-1" }, "*");
});
```

Wait for `ready` before sending (see [Before `ready`](#before-ready)).

## The SDK (embed.js)

`<script src="https://s-esposito.github.io/3DView/v2/dist/embed.js"></script>` defines the global
`ThreeDView`. It loads the `embed.html` of its own major.

### `ThreeDView.mount(target, options?) → Promise<EmbeddedViewer>`

Puts the viewer in `target` (an element or a CSS selector), as an iframe filling it. The promise
resolves when the viewer is ready.

| Option | Type | |
|--------|------|-|
| `config` | [Configuration](#configuration) | applied before the first frame |
| `items` | [Item](#items)`[]` | added at once; watch `itemLoaded` / `itemFailed` for them |
| `view` | `{ position: [x,y,z], target: [x,y,z] }` | the starting camera, [scene frame](#the-scenes-frame) |
| `src` | string | another embed.html to load (self-hosting) |

### Items

The object `add()`, `items` and the `items` URL parameter take. One of:

```ts
{ url: string, id?: string, label?: string }                          // one file
{ colmap: string, format?: "bin" | "txt", images?: string, id?: string, label?: string }
                                                                      // a COLMAP model folder; images: its photos' folder
{ sequence: string[], id?: string, label?: string }                   // files as one item with a timeline
```

### `EmbeddedViewer`

Each method sends the [message](#messages) of the same name; `add` sends `addAsset`,
`loadColmap` or `addGroup`.

| Member | Does |
|--------|------|
| `add(item) → Promise<id>` | adds an item; resolves once it is drawn. Rejects if it fails to load, or is removed first |
| `removeItem(id)` | removes an item |
| `configure(config)` | changes the configuration; the fields given merge in |
| `setView(position, target)` | moves the camera; also the home view |
| `setTransform(id, matrix, node?)` | places an item (or a named node of a glTF) |
| `setItemVisible(id, visible)` | shows / hides an item |
| `setItemLabel(id, label)` | renames an item |
| `selectItem(id \| null)` | selects an item, or nothing |
| `setFrame(id, frame)` | shows a sequence's frame |
| `setPlaying(id, playing)` | plays / pauses a sequence |
| `setPhysicsMode(id, mode)` | an item's part in the physics |
| `physics(action)` | `"play"` \| `"pause"` \| `"restoreAll"` |
| `getState() → Promise<ViewerSnapshot>` | the viewer's state |
| `capture(options?) → Promise<dataURL>` | a PNG of the view; `{ scale?, transparent? }` |
| `on(type, listener) → unsubscribe` | listens for an [event](#events-and-replies) |
| `send(message)` | sends any message as it is |
| `ready() → Promise<this>` | resolves once the viewer is ready (`mount` already waits for it) |
| `destroy()` | removes the iframe; what is pending, and anything asked later, rejects |
| `version`, `apiVersion` | 3DView's version and the API's, from `ready` |
| `iframe` | the iframe element |

## Configuration

The `ViewerConfig` object: in `window.__viewerHost.config`, the `config` URL parameter, the
SDK's `config` option, or a `configure` message at any time. Every field is optional. A
field left out keeps its value; at startup that is the preset's, else the full UI. Groups
(`show`, `ui`, `interaction`) merge field by field.

| Field | Type | Default | |
|-------|------|---------|-|
| `preset` | `"full"` \| `"presentation"` | `"full"` | applied first, then the other fields. `full`: every panel and control, as in VS Code. `presentation`: a showcase: only the Scene panel, no footer; selecting, editing and physics off; grid, axes and box hidden |
| `theme` | `"light"` \| `"dark"` \| `"dim"` | `"dark"` | the UI's and viewport's colours |
| `background` | CSS colour \| `null` | `null` | the viewport's background; `null` = the theme's |
| `show` | `{ grid, axes, box, points, frustums, images, shaded, wireframe }`, each boolean | all on but `wireframe` | helpers and display switches |
| `upright` | boolean | `true` | show +y up (the scene turned 180° about x) or the raw COLMAP frame |
| `splatMode` | `"splatting"` \| `"ellipsoids"` \| `"points"` | `"splatting"` | how Gaussian splats are drawn |
| `ui.panels` | `("scene" \| "display" \| "physics" \| "capture")[]` \| `false` | all four | the icon rail's panels, in order; `false`: no rail, no panels |
| `ui.open` | panel name \| `null` | `"scene"` | the panel to open now (`null`: rail only). Opens once; the person may close it |
| `ui.footer` | boolean | `true` | the footer under the panels (frame rate, backend, version, help, theme) |
| `ui.fps` | boolean | `true` | the frame rate in the footer |
| `ui.themeSwitcher` | boolean | `true` | the theme switcher in the footer |
| `ui.help` | boolean | `true` | the "?" shortcuts overlay |
| `ui.keyboard` | boolean | `true` | keyboard shortcuts; off, keys do nothing in the viewer |
| `interaction.select` | boolean | `true` | a click selects an item (in the view or the Scene list) and opens its Inspector |
| `interaction.edit` | boolean | `true` | the scene can be changed: gizmo, placement fields, rename, remove, "+" add menu, file drops |
| `interaction.physics` | boolean | `true` | physics: the Physics panel, the playback bar, Shoot / Blast, an item's physics mode |

`interaction` limits what the **person** may do, not the page: `selectItem`, `setPhysicsMode` and
the other messages work whatever it says. `getState().config` gives back the configuration in
force with every field filled (but `ui.open`). A `configure` with it restores that look.

## Messages

Page → viewer. Post each message to the viewer's window: `iframe.contentWindow.postMessage(msg, "*")`,
or `window.postMessage(msg, "*")` in the bundle's own page. A message about an unknown id is ignored.

### Adding items

#### `addAsset`

```json
{ "type": "addAsset", "id": "mug", "label": "Mug", "asset": { "uri": "https://x.org/mug.glb", "name": "mug.glb" } }
```

One file. `asset.name` picks the loader by its extension. Answered by `itemAdded`, then
`itemLoaded` or `itemFailed`.

#### `loadColmap`

```json
{ "type": "loadColmap", "id": "desk", "label": "desk", "format": "bin",
  "urls": { "cameras": "https://x.org/desk/sparse/0/cameras.bin",
            "images": "https://x.org/desk/sparse/0/images.bin",
            "points3d": "https://x.org/desk/sparse/0/points3D.bin" },
  "imageBaseUrl": "https://x.org/desk/images/" }
```

A COLMAP model, fetched and parsed by the viewer. Optional fields:
- `imageBaseUrl`: the photos' folder. A photo is fetched as `imageBaseUrl` + its name in the model.
- `imageUrls`: a map from a photo's name to its URL, which wins over `imageBaseUrl`.
- `source`: the text shown when hovering the item's row.

A failed fetch is answered by `itemFailed`.

#### `addReconstruction`

```json
{ "type": "addReconstruction", "id": "desk", "label": "desk", "data": { "...": "a parsed ModelData" } }
```

A model the host parsed itself (the VS Code extension does). Pages want `loadColmap`.

#### `addGroup`

```json
{ "type": "addGroup", "id": "run", "label": "run", "grouping": "temporal",
  "members": [ { "type": "addAsset", "id": "run/0", "label": "000.ply", "asset": { "uri": "https://x.org/run/000.ply", "name": "000.ply" } },
               { "type": "addAsset", "id": "run/1", "label": "001.ply", "asset": { "uri": "https://x.org/run/001.ply", "name": "001.ply" } } ] }
```

Several items added together. The members are `addAsset`, `loadColmap` or `addReconstruction`
messages, put in natural order by label.
- `"grouping": "temporal"`: one item with a timeline, answered under the group's `id`.
- `"separate"`: each member is its own item.
- Left out: the viewer asks the person.

### Changing items

#### `removeItem`

```json
{ "type": "removeItem", "id": "mug" }
```

Answered by `removed`. An item still loading is removed too: it never appears.

#### `setItemVisible`

```json
{ "type": "setItemVisible", "id": "mug", "visible": false }
```

A hidden physics item also leaves the simulation.

#### `setItemLabel`

```json
{ "type": "setItemLabel", "id": "mug", "label": "The mug" }
```

#### `selectItem`

```json
{ "type": "selectItem", "id": "mug" }
```

Selects an item and opens its Inspector; `"id": null` selects nothing. Answered by `selected`
when the selection changes.

#### `setTransform`

```json
{ "type": "setTransform", "id": "mug", "matrix": [1,0,0,0.5, 0,1,0,0, 0,0,1,2, 0,0,0,1] }
```

Places an item by a 4x4 matrix (rotation, translation, scale), **row-major**, in the
[scene's frame](#the-scenes-frame). `node`, optional, names a node inside a glTF item to place
instead. Cheap to resend: an unchanged matrix costs nothing, so a page may stream poses.

#### `setFrame`

```json
{ "type": "setFrame", "id": "run", "frame": 3 }
```

Shows a sequence's frame (0-based, clamped).

#### `setPlaying`

```json
{ "type": "setPlaying", "id": "run", "playing": true }
```

Plays a sequence (it loops) or pauses it.

### Camera and look

#### `setView`

```json
{ "type": "setView", "position": [0, -1, -4], "target": [0, 0, 0] }
```

The camera at `position`, looking at `target`, in the [scene's frame](#the-scenes-frame). It
becomes the home view, where Reset view and fitting the scene go back to. It may arrive
before any item.

#### `configure`

```json
{ "type": "configure", "theme": "light", "show": { "grid": false }, "ui": { "panels": ["scene", "display"] } }
```

Any [Configuration](#configuration) fields; they merge into the current configuration.

### Physics

The physics is experimental. Items are not in it by default, except breakable `.npz` objects.

#### `setPhysicsMode`

```json
{ "type": "setPhysicsMode", "id": "mug", "mode": "dynamic" }
```

- `"off"`: not in the physics.
- `"static"`: a fixed body that others land on.
- `"dynamic"`: it falls, collides and can be hit.

`getState()` lists the modes each item can take: reconstructions are `off` / `static`, breakable
objects `off` / `dynamic`, and sequences and tracks none. A floor sits at the scene's bottom; the
person can turn it off in the Physics panel.

#### `physics`

```json
{ "type": "physics", "action": "play" }
```

`"play"` runs the simulation, `"pause"` stops it, `"restoreAll"` puts every object back where it
started.

### Requests

Both answer with a reply carrying the same `requestId` (a string or a number of your choice).

#### `getState`

```json
{ "type": "getState", "requestId": 1 }
```

Answered by [`state`](#state).

#### `capture`

```json
{ "type": "capture", "requestId": "shot", "scale": 2, "transparent": false }
```

A PNG of the current view at `scale` times the view's size (default 1). It is transparent unless
`transparent` is `false`, which keeps the viewport's background. Answered by [`captured`](#captured).

## Events and replies

Viewer → page: posted to `window.parent` by embed.html, delivered to `__viewerHost.postMessage` in
your own page, and to `on(type, …)` in the SDK.

### Item life cycle

Every add is answered by `itemAdded` once the item is in the Scene list, then `itemLoaded` when
all of it is drawn. If it cannot be loaded, `itemFailed` comes instead of `itemLoaded`, and an
item that was in the Scene list is then removed, so `removed` follows. A COLMAP model or a
sequence joins the Scene list only once fetched, so its `itemFailed` may come with no
`itemAdded` before it. An item removed before it was added is answered by `removed` alone.

#### `ready`

```json
{ "type": "ready", "version": "2.0.0", "apiVersion": 1 }
```

The viewer listens from now on (see [Before `ready`](#before-ready)).

#### `itemAdded`

```json
{ "type": "itemAdded", "id": "mug", "label": "Mug" }
```

#### `itemLoaded`

```json
{ "type": "itemLoaded", "id": "mug", "bounds": { "min": [-0.3, -0.2, -0.5], "max": [0.3, 0.2, 0.5] } }
```

`bounds`: the item's box in the [scene's frame](#the-scenes-frame), its placement included
(`null` when it has nothing to measure).

#### `itemFailed`

```json
{ "type": "itemFailed", "id": "mug", "message": "fetch for \"https://x.org/mug.glb\" responded with 404: Not Found" }
```

#### `removed`

```json
{ "type": "removed", "id": "mug" }
```

An item left the scene: removed by the page, by the person, or after failing to load.

#### `selected`

```json
{ "type": "selected", "id": "mug" }
```

The selection changed: by a click, by `selectItem`, or to `null` when the selected item was removed.

#### `state`

```json
{ "type": "state", "requestId": 1, "state": {
  "version": "2.0.0", "apiVersion": 1,
  "items": [ { "id": "mug", "label": "Mug", "type": "mesh", "visible": true,
               "matrix": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
               "bounds": { "min": [-0.3, -0.2, -0.5], "max": [0.3, 0.2, 0.5] },
               "frameCount": 0, "frame": 0, "playing": false,
               "physics": { "mode": "off", "modes": ["off", "static", "dynamic"] } } ],
  "selected": null,
  "camera": { "position": [0, -1, -4], "target": [0, 0, 0], "fov": 60 },
  "config": { "theme": "dark", "background": null, "show": { "grid": true, "...": "every switch" },
              "upright": true, "splatMode": "splatting", "ui": { "panels": ["scene", "display", "physics", "capture"], "...": "every field but open" },
              "interaction": { "select": true, "edit": true, "physics": true } },
  "physics": null } }
```

The reply to `getState`.
- `items[].type`: `reconstruction`, `sequence`, `mesh`, `splats`, `points`, `tracks` or `physics`
  (a breakable object).
- `items[].matrix`: row-major, as `setTransform` takes it.
- `items[].physics`: `null` for an item that cannot take part.
- `camera`: in the [scene's frame](#the-scenes-frame), as `setView` takes it.
- `physics`: `{ "running": boolean }`, or `null` while no item is in the physics.

#### `captured`

```json
{ "type": "captured", "requestId": "shot", "data": "data:image/png;base64,iVBOR..." }
{ "type": "captured", "requestId": "shot", "error": "Image too large (80000×50000px); max 32768px per side — try a lower scale." }
```

The reply to `capture`: `data` (a PNG data URL), or `error` when the view could not be drawn.

### IDE host messages

These are part of the protocol, for hosts that own files: the VS Code and PyCharm extensions and
the 3DView web app. A page embedding the viewer does not need them.

| Message / event | Direction | |
|-----------------|-----------|-|
| `loading` `{ message }` | to viewer | shows a busy status line while the host reads files |
| `error` `{ message }` | to viewer | shows an error in the status line |
| `chooseColmap` `{ models }` | to viewer | several COLMAP models found; the viewer lets the person pick |
| `requestAdd` `{ kind }` | to host | the person chose "+" in the Scene panel; the host opens its file picker |
| `openUris` `{ uris }` | to host | files dropped as paths; sent only when the bridge has `opensUris` |
| `saveFile` `{ suggestedName, data }` | to host | a capture to save; sent only when the bridge has `savesFiles` |

## Recipes

### A gallery: one model at a time, nothing to change

```js
const viewer = await ThreeDView.mount("#viewer", {
  config: { preset: "presentation", theme: "light", background: "#ffffff" },
});
let current = null;
async function show(url, view) {
  if (current) viewer.removeItem(current);
  if (view) viewer.setView(view.position, view.target);
  current = await viewer.add({ url });
}
```

### Live poses from a computation

```js
// Each update: the object's pose as a row-major 4x4 matrix in the scene's frame.
socket.onmessage = (e) => {
  const { id, matrix } = JSON.parse(e.data);
  viewer.setTransform(id, matrix);   // unchanged matrices cost nothing
};
```

### Thumbnails

```js
const id = await viewer.add({ url: "models/mug.glb" });
const png = await viewer.capture();   // the view's size, transparent background
document.querySelector("img").src = png;
```

### Reacting to a click

```js
viewer.configure({ interaction: { select: true } });   // only needed after the presentation preset
viewer.on("selected", async ({ id }) => {
  if (!id) return;
  const { items } = await viewer.getState();
  console.log(items.find((i) => i.id === id));
});
```

## Migrating from 1.x

1.x pages loaded `/dist/webview.js` and changed the viewer through its DOM and keys. Those pages
keep working on `/v1/dist/webview.js`, which stays the last 1.x release. Moving to 2.x:

| 1.x hack | 2.x |
|----------|-----|
| synthetic keys `b` `g` `a` (`p`) to hide the box, grid, axes (points) | `config.show: { box: false, grid: false, axes: false }`; the `presentation` preset hides the first three |
| clicking the theme switcher | `config.theme` |
| hiding a panel with CSS | `config.ui.panels` (`false` for none) |
| polling the DOM for `.viewer-scene-item` to know an item loaded | the `itemLoaded` event, or `await viewer.add(…)` |
| clicking checkbox rows / an item's eye or Remove button | `configure({ show })`, `setItemVisible`, `removeItem` |
| reading `#status` for errors | `itemFailed` |
| listening for `saveImage` | `capture` → `captured`, or `saveFile` with `savesFiles` |
