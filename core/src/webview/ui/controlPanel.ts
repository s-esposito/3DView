// The control UI (top-right overlay): two stacked, independently-collapsible
// panels inside a #viewer-ui column — a "3DView" panel with scene-wide display
// controls (Show / Appearance / View), and a "Scene" panel below it (the item
// list + add menu). Both are thin views over the Viewer: they read `getState()`
// to render and call Viewer setters on interaction; the Viewer owns all state.
import type { Viewer, ViewerState, SceneItem, ThemeName } from "../viewer";
import { section, hint, checkbox, slider, button, iconButton, menuButton } from "./components";

// Inline (themeable, currentColor) eye glyphs for the per-item show/hide toggle.
const EYE_OPEN = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_CLOSED = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

// Theme-switcher glyphs (sun / moon / dimmed-sun), filled with currentColor.
const ICON_LIGHT = `<svg viewBox="0 0 36 36" aria-hidden="true" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M18 12a6 6 0 1 1 0 12 6 6 0 0 1 0-12Zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="M17 6.038a1 1 0 1 1 2 0v3a1 1 0 0 1-2 0v-3ZM24.244 7.742a1 1 0 1 1 1.618 1.176L24.1 11.345a1 1 0 1 1-1.618-1.176l1.763-2.427ZM29.104 13.379a1 1 0 0 1 .618 1.902l-2.854.927a1 1 0 1 1-.618-1.902l2.854-.927ZM29.722 20.795a1 1 0 0 1-.619 1.902l-2.853-.927a1 1 0 1 1 .618-1.902l2.854.927ZM25.862 27.159a1 1 0 0 1-1.618 1.175l-1.763-2.427a1 1 0 1 1 1.618-1.175l1.763 2.427ZM19 30.038a1 1 0 0 1-2 0v-3a1 1 0 1 1 2 0v3ZM11.755 28.334a1 1 0 0 1-1.618-1.175l1.764-2.427a1 1 0 1 1 1.618 1.175l-1.764 2.427ZM6.896 22.697a1 1 0 1 1-.618-1.902l2.853-.927a1 1 0 1 1 .618 1.902l-2.853.927ZM6.278 15.28a1 1 0 1 1 .618-1.901l2.853.927a1 1 0 1 1-.618 1.902l-2.853-.927ZM10.137 8.918a1 1 0 0 1 1.618-1.176l1.764 2.427a1 1 0 0 1-1.618 1.176l-1.764-2.427Z"/></svg>`;
const ICON_DARK = `<svg viewBox="0 0 36 36" aria-hidden="true" fill="currentColor"><path d="M12.5 8.473a10.968 10.968 0 0 1 8.785-.97 7.435 7.435 0 0 0-3.737 4.672l-.09.373A7.454 7.454 0 0 0 28.732 20.4a10.97 10.97 0 0 1-5.232 7.125l-.497.27c-5.014 2.566-11.175.916-14.234-3.813l-.295-.483C5.53 18.403 7.13 11.93 12.017 8.77l.483-.297Zm4.234.616a8.946 8.946 0 0 0-2.805.883l-.429.234A9 9 0 0 0 10.206 22.5l.241.395A9 9 0 0 0 22.5 25.794l.416-.255a8.94 8.94 0 0 0 2.167-1.99 9.433 9.433 0 0 1-2.782-.313c-5.043-1.352-8.036-6.535-6.686-11.578l.147-.491c.242-.745.573-1.44.972-2.078Z"/></svg>`;
const ICON_DIM = `<svg viewBox="0 0 36 36" aria-hidden="true" fill="currentColor"><path d="M5 21a1 1 0 0 1 1-1h24a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1ZM12 25a1 1 0 0 1 1-1h10a1 1 0 1 1 0 2H13a1 1 0 0 1-1-1ZM15 29a1 1 0 0 1 1-1h4a1 1 0 1 1 0 2h-4a1 1 0 0 1-1-1ZM18 13a6 6 0 0 1 5.915 7h-2.041A4.005 4.005 0 0 0 18 15a4 4 0 0 0-3.874 5h-2.041A6 6 0 0 1 18 13ZM17 7.038a1 1 0 1 1 2 0v3a1 1 0 0 1-2 0v-3ZM24.244 8.742a1 1 0 1 1 1.618 1.176L24.1 12.345a1 1 0 1 1-1.618-1.176l1.763-2.427ZM29.104 14.379a1 1 0 0 1 .618 1.902l-2.854.927a1 1 0 1 1-.618-1.902l2.854-.927ZM6.278 16.28a1 1 0 1 1 .618-1.901l2.853.927a1 1 0 1 1-.618 1.902l-2.853-.927ZM10.137 9.918a1 1 0 0 1 1.618-1.176l1.764 2.427a1 1 0 0 1-1.618 1.176l-1.764-2.427Z"/></svg>`;

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
    // Expose the header as a real toggle button to keyboard / screen-reader users:
    // focusable, announced as a button, with its collapsed state in aria-expanded.
    header.setAttribute("role", "button");
    header.tabIndex = 0;
    header.setAttribute("aria-label", `${title} panel`);
    header.setAttribute("aria-expanded", String(!panel.classList.contains("collapsed")));

    const chevron = document.createElement("span");
    chevron.className = "viewer-chevron";
    chevron.textContent = "▾";
    chevron.setAttribute("aria-hidden", "true"); // decorative; aria-expanded conveys state

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
    const flip = () => {
      toggle();
      const collapsed = panel.classList.toggle("collapsed");
      header.setAttribute("aria-expanded", String(!collapsed));
    };
    header.addEventListener("click", flip);
    header.addEventListener("keydown", (e) => {
      // Only the header itself toggles; ignore keys bubbling from the action (the
      // "+" menu button is independently focusable and handles its own keys).
      if (e.target !== header || (e.key !== "Enter" && e.key !== " ")) {
        return;
      }
      e.preventDefault(); // Space would otherwise scroll the page
      flip();
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

    // Theme — light/dark/dim color scheme for the UI and the 3D viewport.
    body.append(section("Theme", [this.buildThemeSwitcher(s)]));

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

  /**
   * A 3-segment glass switcher (light/dark/dim) with a sliding thumb, modeled on
   * the reference "Liquid Glass Switcher". It updates in place (no panel
   * re-render) and drives Viewer.setTheme, which retones the CSS palette + the
   * 3D viewport via `body[data-viewer-theme]`.
   */
  private buildThemeSwitcher(s: ViewerState): HTMLElement {
    const opts: { val: ThemeName; label: string; icon: string }[] = [
      { val: "light", label: "Light", icon: ICON_LIGHT },
      { val: "dark", label: "Dark", icon: ICON_DARK },
      { val: "dim", label: "Dim", icon: ICON_DIM },
    ];

    const seg = document.createElement("div");
    seg.className = "viewer-seg";
    seg.dataset.active = s.theme; // positions the thumb via CSS
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", "Theme color scheme");

    const thumb = document.createElement("div");
    thumb.className = "viewer-seg-thumb";
    thumb.setAttribute("aria-hidden", "true");
    seg.append(thumb);

    for (const o of opts) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "viewer-seg-opt";
      btn.innerHTML = o.icon;
      btn.title = `${o.label} theme`;
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-label", o.label);
      btn.setAttribute("aria-checked", String(o.val === s.theme));
      btn.addEventListener("click", () => {
        if (seg.dataset.active === o.val) {
          return;
        }
        seg.dataset.active = o.val; // slides the thumb (CSS transition)
        seg
          .querySelectorAll(".viewer-seg-opt")
          .forEach((el) => el.setAttribute("aria-checked", String(el === btn)));
        // Replay the squish each switch (independent `scale`, like the reference).
        thumb.classList.remove("squish");
        void thumb.offsetWidth; // reflow so the animation restarts
        thumb.classList.add("squish");
        this.viewer.setTheme(o.val);
      });
      seg.append(btn);
    }
    return seg;
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
      empty.textContent = "Empty — drop or add a reconstruction or asset";
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

/**
 * Wrap a panel body so the `.collapsed` grid-rows transition animates its height.
 * The grid's child must be a padding-free clip layer (`.viewer-clip`): the padded
 * `.viewer-body` itself can't be the grid item, because an item's padding is added
 * to its min-content size and floors the `0fr` row at ~18px (the panel then never
 * closes fully). The padding lives on the grandchild instead.
 */
function collapseWrap(body: HTMLElement): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "viewer-collapse";
  const clip = document.createElement("div");
  clip.className = "viewer-clip";
  clip.append(body);
  wrap.append(clip);
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
