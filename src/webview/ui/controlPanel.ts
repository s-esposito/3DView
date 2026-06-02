// The control panel (top-right overlay): a collapsible, sectioned set of toggles
// and sliders. It is a thin view over the Viewer — it reads `getState()` /
// `getSummary()` to render and calls Viewer setters on interaction; the Viewer
// owns all state. Only controls for content that is actually present are shown.
import type { Viewer } from "../viewer";
import { section, hint, checkbox, slider, button } from "./components";

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
    panel.append(this.buildHeader(panel), this.buildBody(s));
    document.body.appendChild(panel);
  }

  private buildHeader(panel: HTMLElement): HTMLElement {
    const { points, cameras, meshName } = this.viewer.getSummary();
    const parts: string[] = [];
    if (points > 0) parts.push(`${points.toLocaleString()} points`);
    if (cameras > 0) parts.push(`${cameras} cameras`);
    if (meshName) parts.push(meshName);

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
    sub.textContent = parts.join(" · ") || "—";
    titles.append(title, sub);

    header.append(chevron, titles);
    header.addEventListener("click", () => {
      this.collapsed = !this.collapsed;
      panel.classList.toggle("collapsed", this.collapsed);
    });
    return header;
  }

  private buildBody(s: ReturnType<Viewer["getState"]>): HTMLElement {
    const body = document.createElement("div");
    body.className = "viewer-body";

    // Show — only toggles for content that exists.
    const toggles = document.createElement("div");
    toggles.className = "viewer-toggles";
    if (s.hasPoints) {
      toggles.append(
        checkbox("Points (P)", s.points, (on) => this.viewer.setVisible("points", on))
      );
    }
    if (s.hasCameras) {
      toggles.append(
        checkbox("Frustums (F)", s.frustums, (on) => this.viewer.setVisible("frustums", on)),
        checkbox("Images (I)", s.images, (on) => this.viewer.setVisible("images", on))
      );
    }
    if (s.hasMesh) {
      toggles.append(
        checkbox("Mesh (M)", s.mesh, (on) => this.viewer.setVisible("mesh", on))
      );
    }
    if (s.hasPoints) {
      toggles.append(checkbox("Box (B)", s.box, (on) => this.viewer.setVisible("box", on)));
    }
    toggles.append(
      checkbox("Grid (G)", s.grid, (on) => this.viewer.setVisible("grid", on)),
      checkbox("Axes (A)", s.axes, (on) => this.viewer.setVisible("axes", on))
    );
    body.append(section("Show", [toggles]));

    // Appearance — only sliders relevant to present content.
    const appearance: HTMLElement[] = [];
    if (s.hasPoints) {
      appearance.push(
        slider("Point size", 0.5, 6, 0.5, s.pointSize, (v) => this.viewer.setPointSize(v))
      );
    }
    if (s.hasCameras) {
      appearance.push(
        slider(
          "Frustum size",
          0,
          s.frustumScaleMax,
          s.frustumScaleMax / 80,
          s.frustumScale,
          (v) => this.viewer.setFrustumScale(v)
        )
      );
    }
    if (appearance.length > 0) {
      body.append(section("Appearance", appearance));
    }

    // View — orientation + reset (always relevant).
    body.append(
      section("View", [
        checkbox("Upright Y-up (U)", s.orientation === "upright", (on) =>
          this.viewer.setOrientation(on ? "upright" : "raw")
        ),
        button("Reset view (R)", () => this.viewer.resetView()),
      ])
    );

    if (s.hasCameras) {
      body.append(
        hint("Hover a frustum to highlight · click to view from it (Esc to exit)")
      );
    }
    return body;
  }
}
