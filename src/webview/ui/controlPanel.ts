// The control panel (top-right overlay): a collapsible panel with a Scene list
// (add / remove / show-hide items) and scene-wide display controls. It is a thin
// view over the Viewer — it reads `getState()` to render and calls Viewer setters
// on interaction; the Viewer owns all state.
import type { Viewer, ViewerState } from "../viewer";
import { section, hint, checkbox, slider, button, iconButton, menuButton } from "./components";

export class ControlPanel {
  private collapsed = false;

  constructor(private readonly viewer: Viewer) {}

  /** Render (or re-render) the panel from current Viewer state. */
  render(): void {
    document.getElementById("overlay")?.remove();
    const s = this.viewer.getState();

    const panel = document.createElement("div");
    panel.id = "overlay";
    panel.className = this.collapsed ? "viewer-panel collapsed" : "viewer-panel";
    panel.append(this.buildHeader(panel, s), this.buildBody(s));
    document.body.appendChild(panel);
  }

  private buildHeader(panel: HTMLElement, s: ViewerState): HTMLElement {
    const recon = s.items.filter((i) => i.kind === "reconstruction").length;
    const meshes = s.items.filter((i) => i.kind === "mesh").length;
    const parts: string[] = [];
    if (recon) parts.push(`${recon} reconstruction${recon > 1 ? "s" : ""}`);
    if (meshes) parts.push(`${meshes} mesh${meshes > 1 ? "es" : ""}`);

    const header = document.createElement("div");
    header.className = "viewer-header";
    header.title = "Collapse / expand";

    const chevron = document.createElement("span");
    chevron.className = "viewer-chevron";
    chevron.textContent = "▾";

    const titles = document.createElement("div");
    titles.className = "viewer-titles";
    const title = document.createElement("span");
    title.className = "viewer-title";
    title.textContent = "3DViewer";
    const sub = document.createElement("span");
    sub.className = "viewer-sub";
    sub.textContent = parts.join(" · ") || "empty scene";
    titles.append(title, sub);

    header.append(chevron, titles);
    header.addEventListener("click", () => {
      this.collapsed = !this.collapsed;
      panel.classList.toggle("collapsed", this.collapsed);
    });
    return header;
  }

  private buildBody(s: ViewerState): HTMLElement {
    const body = document.createElement("div");
    body.className = "viewer-body";
    body.append(this.buildScene(s));

    // Show — scene-wide visibility toggles, only for content that exists.
    const toggles = document.createElement("div");
    toggles.className = "viewer-toggles";
    if (s.hasPoints) {
      toggles.append(checkbox("Points (P)", s.points, (on) => this.viewer.setGlobal("points", on)));
    }
    if (s.hasCameras) {
      toggles.append(
        checkbox("Frustums (F)", s.frustums, (on) => this.viewer.setGlobal("frustums", on)),
        checkbox("Images (I)", s.images, (on) => this.viewer.setGlobal("images", on))
      );
    }
    if (s.hasPoints || s.hasMesh) {
      toggles.append(checkbox("Box (B)", s.box, (on) => this.viewer.setGlobal("box", on)));
    }
    toggles.append(
      checkbox("Grid (G)", s.grid, (on) => this.viewer.setGlobal("grid", on)),
      checkbox("Axes (A)", s.axes, (on) => this.viewer.setGlobal("axes", on))
    );
    body.append(section("Show", [toggles]));

    // Appearance — sliders relevant to present content.
    const appearance: HTMLElement[] = [];
    if (s.hasPoints) {
      appearance.push(slider("Point size", 0.5, 6, 0.5, s.pointSize, (v) => this.viewer.setPointSize(v)));
    }
    if (s.hasCameras) {
      appearance.push(
        slider("Frustum size", 0, s.frustumScaleMax, s.frustumScaleMax / 80, s.frustumScale, (v) =>
          this.viewer.setFrustumScale(v)
        )
      );
    }
    if (appearance.length > 0) {
      body.append(section("Appearance", appearance));
    }

    // View — orientation + reset.
    body.append(
      section("View", [
        checkbox("Upright Y-up (U)", s.orientation === "upright", (on) =>
          this.viewer.setOrientation(on ? "upright" : "raw")
        ),
        button("Reset view (R)", () => this.viewer.resetView()),
      ])
    );

    if (s.hasCameras) {
      body.append(hint("Hover a frustum to highlight · click to view from it (Esc to exit)"));
    }
    return body;
  }

  /** Scene list: each item with show/hide + remove, and a "+" add menu. */
  private buildScene(s: ViewerState): HTMLElement {
    const sec = document.createElement("div");
    sec.className = "viewer-section";

    const head = document.createElement("div");
    head.className = "viewer-section-head";
    const title = document.createElement("div");
    title.className = "viewer-section-title";
    title.textContent = "Scene";
    head.append(
      title,
      menuButton("+", "Add to scene", [
        { label: "Reconstruction…", onClick: () => this.viewer.requestAdd("colmap") },
        { label: "Mesh…", onClick: () => this.viewer.requestAdd("mesh") },
      ])
    );
    sec.append(head);

    if (s.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "viewer-scene-empty";
      empty.textContent = "Empty — add a reconstruction or mesh";
      sec.append(empty);
      return sec;
    }

    for (const item of s.items) {
      const row = document.createElement("div");
      row.className = "viewer-scene-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = item.visible;
      cb.title = "Show / hide";
      cb.addEventListener("change", () => this.viewer.setItemVisible(item.id, cb.checked));
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = item.label;
      label.title = item.label;
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = item.kind === "reconstruction" ? "recon" : "mesh";
      row.append(cb, label, kind, iconButton("✕", "Remove", () => this.viewer.removeItem(item.id)));
      sec.append(row);
    }
    return sec;
  }
}
