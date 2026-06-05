# 3DViewer Demo

A fully client-side web build of **3DViewer** — the same host-agnostic three.js
viewer used by the VS Code and PyCharm hosts, running in the browser over a thin
file-picker bridge. Nothing is uploaded; all parsing and rendering happen locally.

**Live demo:** [https://s-esposito.github.io/3DView/](https://s-esposito.github.io/3DView/)

## How to use

Everything loads from the **Scene** panel's **+** ("Add to scene") menu in the
top-left of the viewer:

### Reconstruction… (COLMAP)

Picks a **folder**. Choose your **project root** — the directory that contains
both `sparse/` (the model) and `images/` (the source images) — so the camera
frustums get their textures:

```
my-reconstruction/        ← pick this folder
├── sparse/
│   └── 0/
│       ├── cameras.bin    (or cameras.txt)
│       ├── images.bin     (or images.txt)
│       └── points3D.bin   (or points3D.txt)
└── images/
    ├── image_0.jpg
    └── ...
```

The demo finds the first directory holding a complete `cameras`/`images`/`points3D`
trio (binary or text), so picking a parent that contains several models (e.g.
`sparse/0`, `sparse/1`) just loads the first. If you pick only the model folder
(e.g. `sparse/0`) without the sibling `images/`, the point cloud and frustums load
but the frustums won't be textured.

### Mesh…

Picks a single mesh file: `.glb` / `.gltf` (recommended), `.obj`, or `.ply`.

Add as many reconstructions and meshes as you like; show/hide or remove each from
the Scene panel.

## Viewer controls

| Action | Control |
|--------|---------|
| Rotate / pan / zoom | left-drag / right-drag (or Cmd+drag) / scroll |
| Fly to a camera's view | click its frustum |
| Exit camera view | `Esc` (or ✕ in the info popup) |
| Reset / fit view | `r` |
| Toggle points / frustums / images | `p` / `f` / `i` |
| Toggle wireframe / bounding box | `w` / `b` |
| Toggle grid / axes | `g` / `a` |
| Toggle upright (Y-up) orientation | `u` |

## Build & run locally

From the repo root (npm workspaces link the packages):

```bash
npm install
npm run build      # builds @3dviewer/core, then copies its bundle into demo/dist/
```

Then serve the `demo/` directory with any static server (`index.html` references
`dist/demo.js`, which loads `dist/webview.js` from the same folder):

```bash
cd demo && python3 -m http.server 8000   # → http://localhost:8000
```

Deployed to GitHub Pages by `.github/workflows/deploy-demo.yml` on push to `demo`.

## Notes & limitations

- **Client-side only** — files never leave your machine; the host hands the viewer
  `blob:` URLs and the core bundle parses them in-browser.
- **Image matching is by basename**, so frustum textures resolve for the typical
  flat `images/` layout; image names reused across subfolders can collide.
- **Large point clouds** (millions of points) parse and render in the browser, so
  performance depends on your hardware. On-demand rendering and lazy, downscaled
  frustum textures keep things responsive.
- **Black / empty viewer?** Press `r` to re-fit the camera to the scene.

## License

MIT — see the [main repository README](../README.md).
