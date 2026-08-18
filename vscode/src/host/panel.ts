import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AddItem, HostToWebview, WebviewToHost, ModelData } from "@3dview/core";
import { sharedFolderName } from "@3dview/core";
import { buildModelData } from "./modelData";

// What the user asked to open. Also persisted as the Recents schema
// (recents.ts → workspaceState), so keep it a plain JSON-serializable path
// descriptor — no `vscode.Uri`, handles, or other volatile fields.
export type OpenTarget =
  | { kind: "colmap"; modelDir: string; imagesDir?: string }
  | { kind: "asset"; file: string };

/** The on-disk path an OpenTarget refers to (a model dir or an asset file). */
export function pathOf(t: OpenTarget): string {
  return t.kind === "colmap" ? t.modelDir : t.file;
}

/** A scene item the panel tracks so it can be replayed after a recreate. */
interface Item {
  id: string;
  target: OpenTarget;
  /** Set when the item was opened together with others in one action; the webview
   *  may fold the whole group into a single temporal item under this id. Not part of
   *  OpenTarget: it describes the action, not the thing on disk, and is never persisted. */
  group?: string;
}

let idCounter = 0;
const nextId = (kind: string) => `${kind}-${++idCounter}`;

/**
 * Owns the singleton webview panel. A scene holds any number of reconstructions
 * and assets. `localResourceRoots` is fixed at panel creation, so when a new
 * item needs a folder the panel doesn't allow yet, we recreate the panel with
 * the union of roots and replay all tracked items.
 */
export class ViewerPanel {
  public static current: ViewerPanel | undefined;
  private static readonly viewType = "3dview.viewer";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly allowedRoots: string[];
  private content: Item[];
  private webviewReady = false;
  private readonly pending: Array<() => void> = [];

  /** Open the viewer, optionally adding `target`. Preserves existing content. */
  public static open(context: vscode.ExtensionContext, target?: OpenTarget) {
    ViewerPanel.add(context, target ? [target] : []);
  }

  /**
   * Open the viewer adding several items from ONE user action — "all N models", a
   * multi-file asset pick. They reach the webview as a single `addGroup`, which asks
   * whether they are a capture's timesteps; the group id is what the temporal item
   * would be called, and what `removed` reports when it goes.
   */
  public static openMany(context: vscode.ExtensionContext, targets: OpenTarget[]) {
    ViewerPanel.add(context, targets, targets.length > 1 ? nextId("group") : undefined);
  }

  private static add(context: vscode.ExtensionContext, targets: OpenTarget[], group?: string) {
    const column = vscode.window.activeTextEditor?.viewColumn;
    const current = ViewerPanel.current;

    const added: Item[] = targets.map((target) => ({ id: nextId(target.kind), target, group }));
    const content: Item[] = [...(current ? current.content : []), ...added];
    const roots = rootsFor(content);

    if (current && roots.every((r) => current.allowedRoots.includes(r))) {
      current.content = content;
      current.panel.reveal(column);
      if (added.length > 0) {
        current.applyItems(added);
      }
      return;
    }

    current?.dispose();
    ViewerPanel.create(context, column, roots, content).replay();
  }

  private static create(
    context: vscode.ExtensionContext,
    column: vscode.ViewColumn | undefined,
    roots: string[],
    content: Item[]
  ): ViewerPanel {
    const localResourceRoots = [
      vscode.Uri.joinPath(context.extensionUri, "out"),
      ...roots.map((r) => vscode.Uri.file(r)),
    ];
    const webviewPanel = vscode.window.createWebviewPanel(
      ViewerPanel.viewType,
      "3DView",
      column ?? vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots }
    );
    const panel = new ViewerPanel(webviewPanel, context, roots, content);
    ViewerPanel.current = panel;
    return panel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    roots: string[],
    content: Item[]
  ) {
    this.panel = panel;
    this.allowedRoots = roots;
    this.content = content;
    this.panel.webview.html = this.getHtml(context.extensionUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewToHost) => this.onMessage(msg),
      null,
      this.disposables
    );
  }

  /** Re-send all tracked items to a freshly created webview. Items opened together
   *  are replayed together, so a group is offered as a group again rather than
   *  silently splitting into N separate items. */
  private replay() {
    const batches: Item[][] = [];
    for (const item of this.content) {
      const last = batches[batches.length - 1];
      if (item.group !== undefined && last?.[0].group === item.group) {
        last.push(item);
      } else {
        batches.push([item]);
      }
    }
    batches.forEach((batch) => this.applyItems(batch));
  }

  private onMessage(msg: WebviewToHost) {
    switch (msg.type) {
      case "ready":
        this.webviewReady = true;
        for (const action of this.pending.splice(0)) {
          action();
        }
        break;
      case "requestAdd": {
        // Reuse the same pickers as the commands; they call back into open(). Asset
        // kinds ride along so the dialog opens filtered to what was asked for.
        const command =
          msg.kind === "colmap"
            ? "3dview.openReconstruction"
            : msg.kind === "assetFolder"
              ? "3dview.openAssetFolder"
              : "3dview.openAsset";
        void vscode.commands.executeCommand(command, msg.kind);
        break;
      }
      case "removed":
        // Either one item's id, or a group's — the id a temporal item took, which
        // stands for every member the webview folded into it.
        this.content = this.content.filter((i) => i.id !== msg.id && i.group !== msg.id);
        break;
      case "saveImage":
        void this.saveImage(msg.png, msg.suggestedName);
        break;
    }
  }

  /** Save a webview-rendered PNG (data URL) to a user-chosen file. */
  private async saveImage(png: string, suggestedName: string) {
    const bytes = Buffer.from(png.replace(/^data:image\/png;base64,/, ""), "base64");
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, suggestedName) : vscode.Uri.file(suggestedName),
      filters: { Images: ["png"] },
    });
    if (!uri) {
      return;
    }
    await vscode.workspace.fs.writeFile(uri, bytes);
    void vscode.window.showInformationMessage(`3DView: saved ${path.basename(uri.fsPath)}`);
  }

  /** Send items now if the webview is up, else queue them until "ready". Items
   *  opened together travel as one message, so the webview can ask what they are. */
  private applyItems(items: Item[]) {
    const action = async () => {
      // Sequentially: a model is parsed into memory here, and several at once is a
      // spike for no gain (the webview can't show any of them until all have landed).
      const members: AddItem[] = [];
      for (const item of items) {
        const member = await this.member(item);
        if (member) {
          members.push(member);
        }
      }
      if (members.length === 1) {
        this.post(members[0]);
      } else if (members.length > 1) {
        const id = items[0].group ?? nextId("group");
        const label = sharedFolderName(items.map((i) => pathOf(i.target)));
        this.post({ type: "addGroup", id, label: label ?? `${members.length} items`, members });
      }
    };
    if (this.webviewReady) {
      void action();
    } else {
      this.pending.push(() => void action());
    }
  }

  /** The message that carries one item, or undefined if it could not be built (the
   *  item is dropped from the tracked list, so a recreate won't replay it). */
  private async member(item: Item): Promise<AddItem | undefined> {
    if (item.target.kind === "asset") {
      const file = item.target.file;
      const uri = this.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
      const name = path.basename(file);
      return { type: "addAsset", id: item.id, label: name, asset: { uri, name } };
    }
    const { modelDir, imagesDir } = item.target;
    try {
      const data = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "3DView: loading reconstruction…",
        },
        async () => Promise.resolve().then(() => buildModelData(modelDir))
      );
      if (imagesDir) {
        this.attachImageUris(data, imagesDir);
      }
      return {
        type: "addReconstruction",
        id: item.id,
        label: labelFor(modelDir),
        data,
        source: modelDir,
      };
    } catch (err) {
      this.content = this.content.filter((i) => i.id !== item.id);
      this.reportError(err);
      return undefined;
    }
  }

  /**
   * Resolve each camera's source image to a webview URI, when the file exists
   * under `imagesRoot`. Leaves `imageUri` undefined otherwise.
   */
  private attachImageUris(data: ModelData, imagesRoot: string) {
    for (const cam of data.cameras) {
      const file = path.join(imagesRoot, cam.name);
      // Guard against `name` escaping the images root (e.g. "../secret").
      const rel = path.relative(imagesRoot, file);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        continue;
      }
      if (fs.existsSync(file)) {
        cam.imageUri = this.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
      }
    }
  }

  private reportError(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    this.post({ type: "error", message });
    void vscode.window.showErrorMessage(`3DView: ${message}`);
  }

  private post(msg: HostToWebview) {
    void this.panel.webview.postMessage(msg);
  }

  private dispose() {
    if (ViewerPanel.current === this) {
      ViewerPanel.current = undefined;
    }
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private getHtml(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "out", "webview.js")
    );
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      // 'wasm-unsafe-eval' lets the Spark splat decoder compile its WebAssembly;
      // it runs inside a blob: Web Worker (worker-src), which inherits this policy.
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
      `worker-src blob:`,
      // Asset loaders (glTF/OBJ/PLY) fetch the file and its sibling assets as
      // webview resources (our resource origin). `blob:` is required because
      // GLTFLoader decodes a GLB's embedded (bufferView) textures — e.g. the
      // WebP images in this repo's GLBs — by wrapping their bytes in a `blob:`
      // URL that its `ImageBitmapLoader` then `fetch`es (img-src's `blob:` does
      // not cover this — it's a fetch, not an `<img>`). `data:` is required
      // because the Spark splat worker loads its WebAssembly from an inlined
      // `data:application/wasm;base64,…` URL.
      `connect-src ${webview.cspSource} blob: data:`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>3DView</title>
  <style>
    html, body { margin: 0; height: 100%; overflow: hidden; background: #1e1e1e; }
    canvas { display: block; position: fixed; top: 0; left: 0; }
    #status {
      position: fixed; inset: 0;
      display: flex; align-items: center; justify-content: center;
      font-family: var(--vscode-font-family);
      color: var(--vscode-descriptionForeground);
      pointer-events: none;
    }
  </style>
</head>
<body>
  <div id="status">Loading…</div>
  <!-- VS Code host adapter: expose the neutral bridge the host-agnostic bundle
       expects (window.__viewerHost), wrapping VS Code's acquireVsCodeApi(). This
       is the ONLY place acquireVsCodeApi is named; the bundle never references it. -->
  <script nonce="${nonce}">window.__viewerHost = acquireVsCodeApi();</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/**
 * Filesystem roots that must be in `localResourceRoots` for the given items.
 *
 * We use the drive/filesystem root of each opened path (e.g. "/" on posix) rather
 * than the exact folder, so adding content from a new folder does NOT force a
 * panel recreate — which would reload the whole viewer from scratch. This is
 * safe: the host only ever builds webview URIs for opened content (asset files,
 * and images under a model's images dir guarded against path escapes), so a
 * broad root never widens what is actually loadable.
 */
function rootsFor(content: Item[]): string[] {
  const roots = new Set<string>();
  for (const { target } of content) {
    const p = target.kind === "colmap" ? target.imagesDir : target.file;
    if (p) {
      roots.add(path.parse(path.resolve(p)).root);
    }
  }
  return [...roots];
}

/** Readable label for a model dir, disambiguating numeric dirs like sparse/0. */
export function labelFor(modelDir: string): string {
  const base = path.basename(modelDir);
  return /^\d+$/.test(base) ? `${path.basename(path.dirname(modelDir))}/${base}` : base;
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
