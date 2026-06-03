# 3DViewer

A VS Code extension for viewing **COLMAP reconstructions** and **3D meshes** in
the editor — a colored point cloud, camera frustums with the source images, and
glTF/OBJ/PLY meshes, all in one interactive Three.js scene.

![3DViewer](imgs/teaser.png)

## Features

- **COLMAP point clouds + camera poses** (`.bin` / `.txt`), with each image
  textured onto its frustum. Click a frustum to fly to that camera's viewpoint.
- **Meshes** — `.glb` / `.gltf` / `.obj` / `.ply`, with a wireframe toggle.
- **Multi-source scenes** — open many reconstructions and meshes together; add,
  show/hide, and remove them from the **Scene** panel.
- **Helpers** — world-origin metric grid, bounding boxes, axes, and a raw‑COLMAP ↔
  upright (Y‑up) toggle.
- **Built for large clouds** — on-demand rendering and lazy, downscaled frustum
  textures keep big reconstructions responsive.

## Install

```bash
git clone git@github.com:s-esposito/3DView.git && cd 3DView && npm install
```

- **Develop:** open the folder in VS Code and press **F5**.
- **Install:** run `./reinstall.sh` (build + package + install the `.vsix`), then
  *Developer: Reload Window*.

## Usage

Use the **3DViewer** icon in the Activity Bar (or the Command Palette) to *Open
Reconstruction* / *Open Mesh* / *Open Viewer*, then the Scene panel's **+** to add
more. A COLMAP model is a folder of `cameras`/`images`/`points3D` (e.g. `sparse/0/`).

| Action | Input |
|--------|-------|
| Orbit / zoom / pan | drag / scroll / right‑drag |
| Fly to a camera's view | click its frustum (**Esc** to exit) |
| Reset view | **R** |
| Toggle points / frustums / images | **P** / **F** / **I** |
| Toggle wireframe / box | **W** / **B** |
| Toggle grid / axes / upright | **G** / **A** / **U** |

## Development

```bash
npm run lint && npm run build && npm test
```

See [CLAUDE.md](CLAUDE.md) for the architecture. License: MIT.
