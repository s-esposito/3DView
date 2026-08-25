// The control UI (top-right overlay): two stacked, independently-collapsible
// panels inside a #viewer-ui column — a "3DView" panel with scene-wide display
// controls (Show / Appearance / View), and a "Scene" panel below it (the item
// list + add menu). Both are thin views over the Viewer: they read `getState()`
// to render and call Viewer setters on interaction; the Viewer owns all state.
import type { Viewer, ViewerState, SceneItem, ThemeName } from "../viewer";
import { SPLAT_RENDER_MODES } from "../splats";
import type { SplatRenderMode } from "../splats";
import {
  section,
  hint,
  checkbox,
  slider,
  colorRow,
  button,
  choiceRow,
  vectorRow,
  iconButton,
  menuButton,
} from "./components";

// Inline (themeable, currentColor) eye glyphs for the per-item show/hide toggle.
const EYE_OPEN = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_CLOSED = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

// Theme-switcher glyphs (sun / moon / dimmed-sun), filled with currentColor.
const ICON_LIGHT = `<svg viewBox="0 0 36 36" aria-hidden="true" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M18 12a6 6 0 1 1 0 12 6 6 0 0 1 0-12Zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="M17 6.038a1 1 0 1 1 2 0v3a1 1 0 0 1-2 0v-3ZM24.244 7.742a1 1 0 1 1 1.618 1.176L24.1 11.345a1 1 0 1 1-1.618-1.176l1.763-2.427ZM29.104 13.379a1 1 0 0 1 .618 1.902l-2.854.927a1 1 0 1 1-.618-1.902l2.854-.927ZM29.722 20.795a1 1 0 0 1-.619 1.902l-2.853-.927a1 1 0 1 1 .618-1.902l2.854.927ZM25.862 27.159a1 1 0 0 1-1.618 1.175l-1.763-2.427a1 1 0 1 1 1.618-1.175l1.763 2.427ZM19 30.038a1 1 0 0 1-2 0v-3a1 1 0 1 1 2 0v3ZM11.755 28.334a1 1 0 0 1-1.618-1.175l1.764-2.427a1 1 0 1 1 1.618 1.175l-1.764 2.427ZM6.896 22.697a1 1 0 1 1-.618-1.902l2.853-.927a1 1 0 1 1 .618 1.902l-2.853.927ZM6.278 15.28a1 1 0 1 1 .618-1.901l2.853.927a1 1 0 1 1-.618 1.902l-2.853-.927ZM10.137 8.918a1 1 0 0 1 1.618-1.176l1.764 2.427a1 1 0 0 1-1.618 1.176l-1.764-2.427Z"/></svg>`;
const ICON_DARK = `<svg viewBox="0 0 36 36" aria-hidden="true" fill="currentColor"><path d="M12.5 8.473a10.968 10.968 0 0 1 8.785-.97 7.435 7.435 0 0 0-3.737 4.672l-.09.373A7.454 7.454 0 0 0 28.732 20.4a10.97 10.97 0 0 1-5.232 7.125l-.497.27c-5.014 2.566-11.175.916-14.234-3.813l-.295-.483C5.53 18.403 7.13 11.93 12.017 8.77l.483-.297Zm4.234.616a8.946 8.946 0 0 0-2.805.883l-.429.234A9 9 0 0 0 10.206 22.5l.241.395A9 9 0 0 0 22.5 25.794l.416-.255a8.94 8.94 0 0 0 2.167-1.99 9.433 9.433 0 0 1-2.782-.313c-5.043-1.352-8.036-6.535-6.686-11.578l.147-.491c.242-.745.573-1.44.972-2.078Z"/></svg>`;
const ICON_DIM = `<svg viewBox="0 0 36 36" aria-hidden="true" fill="currentColor"><path d="M5 21a1 1 0 0 1 1-1h24a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1ZM12 25a1 1 0 0 1 1-1h10a1 1 0 1 1 0 2H13a1 1 0 0 1-1-1ZM15 29a1 1 0 0 1 1-1h4a1 1 0 1 1 0 2h-4a1 1 0 0 1-1-1ZM18 13a6 6 0 0 1 5.915 7h-2.041A4.005 4.005 0 0 0 18 15a4 4 0 0 0-3.874 5h-2.041A6 6 0 0 1 18 13ZM17 7.038a1 1 0 1 1 2 0v3a1 1 0 0 1-2 0v-3ZM24.244 8.742a1 1 0 1 1 1.618 1.176L24.1 12.345a1 1 0 1 1-1.618-1.176l1.763-2.427ZM29.104 14.379a1 1 0 0 1 .618 1.902l-2.854.927a1 1 0 1 1-.618-1.902l2.854-.927ZM6.278 16.28a1 1 0 1 1 .618-1.901l2.853.927a1 1 0 1 1-.618 1.902l-2.853-.927ZM10.137 9.918a1 1 0 0 1 1.618-1.176l1.764 2.427a1 1 0 0 1-1.618 1.176l-1.764-2.427Z"/></svg>`;

// Four-way move arrows: the per-item transform (position + rotation) disclosure.
const ICON_MOVE = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/></svg>`;

// Play / pause, for a temporal item's timeline.
const ICON_PLAY = `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>`;

/** Button copy for the 3DGS render modes; keyed exhaustively, so adding a mode to
 *  SPLAT_RENDER_MODES fails to compile until it is described here. */
const SPLAT_MODE_COPY: Record<SplatRenderMode, { label: string; title: string }> = {
  splatting: { label: "Splats", title: "True Gaussian splatting, sorted per viewpoint (Spark)" },
  ellipsoids: { label: "Ellipsoids", title: "Each Gaussian as a solid oriented ellipsoid" },
  points: { label: "Points", title: "Each Gaussian's center as a point (fastest)" },
};

export class ControlPanel {
  private collapsed = false; // the 3DView (display) panel
  private sceneCollapsed = false; // the Scene panel
  /** Scene items whose transform fields are open, kept across panel re-renders. */
  private readonly transformOpen = new Set<string>();
  /** How to move each temporal item's playhead, by item id — repopulated on every
   *  render, so playback updates the live slider instead of rebuilding the panel. */
  private readonly playheads = new Map<string, (frame: number) => void>();

  constructor(private readonly viewer: Viewer) {}

  /** Render (or re-render) the UI from current Viewer state. */
  render(): void {
    document.getElementById("viewer-ui")?.remove();
    const s = this.viewer.getState();

    const ui = document.createElement("div");
    ui.id = "viewer-ui";
    ui.className = "viewer-ui";
    ui.append(this.buildDisplayPanel(s), this.buildScenePanel(s), buildVersion());
    document.body.appendChild(ui);
  }

  /** Move a temporal item's playhead (the Viewer's onFrame, during playback). */
  setPlayhead(id: string, frame: number): void {
    this.playheads.get(id)?.(frame);
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

    // Gaussians — how 3DGS assets are drawn; only when the scene holds one.
    if (s.hasSplat) {
      const modes = SPLAT_RENDER_MODES.map((value) => ({ value, ...SPLAT_MODE_COPY[value] }));
      body.append(
        section("Gaussians", [
          choiceRow(modes, s.splatMode, (mode) => this.viewer.setSplatMode(mode)),
        ])
      );
    }

    // Appearance — sliders relevant to present content.
    const appearance: HTMLElement[] = [];
    // One slider for every bare point cloud in the scene: a reconstruction's own
    // cloud and a point-cloud asset alike.
    if (s.hasPoints || s.hasPointCloud) {
      appearance.push(slider("Point size", 0.5, 6, 0.5, s.pointSize, (v) => this.viewer.setPointSize(v)));
    }
    if (s.hasCameras) {
      appearance.push(
        slider("Frustum size", 0, s.frustumScaleMax, s.frustumScaleMax / 80, s.frustumScale, (v) =>
          this.viewer.setFrustumScale(v)
        ),
        slider("Frustum line size", 1, 10, 0.5, s.frustumLineWidth, (v) =>
          this.viewer.setFrustumLineWidth(v)
        ),
        colorRow("Frustum color", s.frustumColor, (v) => this.viewer.setFrustumColor(v))
      );
    }
    if (s.trackSteps > 1) {
      // Trail length in time steps; at the far right the whole trajectory shows.
      // Opacity and density are how a few thousand overlapping trails stay readable.
      appearance.push(
        slider("Track trail", 2, s.trackSteps, 1, s.trackFrames, (v) =>
          this.viewer.setTrackFrames(v)
        ),
        slider("Track opacity", 0.05, 1, 0.05, s.trackOpacity, (v) =>
          this.viewer.setTrackOpacity(v)
        ),
        slider("Track density", 0.05, 1, 0.05, s.trackDensity, (v) =>
          this.viewer.setTrackDensity(v)
        )
      );
    }
    if (s.items.some((i) => i.frameCount > 0)) {
      // One rate for every temporal item: each owns its playhead, but they share a
      // clock, which keeps the per-item rows to a scrubber and a play button.
      appearance.push(
        slider("Playback fps", 1, 60, 1, s.playbackFps, (v) => this.viewer.setPlaybackFps(v))
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

    // Camera — controls OrbitControls' drag can't reach: perspective FOV and a
    // roll (tilt) about the view axis. Reset snaps both sliders back to default.
    body.append(
      section("Camera", [
        slider("Field of view", 20, 90, 1, s.fov, (v) => this.viewer.setFov(v)),
        slider("Roll (tilt)°", -180, 180, 1, s.roll, (v) => this.viewer.setRoll(v)),
        button("Reset camera", () => {
          this.viewer.resetCamera();
          this.render(); // a click, not a keystroke — re-reading the sliders is safe
        }),
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

    // One entry per loadable kind. The asset entries differ only in how the host
    // filters its file picker — what a file actually is comes from the file itself
    // (a .ply is a mesh, a point cloud or a splat, by what is in it), so a "wrong"
    // entry still loads it.
    const add = menuButton("+", "Add to scene", [
      { label: "COLMAP…", onClick: () => this.viewer.requestAdd("colmap") },
      { label: "Mesh…", onClick: () => this.viewer.requestAdd("mesh") },
      { label: "Point cloud…", onClick: () => this.viewer.requestAdd("cloud") },
      { label: "3DGS…", onClick: () => this.viewer.requestAdd("splat") },
      { label: "Tracks…", onClick: () => this.viewer.requestAdd("tracks") },
      // Every asset in a folder, as one temporal item — a per-frame capture, and the
      // way in where a host's file dialog can't select several files at once.
      { label: "Asset folder…", onClick: () => this.viewer.requestAdd("assetFolder") },
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
    this.playheads.clear(); // the rows below re-register the ones that still exist

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

      const editor = this.buildTransformEditor(item, s.positionStep);
      editor.hidden = !this.transformOpen.has(item.id);

      row.append(this.visibilityToggle(item), label, kind);
      if (item.frameCount > 0) {
        // What marks an item as temporal in the Scene list.
        const frames = document.createElement("span");
        frames.className = "kind temporal";
        frames.textContent = `⏱ ${item.frameCount}`;
        frames.title = `Temporal item — ${item.frameCount} frames`;
        row.append(frames);
      }
      row.append(
        this.transformToggle(item, editor),
        iconButton("✎", "Rename", () => this.startRename(label, item)),
        iconButton("✕", "Remove", () => this.viewer.removeItem(item.id))
      );
      body.append(row);
      if (item.frameCount > 1) {
        body.append(this.buildTimeline(item));
      }
      body.append(editor);
    }
    return body;
  }

  /**
   * A temporal item's timeline: play/pause, a scrubber, and where it is. Always
   * shown (no disclosure — a timeline you have to unfold is one you forget), and it
   * drives the Viewer directly: scrubbing must not re-render the panel, or the drag
   * would lose the element under the pointer. Playback comes back the other way,
   * through `playheads`.
   */
  private buildTimeline(item: SceneItem): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "viewer-timeline";

    let playing = item.playing;
    const play = document.createElement("button");
    play.className = "viewer-iconbtn";
    const paintPlay = () => {
      play.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
      play.title = playing ? "Pause" : "Play";
    };
    play.addEventListener("click", () => {
      playing = !playing;
      this.viewer.setItemPlaying(item.id, playing);
      paintPlay();
    });
    paintPlay();

    const range = document.createElement("input");
    range.type = "range";
    range.min = "1";
    range.max = String(item.frameCount);
    range.step = "1";
    range.value = String(item.frame + 1);

    const at = document.createElement("span");
    at.className = "viewer-timeline-at";
    const paintAt = (frame: number) => {
      at.textContent = `${frame + 1}/${item.frameCount}`;
    };
    paintAt(item.frame);

    range.addEventListener("input", () => {
      const frame = Number(range.value) - 1;
      this.viewer.setItemFrame(item.id, frame);
      paintAt(frame);
    });
    // Playback moves the same two controls, without rebuilding them.
    this.playheads.set(item.id, (frame) => {
      range.value = String(frame + 1);
      paintAt(frame);
    });

    wrap.append(play, range, at);
    return wrap;
  }

  /** Move-arrows button that shows/hides an item's transform fields in place. */
  private transformToggle(item: SceneItem, editor: HTMLElement): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "viewer-iconbtn";
    btn.innerHTML = ICON_MOVE;
    btn.title = "Position / rotation";
    btn.setAttribute("aria-expanded", String(!editor.hidden));
    btn.addEventListener("click", () => {
      editor.hidden = !editor.hidden;
      if (editor.hidden) {
        this.transformOpen.delete(item.id);
      } else {
        this.transformOpen.add(item.id);
      }
      btn.setAttribute("aria-expanded", String(!editor.hidden));
    });
    return btn;
  }

  /**
   * Per-item position + rotation fields, Blender-style: the item's own placement in
   * the scene. Edits go straight to the Viewer and update nothing else in the panel,
   * so a field keeps focus while it is being typed in or nudged.
   */
  private buildTransformEditor(item: SceneItem, positionStep: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "viewer-xform";

    const reset = document.createElement("button");
    reset.className = "viewer-xform-reset";
    reset.textContent = "Reset";
    reset.title = "Back to the origin, unrotated";
    reset.addEventListener("click", () => {
      this.viewer.resetItemTransform(item.id);
      this.render(); // a click, not a keystroke — re-reading the fields is safe here
    });

    wrap.append(
      vectorRow("Position", item.transform.position, positionStep, (v) =>
        this.viewer.setItemTransform(item.id, { position: v })
      ),
      vectorRow("Rotation°", item.transform.rotation, 1, (v) =>
        this.viewer.setItemTransform(item.id, { rotation: v })
      ),
      reset
    );
    return wrap;
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

/** A small muted "v<x.y.z>" caption under the panels; the running build's version
 *  (`__APP_VERSION__` is inlined from package.json at build time). */
function buildVersion(): HTMLElement {
  const el = document.createElement("div");
  el.className = "viewer-version";
  el.textContent = `v${__APP_VERSION__}`;
  el.title = "3DView version";
  return el;
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
