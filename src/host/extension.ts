import * as vscode from "vscode";
import * as path from "node:path";
import { ViewerPanel } from "./panel";
import { findModelDirs, findImagesDir } from "./colmapLoad";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("3dviewer.openReconstruction", () =>
      openReconstruction(context)
    ),
    vscode.commands.registerCommand("3dviewer.openMesh", () => openMesh(context)),
    vscode.commands.registerCommand("3dviewer.openViewer", () =>
      ViewerPanel.open(context)
    )
  );

  // Empty provider for the activity-bar view. With no provider registered VS Code
  // shows a "no data provider" message; an empty one lets the `viewsWelcome`
  // contribution (the "Open Reconstruction" button) render instead. A model
  // browser can replace this later.
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("3dviewer.welcome", {
      getChildren: () => [],
      getTreeItem: (element: vscode.TreeItem) => element,
    })
  );
}

async function openReconstruction(context: vscode.ExtensionContext) {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Open COLMAP Reconstruction",
    title: "Select a COLMAP reconstruction folder",
  });
  if (!picked || picked.length === 0) {
    return;
  }
  const root = picked[0].fsPath;

  const dirs = findModelDirs(root);
  if (dirs.length === 0) {
    void vscode.window.showErrorMessage(
      "3DViewer: no COLMAP model found here (need cameras/images/points3D as .bin or .txt, e.g. under sparse/0)."
    );
    return;
  }

  let modelDir = dirs[0];
  if (dirs.length > 1) {
    const choice = await vscode.window.showQuickPick(
      dirs.map((dir) => ({
        label: path.relative(root, dir) || path.basename(dir),
        description: dir,
        dir,
      })),
      { placeHolder: "Multiple COLMAP models found — select one" }
    );
    if (!choice) {
      return;
    }
    modelDir = choice.dir;
  }

  const imagesDir = findImagesDir(root, modelDir);
  ViewerPanel.open(context, { kind: "colmap", modelDir, imagesDir });
}

async function openMesh(context: vscode.ExtensionContext) {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: false,
    canSelectFiles: true,
    canSelectMany: false,
    openLabel: "Open Mesh",
    title: "Select a mesh (glTF / GLB / OBJ / PLY)",
    filters: { "3D meshes": ["glb", "gltf", "obj", "ply"] },
  });
  if (!picked || picked.length === 0) {
    return;
  }
  ViewerPanel.open(context, { kind: "mesh", file: picked[0].fsPath });
}

export function deactivate() {}
