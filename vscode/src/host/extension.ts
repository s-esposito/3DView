import * as vscode from "vscode";
import * as path from "node:path";
import { ViewerPanel, pathOf, type OpenTarget } from "./panel";
import { findModelDirs, findImagesDir } from "./colmapLoad";
import { RecentsProvider } from "./recents";

// Single source for the asset formats — used by the open dialog, the drop filter,
// and the drop error message. Meshes (glTF/GLB/OBJ/PLY) plus 3D Gaussian Splatting
// files (.splat/.spz/.ksplat; a .ply may be a mesh or a splat — disambiguated in
// the webview).
const ASSET_EXTS = ["glb", "gltf", "obj", "ply", "splat", "spz", "ksplat"];

export function activate(context: vscode.ExtensionContext) {
  // The Activity Bar "3DView" view is a recents launcher (drag-drop + click to
  // re-open). The 3D scene itself opens in a separate editor webview panel.
  const recents = new RecentsProvider(context, (uris) => openDropped(context, recents, uris));

  context.subscriptions.push(
    vscode.window.createTreeView("3dview.welcome", {
      treeDataProvider: recents,
      dragAndDropController: recents,
    }),
    vscode.commands.registerCommand("3dview.openReconstruction", () =>
      openReconstruction(context, recents)
    ),
    vscode.commands.registerCommand("3dview.openAsset", () => openAsset(context, recents)),
    vscode.commands.registerCommand("3dview.openViewer", () => ViewerPanel.open(context)),
    vscode.commands.registerCommand("3dview.openRecent", (t: OpenTarget) => {
      ViewerPanel.open(context, t);
      recents.add(t); // bump to front
    }),
    vscode.commands.registerCommand("3dview.removeRecent", (t: OpenTarget) => recents.remove(t)),
    vscode.commands.registerCommand("3dview.clearRecents", () => recents.clear()),
    vscode.commands.registerCommand("3dview.revealRecent", (t: OpenTarget) =>
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
      "3DView: no COLMAP model found here (need cameras/images/points3D as .bin or .txt, e.g. under sparse/0)."
    );
    return;
  }

  let selected = dirs;
  if (dirs.length > 1) {
    // `dir: null` is the "load all" entry; a specific entry carries its dir.
    const items: Array<{ label: string; description?: string; dir: string | null }> = [
      { label: `$(layers) All ${dirs.length} models`, dir: null },
      ...dirs.map((dir) => ({
        label: path.relative(root, dir) || path.basename(dir),
        description: dir,
        dir,
      })),
    ];
    const choice = await vscode.window.showQuickPick(items, {
      placeHolder: "Multiple COLMAP models found — select one, or load all",
    });
    if (!choice) {
      return;
    }
    selected = choice.dir ? [choice.dir] : dirs;
  }

  for (const modelDir of selected) {
    const imagesDir = findImagesDir(root, modelDir);
    const target: OpenTarget = { kind: "colmap", modelDir, imagesDir };
    ViewerPanel.open(context, target);
    recents.add(target);
  }
}

async function openAsset(context: vscode.ExtensionContext, recents: RecentsProvider) {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: false,
    canSelectFiles: true,
    canSelectMany: false,
    openLabel: "Open Asset",
    title: "Select an asset — mesh (glTF / GLB / OBJ / PLY) or splat (PLY / SPLAT / SPZ / KSPLAT)",
    filters: { "3D assets": ASSET_EXTS },
  });
  if (!picked || picked.length === 0) {
    return;
  }
  openAssetFromFile(context, recents, picked[0].fsPath);
}

function openAssetFromFile(context: vscode.ExtensionContext, recents: RecentsProvider, file: string) {
  const target: OpenTarget = { kind: "asset", file };
  ViewerPanel.open(context, target);
  recents.add(target);
}

/** Open dropped resources: a folder → reconstruction, an asset file → asset. */
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
    } else if (ASSET_EXTS.includes(path.extname(uri.fsPath).slice(1).toLowerCase())) {
      openAssetFromFile(context, recents, uri.fsPath);
    } else {
      void vscode.window.showErrorMessage(
        `3DView: drop a folder (a COLMAP reconstruction) or an asset file (${ASSET_EXTS.map((e) => `.${e}`).join(" / ")}).`
      );
    }
  }
}

export function deactivate() {}
