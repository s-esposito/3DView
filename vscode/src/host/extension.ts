import * as vscode from "vscode";
import * as path from "node:path";
import { ASSET_EXTS, ASSET_KIND_EXTS, ASSET_KIND_LABELS, type AssetKind } from "@3dview/core";
import { ViewerPanel, pathOf, type OpenTarget } from "./panel";
import { findModelDirs, findImagesDir } from "./colmapLoad";
import { RecentsProvider } from "./recents";

/** The asset kind a picker was opened for, or undefined for "any asset" (the
 *  Command Palette entry). Guards against a menu passing an unrelated argument. */
function assetKindOf(value: unknown): AssetKind | undefined {
  return typeof value === "string" && value in ASSET_KIND_EXTS ? (value as AssetKind) : undefined;
}

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
    // The Scene "+" passes the kind it asked for; the palette entry passes nothing.
    vscode.commands.registerCommand("3dview.openAsset", (kind?: unknown) =>
      openAsset(context, recents, assetKindOf(kind))
    ),
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

async function openAsset(
  context: vscode.ExtensionContext,
  recents: RecentsProvider,
  kind?: AssetKind
) {
  // The requested kind leads the filter list (so the dialog opens on it), with the
  // others still reachable from the dropdown — a .ply is a mesh or a splat by
  // header, not by which menu entry was used, so nothing here is a dead end.
  const kinds = Object.keys(ASSET_KIND_EXTS) as AssetKind[];
  const filters: Record<string, string[]> = {};
  if (kind) {
    filters[ASSET_KIND_LABELS[kind]] = [...ASSET_KIND_EXTS[kind]];
  }
  filters["All 3D assets"] = [...ASSET_EXTS];
  for (const other of kinds.filter((k) => k !== kind)) {
    filters[ASSET_KIND_LABELS[other]] = [...ASSET_KIND_EXTS[other]];
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: false,
    canSelectFiles: true,
    canSelectMany: false,
    openLabel: "Open Asset",
    title: kind
      ? `Select a file — ${ASSET_KIND_LABELS[kind]} (${ASSET_KIND_EXTS[kind].map((e) => `.${e}`).join(" / ")})`
      : "Select an asset — mesh, 3DGS splat, or 3D point tracks",
    filters,
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
