import * as vscode from "vscode";
import * as path from "node:path";
import { labelFor, pathOf, type OpenTarget } from "./panel";

const KEY = "3dview.recents";
const CAP = 10;

/** Display label: a model dir reuses the panel's label rule; a mesh its basename. */
function labelOf(t: OpenTarget): string {
  return t.kind === "colmap" ? labelFor(t.modelDir) : path.basename(t.file);
}

/**
 * The Activity Bar "3DView" view: a recents launcher. Backed by per-workspace
 * `workspaceState`, it lists recently opened reconstructions/meshes (click to
 * re-open) and accepts dropped folders/mesh files via the drag-and-drop
 * controller. The host records entries through `add()` whenever something opens.
 */
export class RecentsProvider
  implements vscode.TreeDataProvider<OpenTarget>, vscode.TreeDragAndDropController<OpenTarget>
{
  readonly dropMimeTypes = ["text/uri-list"];
  readonly dragMimeTypes: string[] = [];

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    /** Called with dropped resource URIs; the host resolves folder vs. mesh. */
    private readonly onDrop: (uris: vscode.Uri[]) => void
  ) {}

  private list(): OpenTarget[] {
    return this.context.workspaceState.get<OpenTarget[]>(KEY, []);
  }

  private async persist(list: OpenTarget[]): Promise<void> {
    await this.context.workspaceState.update(KEY, list);
    this.changed.fire();
  }

  /** Record (or bump to front) a freshly opened item. */
  add(t: OpenTarget): void {
    const next = [t, ...this.list().filter((x) => pathOf(x) !== pathOf(t))].slice(0, CAP);
    void this.persist(next);
  }

  remove(t: OpenTarget): void {
    void this.persist(this.list().filter((x) => pathOf(x) !== pathOf(t)));
  }

  clear(): void {
    void this.persist([]);
  }

  // --- TreeDataProvider ----------------------------------------------------
  getChildren(element?: OpenTarget): OpenTarget[] {
    return element ? [] : this.list();
  }

  getTreeItem(t: OpenTarget): vscode.TreeItem {
    const item = new vscode.TreeItem(labelOf(t), vscode.TreeItemCollapsibleState.None);
    item.description = path.dirname(pathOf(t));
    item.tooltip = pathOf(t);
    item.iconPath = new vscode.ThemeIcon(t.kind === "colmap" ? "layers" : "package");
    item.contextValue = "recent";
    item.command = { command: "3dview.openRecent", title: "Open", arguments: [t] };
    return item;
  }

  // --- TreeDragAndDropController -------------------------------------------
  async handleDrop(
    _target: OpenTarget | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const item = dataTransfer.get("text/uri-list");
    if (!item) {
      return;
    }
    const uris = (await item.asString())
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => vscode.Uri.parse(line));
    if (uris.length > 0) {
      this.onDrop(uris);
    }
  }
}
