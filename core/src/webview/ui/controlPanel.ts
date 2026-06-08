// The control UI (top-right overlay): two stacked, independently-collapsible
// panels inside a #viewer-ui column — a "3DView" panel with scene-wide display
// controls (Show / Appearance / View), and a "Scene" panel below it (the item
// list + add menu). Both are thin views over the Viewer: they read `getState()`
// to render and call Viewer setters on interaction; the Viewer owns all state.
import type { Viewer, ViewerState, SceneItem } from "../viewer";
import { section, hint, checkbox, slider, button, iconButton, menuButton } from "./components";

// Inline (themeable, currentColor) eye glyphs for the per-item show/hide toggle.
const EYE_OPEN = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_CLOSED = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

export class ControlPanel {
  private collapsed = false; // the 3DView (display) panel
  private sceneCollapsed = false; // the Scene panel

  constructor(private readonly viewer: Viewer) {}

  /** Render (or re-render) the UI from current Viewer state. */
  render(): void {
    document.getElementById("viewer-ui")?.remove();
    const s = this.viewer.getState();

    const ui = document.createElement("div");
    ui.id = "viewer-ui";
    ui.className = "viewer-ui";
    ui.append(this.buildDisplayPanel(s), this.buildScenePanel(s));
    document.body.appendChild(ui);
  }

  /** A collapsible panel header: chevron + title (+ optional subtitle + action). */
  private header(
    panel: HTMLElement,
    title: string,
    subtitle: string | null,
    toggle: () => void,
    action?: HTMLElement
  ): HTMLElement {
    const header = document.createElement("div");
    header.className = "viewer-header";
    header.title = "Collapse / expand";

    const chevron = document.createElement("span");
    chevron.className = "viewer-chevron";
    chevron.textContent = "▾";

    const titles = document.createElement("div");
    titles.className = "viewer-titles";
    const titleEl = document.createElement("span");
    titleEl.className = "viewer-title";
    titleEl.textContent = title;
    titles.append(titleEl);
    if (subtitle !== null) {
      const sub = document.createElement("span");
      sub.className = "viewer-sub";
      sub.textContent = subtitle;
      titles.append(sub);
    }

    header.append(chevron, titles);
    if (action) {
      // The action (e.g. the "+" menu) stops its own click from bubbling here.
      header.append(action);
    }
    header.addEventListener("click", () => {
      toggle();
      panel.classList.toggle("collapsed");
    });
    return header;
  }

  /** The 3DView panel: scene-wide display controls. */
  private buildDisplayPanel(s: ViewerState): HTMLElement {
    const panel = document.createElement("div");
    panel.className = this.collapsed ? "viewer-panel collapsed" : "viewer-panel";
    panel.append(
      this.header(panel, "3DView", null, () => {
        this.collapsed = !this.collapsed;
      }),
      collapseWrap(this.buildDisplayBody(s))
    );
    return panel;
  }

  private buildDisplayBody(s: ViewerState): HTMLElement {
    const body = document.createElement("div");
    body.className = "viewer-body";

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
    if (s.hasPoints || s.hasAsset) {
      toggles.append(checkbox("Box (B)", s.box, (on) => this.viewer.setGlobal("box", on)));
    }
    if (s.hasAsset) {
      toggles.append(
        checkbox("Shaded (S)", s.shaded, (on) => this.viewer.setGlobal("shaded", on)),
        checkbox("Wireframe (W)", s.wireframe, (on) => this.viewer.setGlobal("wireframe", on))
      );
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

    // Render viewpoint — save a PNG of the current view at 1×/2×/4× resolution.
    if (s.items.length > 0) {
      const scales = document.createElement("div");
      scales.className = "viewer-scale-row";
      for (const sc of [1, 2, 4]) {
        const b = document.createElement("button");
        b.className = "viewer-scale-btn";
        b.textContent = `${sc}×`;
        b.title = `Save a PNG of the current view at ${sc}× resolution`;
        b.addEventListener("click", () => this.viewer.saveViewpoint(sc));
        scales.append(b);
      }
      body.append(section("Render viewpoint", [scales]));
    }

    if (s.hasCameras) {
      body.append(hint("Hover a frustum to highlight · click to view from it (Esc to exit)"));
    }
    return body;
  }

  /** The Scene panel: a "+" add menu in the header + the item list as the body. */
  private buildScenePanel(s: ViewerState): HTMLElement {
    const panel = document.createElement("div");
    panel.className = this.sceneCollapsed ? "viewer-panel collapsed" : "viewer-panel";

    const add = menuButton("+", "Add to scene", [
      { label: "Reconstruction…", onClick: () => this.viewer.requestAdd("colmap") },
      { label: "Asset…", onClick: () => this.viewer.requestAdd("asset") },
    ]);

    panel.append(
      this.header(
        panel,
        "Scene",
        sceneSummary(s),
        () => {
          this.sceneCollapsed = !this.sceneCollapsed;
        },
        add
      ),
      collapseWrap(this.buildSceneBody(s))
    );
    return panel;
  }

  private buildSceneBody(s: ViewerState): HTMLElement {
    const body = document.createElement("div");
    body.className = "viewer-body";

    if (s.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "viewer-scene-empty";
      empty.textContent = "Empty — add a reconstruction or asset";
      body.append(empty);
      return body;
    }

    for (const item of s.items) {
      const row = document.createElement("div");
      row.className = "viewer-scene-item";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = item.label;
      label.title = item.source ? sourcePath(item.source) : item.label;
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = item.kind === "reconstruction" ? "recon" : "asset";
      row.append(
        this.visibilityToggle(item),
        label,
        kind,
        iconButton("✎", "Rename", () => this.startRename(label, item)),
        iconButton("✕", "Remove", () => this.viewer.removeItem(item.id))
      );
      body.append(row);
    }
    return body;
  }

  /** Open-/closed-eye button that toggles a scene item's visibility in place. */
  private visibilityToggle(item: SceneItem): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "viewer-iconbtn";
    let visible = item.visible;
    const paint = () => {
      btn.innerHTML = visible ? EYE_OPEN : EYE_CLOSED;
      btn.title = visible ? "Hide" : "Show";
    };
    paint();
    btn.addEventListener("click", () => {
      visible = !visible;
      this.viewer.setItemVisible(item.id, visible);
      paint();
    });
    return btn;
  }

  /** Replace a scene item's label with an inline text field; commit on Enter/blur, cancel on Esc. */
  private startRename(label: HTMLElement, item: SceneItem): void {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "viewer-rename";
    input.value = item.label;
    let done = false;
    const finish = (save: boolean) => {
      if (done) {
        return;
      }
      done = true;
      const next = input.value.trim();
      if (save && next && next !== item.label) {
        this.viewer.renameItem(item.id, next); // fires onChange → re-render
      } else {
        input.replaceWith(label); // cancel: restore the original label in place
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    label.replaceWith(input);
    input.focus();
    input.select();
  }
}

/** Wrap a panel body so the `.collapsed` grid-rows transition animates its height. */
function collapseWrap(body: HTMLElement): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "viewer-collapse";
  wrap.append(body);
  return wrap;
}

/** Strip a leading http(s) origin from a host URI so the tooltip reads as a file path. */
function sourcePath(uri: string): string {
  return uri.replace(/^https?:\/\/[^/]+/i, "");
}

/** Human-readable scene summary, e.g. "1 reconstruction · 2 assets". */
function sceneSummary(s: ViewerState): string {
  const recon = s.items.filter((i) => i.kind === "reconstruction").length;
  const assets = s.items.filter((i) => i.kind === "asset").length;
  const parts: string[] = [];
  if (recon) {
    parts.push(`${recon} reconstruction${recon > 1 ? "s" : ""}`);
  }
  if (assets) {
    parts.push(`${assets} asset${assets > 1 ? "s" : ""}`);
  }
  return parts.join(" · ") || "empty scene";
}
