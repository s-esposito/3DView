# 3DViewer

A VS Code extension for viewing **COLMAP reconstructions** and **3D meshes**
directly in the editor — a colored point cloud with camera poses, the source
images shown inside their frustums, and glTF/OBJ/PLY meshes, all in one
interactive Three.js scene.

<!-- Add a screenshot or GIF here once captured: docs/screenshot.png -->

## Features

- **COLMAP point clouds** — reads `cameras`, `images`, and `points3D` in both
  **binary** (`.bin`) and **text** (`.txt`) formats.
- **Camera frustums** — every registered image drawn as a frustum at its solved
  pose, with the source image textured onto the image plane.
- **Click to fly** — click a frustum to view the scene from that camera's exact
  point of view (matching its field of view); a button returns you to the global view.
- **Mesh viewing** — load `.glb` / `.gltf` / `.obj` / `.ply` meshes that coexist
  in the same scene as the reconstruction.
- **Multi-source scenes** — open any number of reconstructions and meshes at once;
  a **Scene** panel lists them with per-item show/hide and remove, and a **"+"** to
  add more.
- **Scene helpers** — metric world grid, bounding box, axes, and a raw‑COLMAP ↔
  upright (Y‑up) orientation toggle.
- **Fast & scalable** — frustum images load lazily, downscaled, nearest‑first,
  with a resident‑texture cap so large reconstructions stay responsive.
- **Themed UI** — a collapsible control panel that follows your VS Code theme.

## Supported inputs

| Kind | Formats |
|------|---------|
| COLMAP model | `cameras/images/points3D` as `.bin` or `.txt` (e.g. under `sparse/0/`) |
| Source images | resolved from a sibling `images/` folder when present |
| Meshes | `.glb`, `.gltf`, `.obj`, `.ply` (OBJ `.mtl`/textures: not yet) |

## Install

This extension is not yet on the Marketplace, so install it from source. First
build it:

```bash
git clone git@github.com:s-esposito/3DView.git
cd 3DView          # the local folder may be named "colmapview"
npm install
npm run build
```

Then install it as a VS Code extension using **one** of the options below.

### Option A — one-step script (recommended)

Builds, packages a `.vsix`, and installs it via the `code` CLI:

```bash
./reinstall.sh
```

Re-run it any time to update the installed extension after pulling/changing code.
Then run **Developer: Reload Window** in VS Code.

### Option B — package and install a `.vsix` manually

```bash
npx @vscode/vsce package --allow-missing-repository   # → 3dviewer-<version>.vsix
code --install-extension 3dviewer-*.vsix              # install via the CLI
```

Or install through the UI: open the **Extensions** view → `…` menu →
**Install from VSIX…** → pick the generated `.vsix`. Reload the window when done.

> The `code` CLI must be on your PATH (in VS Code: *Shell Command: Install 'code'
> command in PATH*). On a remote/SSH/WSL workspace, run it in that environment so
> the extension installs on the remote host.

To uninstall: `code --uninstall-extension 3dviewer.3dviewer` (or via the
Extensions view).

### Option C — run without installing (for development)

Open the folder in VS Code and press **F5** ("Run Extension") to launch an
Extension Development Host with the extension loaded live from source — the
fastest loop while developing (no packaging step).

## Usage

1. Open the **3DViewer** icon in the Activity Bar (or the Command Palette).
2. Run **3DViewer: Open Reconstruction** and pick a COLMAP folder — the root
   works (it finds `sparse/0`, `sparse/1`, … and prompts if there are several),
   or pick a model folder directly.
3. Run **3DViewer: Open Mesh** to add a mesh, or **3DViewer: Open Empty Viewer**
   to start with an empty scene.
4. In the viewer's **Scene** panel, use **"+"** to add more reconstructions or
   meshes; toggle or remove each item from the list. Multiple of each can be
   loaded together.

### Controls

| Action | Input |
|--------|-------|
| Orbit / zoom / pan | drag / scroll / right‑drag |
| Select a camera (fly to its view) | click a frustum |
| Back to global view | **Esc** or the on‑screen button |
| Reset view | **R** |
| Toggle points / frustums / images | **P** / **F** / **I** |
| Toggle mesh / box / grid / axes | **M** / **B** / **G** / **A** |
| Upright (Y‑up) orientation | **U** |

## How it works

The extension runs as two sandboxed halves that communicate only via
`postMessage`:

- the **host** (Node) parses COLMAP files and resolves image/mesh URIs;
- the **webview** (Three.js) renders the scene and owns all interaction.

Coordinates are kept in COLMAP's native frame (no implicit up‑axis flip); the
"upright" toggle is purely a view convenience. See [CLAUDE.md](CLAUDE.md) for the
architecture and developer guide.

## Development

```bash
npm run watch   # rebuild on change
npm run lint    # tsc --noEmit (must be clean)
npm test        # unit tests for the COLMAP parser + pose math
```

## Roadmap

- OBJ materials/textures (`.mtl`), PLY large‑cloud handling.
- 3D Gaussian Splatting reconstructions.
- Load progress for very large clouds; remembering the last‑opened folder.

## License

MIT
