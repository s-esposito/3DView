import * as vscode from "vscode";
import { ViewerPanel } from "./panel";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("3dviewer.openReconstruction", () => {
      ViewerPanel.createOrShow(context);
    })
  );
}

export function deactivate() {}
