import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { HostToWebview, WebviewToHost, ModelData } from "@3dview/core";
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
    const column = vscode.window.activeTextEditor?.viewColumn;
    const current = ViewerPanel.current;

    const content: Item[] = current ? [...current.content] : [];
    if (target) {
      content.push({ id: nextId(target.kind), target });
    }
    const roots = rootsFor(content);

    if (current && roots.every((r) => current.allowedRoots.includes(r))) {
      current.content = content;
      current.panel.reveal(column);
      if (content.length > 0 && target) {
        current.applyItem(content[content.length - 1]);
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

  /** Re-send all tracked items to a freshly created webview. */
  private replay() {
    for (const item of this.content) {
      this.applyItem(item);
    }
  }

  private onMessage(msg: WebviewToHost) {
    switch (msg.type) {
      case "ready":
        this.webviewReady = true;
        for (const action of this.pending.splice(0)) {
          action();
        }
        break;
      case "requestAdd":
        // Reuse the same pickers as the commands; they call back into open().
        void vscode.commands.executeCommand(
          msg.kind === "colmap" ? "3dview.openReconstruction" : "3dview.openAsset"
        );
        break;
      case "removed":
        this.content = this.content.filter((i) => i.id !== msg.id);
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

  /** Run an item now if the webview is up, else queue it until "ready". */
  private applyItem(item: Item) {
    const action = () => {
      if (item.target.kind === "colmap") {
        void this.loadColmap(item.id, item.target.modelDir, item.target.imagesDir);
      } else {
        this.postAsset(item.id, item.target.file);
      }
    };
    if (this.webviewReady) {
      action();
    } else {
      this.pending.push(action);
    }
  }

  private async loadColmap(id: string, modelDir: string, imagesDir?: string) {
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
      this.post({ type: "addReconstruction", id, label: labelFor(modelDir), data, source: modelDir });
    } catch (err) {
      this.content = this.content.filter((i) => i.id !== id);
      this.reportError(err);
    }
  }

  private postAsset(id: string, file: string) {
    const uri = this.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
    const name = path.basename(file);
    this.post({ type: "addAsset", id, label: name, asset: { uri, name } });
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
      // webview resources (our resource origin). `data:` is required because the
      // Spark splat worker loads its WebAssembly by fetching an inlined
      // `data:application/wasm;base64,…` URL.
      `connect-src ${webview.cspSource} data:`,
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
