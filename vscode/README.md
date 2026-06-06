# 3DView (VS Code extension)

View **COLMAP reconstructions** (colored point cloud + camera frustums with the
source images) and **3D meshes** (glTF / GLB / OBJ / PLY) in an interactive
Three.js scene, right in the editor.

Open the **3DView** icon in the Activity Bar (or the Command Palette) to *Open
Reconstruction* / *Open Mesh* / *Open Viewer*, then the Scene panel's **+** to add
more. A COLMAP model is a folder of `cameras`/`images`/`points3D` (e.g. `sparse/0`).

| Action | Input |
|--------|-------|
| Orbit / zoom / pan | drag / scroll / right‑drag |
| Fly to a camera's view | click its frustum (**Esc** to exit) |
| Reset view | **R** |
| Toggle points / frustums / images | **P** / **F** / **I** |
| Toggle wireframe / box | **W** / **B** |
| Toggle grid / axes / upright | **G** / **A** / **U** |

This extension is one host of a shared viewer core; a PyCharm/JetBrains plugin is
the other. See the [project README](https://github.com/s-esposito/3DView) for
architecture and development.
