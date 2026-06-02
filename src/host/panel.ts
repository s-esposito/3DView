import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { HostToWebview, WebviewToHost, ModelData } from "../shared/messages";
import { buildModelData } from "./modelData";

/** What the user asked to open. */
export type OpenTarget =
  | { kind: "colmap"; modelDir: string; imagesDir?: string }
  | { kind: "mesh"; file: string };

/** The content currently shown, so it can be replayed after a panel recreate. */
interface Content {
  colmap?: { modelDir: string; imagesDir?: string };
  mesh?: string;
}

/**
 * Owns the singleton webview panel. Content (a COLMAP reconstruction and/or a
 * mesh) coexists in one scene. `localResourceRoots` is fixed at panel creation,
 * so when a new target needs a folder the panel doesn't already allow, we
 * recreate it with the union of roots and replay the remembered content.
 */
export class ViewerPanel {
  public static current: ViewerPanel | undefined;
  private static readonly viewType = "3dviewer.viewer";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly allowedRoots: string[];
  private content: Content;
  private imagesRoot: string | undefined;
  private webviewReady = false;
  private readonly pending: Array<() => void> = [];

  /** Open a target, creating/revealing the panel and preserving existing content. */
  public static open(context: vscode.ExtensionContext, target: OpenTarget) {
    const column = vscode.window.activeTextEditor?.viewColumn;
    const current = ViewerPanel.current;

    // Intended content after applying this target (existing content carried over).
    const content: Content = current ? { ...current.content } : {};
    if (target.kind === "colmap") {
      content.colmap = { modelDir: target.modelDir, imagesDir: target.imagesDir };
    } else {
      content.mesh = target.file;
    }
    const roots = rootsFor(content);

    if (current && roots.every((r) => current.allowedRoots.includes(r))) {
      // Existing panel already allows everything we need: just apply the delta.
      current.content = content;
      current.panel.reveal(column);
      current.apply(target);
      return;
    }

    // Need a panel whose roots cover all content; recreate and replay.
    current?.dispose();
    const panel = ViewerPanel.create(context, column, roots, content);
    panel.replay();
  }

  private static create(
    context: vscode.ExtensionContext,
    column: vscode.ViewColumn | undefined,
    roots: string[],
    content: Content
  ): ViewerPanel {
    const localResourceRoots = [
      vscode.Uri.joinPath(context.extensionUri, "out"),
      ...roots.map((r) => vscode.Uri.file(r)),
    ];
    const webviewPanel = vscode.window.createWebviewPanel(
      ViewerPanel.viewType,
      "3DViewer",
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots,
      }
    );
    const panel = new ViewerPanel(webviewPanel, context, roots, content);
    ViewerPanel.current = panel;
    return panel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    roots: string[],
    content: Content
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

  /** Re-send all remembered content to a freshly created webview. */
  private replay() {
    if (this.content.colmap) {
      this.apply({ kind: "colmap", ...this.content.colmap });
    }
    if (this.content.mesh) {
      this.apply({ kind: "mesh", file: this.content.mesh });
    }
  }

  private onMessage(msg: WebviewToHost) {
    if (msg.type === "ready") {
      this.webviewReady = true;
      for (const action of this.pending.splice(0)) {
        action();
      }
    }
  }

  /** Run a target now if the webview is up, else queue it until "ready". */
  private apply(target: OpenTarget) {
    const action =
      target.kind === "colmap"
        ? () => this.loadColmap(target.modelDir, target.imagesDir)
        : () => this.postMesh(target.file);
    if (this.webviewReady) {
      action();
    } else {
      this.pending.push(action);
    }
  }

  private async loadColmap(modelDir: string, imagesDir?: string) {
    this.imagesRoot = imagesDir;
    try {
      const data = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "3DViewer: loading reconstruction…",
        },
        // Parsing is synchronous; defer a tick so the progress UI can paint.
        async () => Promise.resolve().then(() => buildModelData(modelDir))
      );
      this.attachImageUris(data);
      this.post({ type: "model", data });
    } catch (err) {
      this.reportError(err);
    }
  }

  private postMesh(file: string) {
    const uri = this.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
    this.post({ type: "mesh", mesh: { uri, name: path.basename(file) } });
  }

  /**
   * Resolve each camera's source image to a webview URI, when the file exists
   * under the allowed images root. Leaves `imageUri` undefined otherwise.
   */
  private attachImageUris(data: ModelData) {
    if (!this.imagesRoot) {
      return;
    }
    for (const cam of data.cameras) {
      const file = path.join(this.imagesRoot, cam.name);
      // Guard against `name` escaping the images root (e.g. "../secret").
      const rel = path.relative(this.imagesRoot, file);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        continue;
      }
      if (fs.existsSync(file)) {
        cam.imageUri = this.panel.webview
          .asWebviewUri(vscode.Uri.file(file))
          .toString();
      }
    }
  }

  private reportError(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    this.post({ type: "error", message });
    void vscode.window.showErrorMessage(`3DViewer: ${message}`);
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
      `script-src 'nonce-${nonce}'`,
      // Mesh loaders (glTF/OBJ/PLY) fetch the file and its sibling assets as
      // webview resources; allow connect to our own resource origin only.
      `connect-src ${webview.cspSource}`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>3DViewer</title>
  <style>
    html, body { margin: 0; height: 100%; overflow: hidden; background: #1e1e1e; }
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
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Absolute folders that must be in `localResourceRoots` for the given content. */
function rootsFor(content: Content): string[] {
  const roots = new Set<string>();
  if (content.colmap?.imagesDir) {
    roots.add(path.resolve(content.colmap.imagesDir));
  }
  if (content.mesh) {
    roots.add(path.resolve(path.dirname(content.mesh)));
  }
  return [...roots];
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
