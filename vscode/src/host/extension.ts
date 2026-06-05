import * as vscode from "vscode";
import * as path from "node:path";
import { ViewerPanel, pathOf, type OpenTarget } from "./panel";
import { findModelDirs, findImagesDir } from "./colmapLoad";
import { RecentsProvider } from "./recents";

// Single source for the mesh formats — used by the open dialog, the drop filter,
// and the drop error message.
const MESH_EXTS = ["glb", "gltf", "obj", "ply"];

export function activate(context: vscode.ExtensionContext) {
  // The Activity Bar "3DViewer" view is a recents launcher (drag-drop + click to
  // re-open). The 3D scene itself opens in a separate editor webview panel.
  const recents = new RecentsProvider(context, (uris) => openDropped(context, recents, uris));

  context.subscriptions.push(
    vscode.window.createTreeView("3dviewer.welcome", {
      treeDataProvider: recents,
      dragAndDropController: recents,
    }),
    vscode.commands.registerCommand("3dviewer.openReconstruction", () =>
      openReconstruction(context, recents)
    ),
    vscode.commands.registerCommand("3dviewer.openMesh", () => openMesh(context, recents)),
    vscode.commands.registerCommand("3dviewer.openViewer", () => ViewerPanel.open(context)),
    vscode.commands.registerCommand("3dviewer.openRecent", (t: OpenTarget) => {
      ViewerPanel.open(context, t);
      recents.add(t); // bump to front
    }),
    vscode.commands.registerCommand("3dviewer.removeRecent", (t: OpenTarget) => recents.remove(t)),
    vscode.commands.registerCommand("3dviewer.clearRecents", () => recents.clear()),
    vscode.commands.registerCommand("3dviewer.revealRecent", (t: OpenTarget) =>
      vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(pathOf(t)))
    )
  );
}

async function openReconstruction(context: vscode.ExtensionContext, recents: RecentsProvider) {
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
  await openReconstructionFromRoot(context, recents, picked[0].fsPath);
}

/** Discover the model(s) under `root` (prompting on ambiguity) and open one. */
async function openReconstructionFromRoot(
  context: vscode.ExtensionContext,
  recents: RecentsProvider,
  root: string
) {
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
  const target: OpenTarget = { kind: "colmap", modelDir, imagesDir };
  ViewerPanel.open(context, target);
  recents.add(target);
}

async function openMesh(context: vscode.ExtensionContext, recents: RecentsProvider) {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: false,
    canSelectFiles: true,
    canSelectMany: false,
    openLabel: "Open Mesh",
    title: "Select a mesh (glTF / GLB / OBJ / PLY)",
    filters: { "3D meshes": MESH_EXTS },
  });
  if (!picked || picked.length === 0) {
    return;
  }
  openMeshFromFile(context, recents, picked[0].fsPath);
}

function openMeshFromFile(context: vscode.ExtensionContext, recents: RecentsProvider, file: string) {
  const target: OpenTarget = { kind: "mesh", file };
  ViewerPanel.open(context, target);
  recents.add(target);
}

/** Open dropped resources: a folder → reconstruction, a mesh file → mesh. */
async function openDropped(
  context: vscode.ExtensionContext,
  recents: RecentsProvider,
  uris: vscode.Uri[]
) {
  for (const uri of uris) {
    if (uri.scheme !== "file") {
      continue;
    }
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      continue;
    }
    if (stat.type & vscode.FileType.Directory) {
      await openReconstructionFromRoot(context, recents, uri.fsPath);
    } else if (MESH_EXTS.includes(path.extname(uri.fsPath).slice(1).toLowerCase())) {
      openMeshFromFile(context, recents, uri.fsPath);
    } else {
      void vscode.window.showErrorMessage(
        `3DViewer: drop a folder (a COLMAP reconstruction) or a mesh file (${MESH_EXTS.map((e) => `.${e}`).join(" / ")}).`
      );
    }
  }
}

export function deactivate() {}
