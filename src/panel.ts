import * as vscode from "vscode";
import type { HostToWebview, WebviewToHost } from "./messages";

/**
 * Owns the singleton webview panel that hosts the 3D viewer UI.
 * Foundation only: opens the panel, loads the bundled webview, and wires up
 * two-way message passing. Reconstruction loading/rendering comes later.
 */
export class ViewerPanel {
  public static current: ViewerPanel | undefined;
  private static readonly viewType = "3dviewer.viewer";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  public static createOrShow(context: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor?.viewColumn;

    if (ViewerPanel.current) {
      ViewerPanel.current.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      ViewerPanel.viewType,
      "3DViewer",
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "out")],
      }
    );

    ViewerPanel.current = new ViewerPanel(panel, context);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(context.extensionUri);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewToHost) => this.onMessage(msg),
      null,
      this.disposables
    );
  }

  private onMessage(msg: WebviewToHost) {
    switch (msg.type) {
      case "ready":
        // Webview finished loading; reply so the round-trip wiring is exercised.
        this.post({ type: "ready" });
        break;
    }
  }

  private post(msg: HostToWebview) {
    void this.panel.webview.postMessage(msg);
  }

  private dispose() {
    ViewerPanel.current = undefined;
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
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>3DViewer</title>
  <style>
    html, body { margin: 0; height: 100%; overflow: hidden; }
    #app {
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--vscode-font-family);
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div id="app">Loading…</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
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
