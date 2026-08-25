import * as vscode from "vscode";
import * as fs from "node:fs";
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
    vscode.commands.registerCommand("3dview.openAssetFolder", () =>
      openAssetFolder(context, recents)
    ),
    vscode.commands.registerCommand("3dview.openViewer", () => ViewerPanel.open(context)),
    // Explorer right-click. VS Code passes the clicked resource plus the whole
    // selection, so a multi-select opens as one action.
    vscode.commands.registerCommand(
      "3dview.openFromExplorer",
      (uri: vscode.Uri, uris?: vscode.Uri[]) =>
        openDropped(context, recents, uris?.length ? uris : [uri])
    ),
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

  // A drop the webview could only read as URIs — it hands them here to be opened
  // by path (the same funnel the Recents-tree drop and the Explorer entry use).
  ViewerPanel.onOpenUris = (uris) => {
    void openDropped(
      context,
      recents,
      uris.map((u) => vscode.Uri.parse(u))
    );
  };
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

  // Opened as one action: the webview asks whether several models are one
  // capture's timesteps. Each still gets its own Recents entry.
  const targets: OpenTarget[] = selected.map((modelDir) => ({
    kind: "colmap",
    modelDir,
    imagesDir: findImagesDir(root, modelDir),
  }));
  targets.forEach((target) => recents.add(target));
  ViewerPanel.openMany(context, targets);
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
    // Several at once: a dynamic capture is a folder of per-frame meshes or splats,
    // and the webview offers to load such a pick as one temporal item.
    canSelectMany: true,
    openLabel: "Open Asset",
    title: kind
      ? `Select file(s) — ${ASSET_KIND_LABELS[kind]} (${ASSET_KIND_EXTS[kind].map((e) => `.${e}`).join(" / ")})`
      : "Select asset file(s) — mesh, 3DGS splat, or 3D point tracks",
    filters,
  });
  if (!picked || picked.length === 0) {
    return;
  }
  openAssetFiles(context, recents, picked.map((p) => p.fsPath));
}

/**
 * Open every asset file directly inside a chosen folder, as one action — so a
 * per-frame capture can be loaded in one go and offered as a single temporal item.
 *
 * This is not just a convenience: over a remote connection VS Code substitutes its
 * own file dialog, which cannot select several files at once, so a folder is the
 * only way in there. It stays a separate command rather than letting the asset
 * dialog take folders too, because a native dialog on Windows/Linux cannot offer
 * files and folders at the same time — asking for both would silently turn the
 * file picker into a folder-only one.
 */
async function openAssetFolder(context: vscode.ExtensionContext, recents: RecentsProvider) {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Open Assets",
    title: `Select a folder of asset files (${ASSET_EXTS.map((e) => `.${e}`).join(" / ")})`,
  });
  if (!picked || picked.length === 0) {
    return;
  }
  const dir = picked[0].fsPath;
  const files = assetFilesIn(dir);
  if (files.length === 0) {
    void vscode.window.showErrorMessage(
      `3DView: no asset files directly inside "${path.basename(dir)}" — looked for ${ASSET_EXTS.map((e) => `.${e}`).join(" / ")}.`
    );
    return;
  }
  openAssetFiles(context, recents, files);
}

/** The asset files directly inside `dir`. Not recursive: the folder you pick is the
 *  sequence. Left unsorted — the webview orders frames naturally when it builds the
 *  item, so sorting here would only be a second opinion. */
function assetFilesIn(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && ASSET_EXTS.includes(path.extname(e.name).slice(1).toLowerCase()))
    .map((e) => path.join(dir, e.name));
}

function openAssetFiles(context: vscode.ExtensionContext, recents: RecentsProvider, files: string[]) {
  const targets: OpenTarget[] = files.map((file) => ({ kind: "asset", file }));
  // Recents holds ten entries, so a sequence would flush it — and its rows re-open
  // one file each, which is not what was opened. Only a single pick is recorded.
  if (targets.length === 1) {
    recents.add(targets[0]);
  }
  ViewerPanel.openMany(context, targets);
}

/**
 * The extension host's own view of a dragged/right-clicked resource. In a remote
 * window the workbench addresses files as `vscode-remote://<authority>/<path>`,
 * and that is what a webview drop hands us verbatim — but on this side of the
 * connection the very same file is a plain local path. Anything else (untitled,
 * a virtual filesystem, an http link) is not ours to open.
 */
function localUri(uri: vscode.Uri): vscode.Uri | undefined {
  if (uri.scheme === "file") {
    return uri;
  }
  return uri.scheme === "vscode-remote" ? vscode.Uri.file(uri.path) : undefined;
}

/** Open dropped resources: a folder → reconstruction, an asset file → asset. Asset
 *  files open as ONE action, so a multi-select arrives as a single group and gets
 *  the temporal question, exactly like a multi-file pick. */
async function openDropped(
  context: vscode.ExtensionContext,
  recents: RecentsProvider,
  uris: vscode.Uri[]
) {
  const locals = uris.map(localUri);
  // One round-trip each over a remote connection, and an Explorer selection can be
  // a whole per-frame capture — so ask about them together, not one after another.
  const stats = await Promise.all(locals.map(statOf));
  const dirs: string[] = [];
  const assets: string[] = [];
  locals.forEach((uri, i) => {
    const stat = stats[i];
    if (!uri || !stat) {
      return;
    }
    if (stat.type & vscode.FileType.Directory) {
      dirs.push(uri.fsPath);
    } else if (ASSET_EXTS.includes(path.extname(uri.fsPath).slice(1).toLowerCase())) {
      assets.push(uri.fsPath);
    }
  });
  if (assets.length === 0 && dirs.length === 0) {
    // Nothing here was ours: an unreadable path, a resource with no file behind it
    // (an untitled tab, a diff, a link), or a file of a kind we don't load. The
    // webview stays quiet about a drop it handed over, so say so here.
    void vscode.window.showErrorMessage(
      `3DView: nothing to open there — a folder (a COLMAP reconstruction) or an asset file (${ASSET_EXTS.map((e) => `.${e}`).join(" / ")}).`
    );
    return;
  }
  if (assets.length > 0) {
    openAssetFiles(context, recents, assets);
  }
  for (const dir of dirs) {
    await openReconstructionFromRoot(context, recents, dir);
  }
}

/** `stat` if the resource is there, undefined if it isn't ours to see. */
async function statOf(uri: vscode.Uri | undefined): Promise<vscode.FileStat | undefined> {
  if (!uri) {
    return undefined;
  }
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
}

export function deactivate() {}
