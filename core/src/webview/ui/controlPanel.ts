// The control UI. On the right (#viewer-ui), an icon rail and the one panel it has open, at
// full height: "Scene" (the item list + add menu), "Display" (scene-wide Show / Appearance /
// View / Camera), "Physics" while the scene holds a chunked object, "Capture" once it holds
// anything; under them the footer (backend, version, theme). At the bottom (#viewer-transport),
// the simulation's playback bar while there is something to simulate. All are thin views over
// the Viewer: they read `getState()` to render and call Viewer setters on interaction; the
// Viewer owns all state.
import type { Viewer, ViewerState, SceneItem, ItemType, ThemeName, PhysicsItem, PhysicsAction, PhysicsView, ClickMode } from "../viewer";
import type { PhysicsPreset } from "../physics/run";
import { EARTH_GRAVITY } from "../physics/sim";
import { DEFAULT_FOV } from "../cameraInteraction";
import { SPLAT_RENDER_MODES } from "../splats";
import type { SplatRenderMode } from "../splats";
import {
  section,
  subsection,
  hint,
  checkbox,
  slider,
  colorRow,
  button,
  choiceRow,
  vectorRow,
  iconButton,
  menuButton,
  isTouchOnly,
  withKey,
} from "./components";
import { showShortcuts } from "./overlays";

// Inline (themeable, currentColor) eye glyphs for the per-item show/hide toggle.
const EYE_OPEN = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_CLOSED = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

// Theme-switcher glyphs (sun / moon / dimmed-sun), filled with currentColor.
const ICON_LIGHT = `<svg viewBox="0 0 36 36" aria-hidden="true" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M18 12a6 6 0 1 1 0 12 6 6 0 0 1 0-12Zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="M17 6.038a1 1 0 1 1 2 0v3a1 1 0 0 1-2 0v-3ZM24.244 7.742a1 1 0 1 1 1.618 1.176L24.1 11.345a1 1 0 1 1-1.618-1.176l1.763-2.427ZM29.104 13.379a1 1 0 0 1 .618 1.902l-2.854.927a1 1 0 1 1-.618-1.902l2.854-.927ZM29.722 20.795a1 1 0 0 1-.619 1.902l-2.853-.927a1 1 0 1 1 .618-1.902l2.854.927ZM25.862 27.159a1 1 0 0 1-1.618 1.175l-1.763-2.427a1 1 0 1 1 1.618-1.175l1.763 2.427ZM19 30.038a1 1 0 0 1-2 0v-3a1 1 0 1 1 2 0v3ZM11.755 28.334a1 1 0 0 1-1.618-1.175l1.764-2.427a1 1 0 1 1 1.618 1.175l-1.764 2.427ZM6.896 22.697a1 1 0 1 1-.618-1.902l2.853-.927a1 1 0 1 1 .618 1.902l-2.853.927ZM6.278 15.28a1 1 0 1 1 .618-1.901l2.853.927a1 1 0 1 1-.618 1.902l-2.853-.927ZM10.137 8.918a1 1 0 0 1 1.618-1.176l1.764 2.427a1 1 0 0 1-1.618 1.176l-1.764-2.427Z"/></svg>`;
const ICON_DARK = `<svg viewBox="0 0 36 36" aria-hidden="true" fill="currentColor"><path d="M12.5 8.473a10.968 10.968 0 0 1 8.785-.97 7.435 7.435 0 0 0-3.737 4.672l-.09.373A7.454 7.454 0 0 0 28.732 20.4a10.97 10.97 0 0 1-5.232 7.125l-.497.27c-5.014 2.566-11.175.916-14.234-3.813l-.295-.483C5.53 18.403 7.13 11.93 12.017 8.77l.483-.297Zm4.234.616a8.946 8.946 0 0 0-2.805.883l-.429.234A9 9 0 0 0 10.206 22.5l.241.395A9 9 0 0 0 22.5 25.794l.416-.255a8.94 8.94 0 0 0 2.167-1.99 9.433 9.433 0 0 1-2.782-.313c-5.043-1.352-8.036-6.535-6.686-11.578l.147-.491c.242-.745.573-1.44.972-2.078Z"/></svg>`;
const ICON_DIM = `<svg viewBox="0 0 36 36" aria-hidden="true" fill="currentColor"><path d="M5 21a1 1 0 0 1 1-1h24a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1ZM12 25a1 1 0 0 1 1-1h10a1 1 0 1 1 0 2H13a1 1 0 0 1-1-1ZM15 29a1 1 0 0 1 1-1h4a1 1 0 1 1 0 2h-4a1 1 0 0 1-1-1ZM18 13a6 6 0 0 1 5.915 7h-2.041A4.005 4.005 0 0 0 18 15a4 4 0 0 0-3.874 5h-2.041A6 6 0 0 1 18 13ZM17 7.038a1 1 0 1 1 2 0v3a1 1 0 0 1-2 0v-3ZM24.244 8.742a1 1 0 1 1 1.618 1.176L24.1 12.345a1 1 0 1 1-1.618-1.176l1.763-2.427ZM29.104 14.379a1 1 0 0 1 .618 1.902l-2.854.927a1 1 0 1 1-.618-1.902l2.854-.927ZM6.278 16.28a1 1 0 1 1 .618-1.901l2.853.927a1 1 0 1 1-.618 1.902l-2.853-.927ZM10.137 9.918a1 1 0 0 1 1.618-1.176l1.764 2.427a1 1 0 0 1-1.618 1.176l-1.764-2.427Z"/></svg>`;

// The rail's panels: layers (Scene), sliders (Display), a ball over the ground (Physics), a
// camera (Capture); and the playback bar's "restore" (an arrow turning back).
const RAIL_SVG = `viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
const ICON_SCENE = `<svg ${RAIL_SVG}><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>`;
const ICON_DISPLAY = `<svg ${RAIL_SVG}><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></svg>`;
const ICON_PHYSICS = `<svg ${RAIL_SVG}><circle cx="12" cy="8" r="4"/><path d="M4 20h16M9 14.5l-1 2.5M15 14.5l1 2.5M12 15v2.5"/></svg>`;
const ICON_CAPTURE = `<svg ${RAIL_SVG}><path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
const ICON_RESTORE = `<svg ${RAIL_SVG}><path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4v5h5"/></svg>`;

// A Scene row's type, by ItemType (14 px, drawn like the rail's icons).
const TYPE_SVG = `viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
const TYPE_ICONS: Record<ItemType, string> = {
  reconstruction: `<svg ${TYPE_SVG}><path d="M4 18L12 5l8 13z"/><path d="M12 5v13"/></svg>`,
  sequence: `<svg ${TYPE_SVG}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>`,
  mesh: `<svg ${TYPE_SVG}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>`,
  splats: `<svg ${TYPE_SVG}><ellipse cx="9" cy="10" rx="5.5" ry="3" transform="rotate(-25 9 10)"/><ellipse cx="15.5" cy="15.5" rx="4" ry="2.5" transform="rotate(20 15.5 15.5)"/></svg>`,
  points: `<svg ${TYPE_SVG}><circle cx="6" cy="8" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="17" cy="10" r="1"/><circle cx="8" cy="15" r="1"/><circle cx="14" cy="17" r="1"/><circle cx="19" cy="18" r="1"/></svg>`,
  tracks: `<svg ${TYPE_SVG}><path d="M4 18c4-10 8 2 15-10"/><circle cx="19.5" cy="7.5" r="1.5"/></svg>`,
  physics: `<svg ${TYPE_SVG}><circle cx="12" cy="8" r="4"/><path d="M4 20h16M9 14.5l-1 2.5M15 14.5l1 2.5M12 15v2.5"/></svg>`,
};

// Play / pause, for a temporal item's timeline and the playback bar.
const ICON_PLAY = `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>`;

type PanelId = "scene" | "display" | "physics" | "capture";
/** The rail, in order: which panels exist, and when. */
const PANELS: Array<{ id: PanelId; label: string; icon: string; shown: (s: ViewerState) => boolean }> = [
  { id: "scene", label: "Scene", icon: ICON_SCENE, shown: () => true },
  { id: "display", label: "Display", icon: ICON_DISPLAY, shown: () => true },
  { id: "physics", label: "Physics", icon: ICON_PHYSICS, shown: (s) => s.physics !== null },
  { id: "capture", label: "Capture", icon: ICON_CAPTURE, shown: (s) => s.items.length > 0 },
];
/** The playback bar's speeds (sim seconds per real second), in the order its button cycles. */
const SPEEDS = [1, 0.5, 0.25, 0.1];
/** The playback bar's click modes. */
const CLICK_MODES: Array<{ value: ClickMode; label: string; title: string }> = [
  { value: "select", label: "Select", title: "A click selects the item under it (Esc returns here)" },
  { value: "shoot", label: "Shoot", title: "A click knocks out the piece it hits" },
  { value: "blast", label: "Blast", title: "A click blows up a blast where it hits" },
];

/** Button copy for the 3DGS render modes; keyed exhaustively, so adding a mode to
 *  SPLAT_RENDER_MODES fails to compile until it is described here. */
const SPLAT_MODE_COPY: Record<SplatRenderMode, { label: string; title: string }> = {
  splatting: { label: "Splats", title: "True Gaussian splatting, sorted per viewpoint (Spark)" },
  ellipsoids: { label: "Ellipsoids", title: "Each Gaussian as a solid oriented ellipsoid" },
  points: { label: "Points", title: "Each Gaussian's center as a point (fastest)" },
};

export class ControlPanel {
  /** The panel the rail has open (one at a time; none = the rail alone). Scene to begin with:
   *  its "+" is what a first visit needs. */
  private open: PanelId | null = "scene";
  /** Each panel's scroll offset, kept across re-renders and panel switches. */
  private readonly scrollTops = new Map<PanelId, number>();
  /** The selection at the last render: a new one (a click in the view) opens Scene, where its
   *  Inspector is. */
  private selected: string | null = null;
  /** Each physics object's drop height, metres (3 unless set), kept across re-renders. */
  private readonly dropHeights = new Map<string, number>();
  /** How to rewrite each physics status line, by item id ("" = the simulation's) — repopulated
   *  on every render, so a running simulation updates the lines instead of rebuilding the panel. */
  private readonly physicsLines = new Map<string, (status: string) => void>();
  /** Which Capture sub-menus are open, kept across panel re-renders. */
  private readonly captureOpen = { image: true, video: true };
  /** How to move each temporal item's playhead, by item id — repopulated on every
   *  render, so playback updates the live slider instead of rebuilding the panel. */
  private readonly playheads = new Map<string, (frame: number) => void>();
  /** "Render video" settings, kept across panel re-renders; `item` is unset until
   *  picked, which means the first reconstruction with cameras. */
  private readonly video = { item: "", framesPerCamera: 4, fps: 24, loop: false, overrideFov: false, fov: 60 };

  /** `archives`: offer "COLMAP (zip)" in the "+" menu (the host can unzip one). */
  constructor(
    private readonly viewer: Viewer,
    private readonly options: { archives?: boolean } = {}
  ) {}

  /** Render (or re-render) the UI from current Viewer state. */
  render(): void {
    // This rebuilds the UI wholesale — on every rename, remove and load — so a scrolled
    // body would jump back to the top. Carry its offset across.
    const shown = document.querySelector<HTMLElement>("#viewer-ui .viewer-panel");
    if (shown) {
      this.scrollTops.set(shown.dataset.panel as PanelId, shown.querySelector(".viewer-body")!.scrollTop);
    }
    document.getElementById("viewer-ui")?.remove();
    document.getElementById("viewer-transport")?.remove();
    this.physicsLines.clear(); // the lines built below re-register
    this.playheads.clear();
    const s = this.viewer.getState();

    if (s.selected !== this.selected) {
      this.selected = s.selected;
      if (s.selected) {
        this.open = "scene";
      }
    }
    const panels = PANELS.filter((p) => p.shown(s));
    if (this.open && !panels.some((p) => p.id === this.open)) {
      this.open = "scene"; // its panel went (the last chunked object, the last item)
    }
    const dock = document.createElement("div");
    dock.className = "viewer-dock";
    if (this.open) {
      dock.append(this.buildPanel(this.open, s));
    }
    dock.append(this.buildRail(panels));
    const ui = document.createElement("div");
    ui.id = "viewer-ui";
    ui.className = "viewer-ui";
    ui.append(dock, buildFooter(s.backend, this.buildThemeSwitcher(s)));
    document.body.appendChild(ui);
    const body = ui.querySelector<HTMLElement>(".viewer-body");
    if (body && this.open) {
      body.scrollTop = this.scrollTops.get(this.open) ?? 0;
    }
    if (s.physics) {
      document.body.appendChild(this.buildTransport(s.physics, s.clickMode));
    }
  }

  private buildPanel(id: PanelId, s: ViewerState): HTMLElement {
    switch (id) {
      case "scene":
        return this.panelFrame(id, "Scene", sceneSummary(s), this.buildSceneBody(s), this.buildAddMenu());
      case "display":
        return this.panelFrame(id, "Display", null, this.buildDisplayBody(s));
      case "physics":
        return this.panelFrame(id, "Physics", null, this.buildPhysicsBody(s.physics!));
      case "capture":
        return this.panelFrame(id, "Capture", null, this.buildCaptureBody(s));
    }
  }

  /** The rail: one button per panel; a click opens it (closing the other), or closes it. */
  private buildRail(panels: typeof PANELS): HTMLElement {
    const rail = document.createElement("div");
    rail.className = "viewer-rail";
    rail.setAttribute("role", "toolbar");
    rail.setAttribute("aria-label", "Panels");
    rail.setAttribute("aria-orientation", "vertical");
    for (const p of panels) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "viewer-rail-btn";
      btn.innerHTML = p.icon;
      btn.title = p.label;
      btn.setAttribute("aria-label", p.label);
      btn.setAttribute("aria-pressed", String(this.open === p.id));
      btn.addEventListener("click", () => {
        this.open = this.open === p.id ? null : p.id;
        this.render();
      });
      rail.append(btn);
    }
    return rail;
  }

  /** A panel: its title row (title, subtitle, an action such as the Scene "+") over a body
   *  that scrolls by itself — the only scroll box, so the panel never outgrows the window. */
  private panelFrame(
    id: PanelId,
    title: string,
    subtitle: string | null,
    body: HTMLElement,
    action?: HTMLElement
  ): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "viewer-panel";
    panel.dataset.panel = id;
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", title);
    const header = document.createElement("div");
    header.className = "viewer-header";
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
    header.append(titles);
    if (action) {
      header.append(action);
    }
    panel.append(header, body);
    return panel;
  }

  /** Rewrite a physics status line, a chunked object's or (``id`` null) the simulation's (the
   *  Viewer's onPhysics, while it runs). */
  setPhysicsStatus(id: string | null, status: string): void {
    this.physicsLines.get(id ?? "")?.(status);
  }

  /** Move a temporal item's playhead (the Viewer's onFrame, during playback). */
  setPlayhead(id: string, frame: number): void {
    this.playheads.get(id)?.(frame);
  }

  private buildDisplayBody(s: ViewerState): HTMLElement {
    const body = document.createElement("div");
    body.className = "viewer-body";

    // Show — scene-wide visibility toggles, only for content that exists.
    const toggles = document.createElement("div");
    toggles.className = "viewer-toggles";
    const toggle = (label: string, key: string, name: Parameters<Viewer["setGlobal"]>[0], on: boolean) =>
      withKey(checkbox(label, on, (v) => this.viewer.setGlobal(name, v)), key);
    if (s.hasPoints) {
      toggles.append(toggle("Points", "P", "points", s.points));
    }
    if (s.hasCameras) {
      toggles.append(toggle("Frustums", "F", "frustums", s.frustums), toggle("Images", "I", "images", s.images));
    }
    if (s.hasPoints || s.hasAssets) {
      toggles.append(toggle("Box", "B", "box", s.box));
    }
    toggles.append(toggle("Grid", "G", "grid", s.grid), toggle("Axes", "A", "axes", s.axes));
    body.append(section("Show", [toggles]));

    // Meshes — how mesh assets are drawn (two independent switches).
    if (s.hasAssets) {
      const modes = document.createElement("div");
      modes.className = "viewer-toggles";
      modes.append(toggle("Shaded", "S", "shaded", s.shaded), toggle("Wireframe", "W", "wireframe", s.wireframe));
      body.append(section("Meshes", [modes]));
    }

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
      appearance.push(slider("Point size", 0.5, 6, 0.5, s.pointSize, (v) => this.viewer.setPointSize(v),
        { format: (v) => `${v} px` }));
    }
    if (s.hasCameras) {
      appearance.push(
        slider("Frustum size", 0, s.frustumScaleMax, s.frustumScaleMax / 80, s.frustumScale, (v) =>
          this.viewer.setFrustumScale(v)
        ),
        slider("Frustum line width", 1, 10, 0.5, s.frustumLineWidth, (v) =>
          this.viewer.setFrustumLineWidth(v), { format: (v) => `${v} px` }
        ),
        colorRow("Frustum color", s.frustumColor, (v) => this.viewer.setFrustumColor(v))
      );
    }
    if (s.trackSteps > 1) {
      // Trail length in time steps; at the far right the whole trajectory shows.
      // Opacity and density are how a few thousand overlapping trails stay readable;
      // thickness (screen px, as for frustums) is how a sparse set stops being a
      // hairline, and smoothing (in time steps) is how a jittery tracker reads.
      appearance.push(
        slider("Track trail", 2, s.trackSteps, 1, s.trackTrail, (v) =>
          this.viewer.setTrackTrail(v)
        ),
        slider("Track opacity", 0.05, 1, 0.05, s.trackOpacity, (v) =>
          this.viewer.setTrackOpacity(v)
        ),
        slider("Track density", 0.05, 1, 0.05, s.trackDensity, (v) =>
          this.viewer.setTrackDensity(v)
        ),
        slider("Track line width", 1, 10, 0.5, s.trackLineWidth, (v) => this.viewer.setTrackLineWidth(v),
          { format: (v) => `${v} px` }),
        slider("Track smoothing", 0, 5, 0.25, s.trackSmoothing, (v) =>
          this.viewer.setTrackSmoothing(v)
        )
      );
    }
    if (s.items.some((i) => i.frameCount > 0)) {
      // One rate for every temporal item: each owns its playhead, but they share a
      // clock, which keeps the per-item rows to a scrubber and a play button.
      appearance.push(
        slider("Playback FPS", 1, 60, 1, s.playbackFps, (v) => this.viewer.setPlaybackFps(v))
      );
    }
    if (appearance.length > 0) {
      body.append(section("Appearance", appearance));
    }

    // View — orientation, following a simulation, reset.
    const view: HTMLElement[] = [
      withKey(checkbox("Upright Y-up", s.orientation === "upright", (on) =>
        this.viewer.setOrientation(on ? "upright" : "raw")
      ), "U"),
    ];
    if (s.physics) {
      const follow = checkbox("Follow the pieces", s.physics.follow, (on) => this.viewer.setPhysicsFollow(on));
      follow.title = "Keep the camera on the object last acted on while its pieces move";
      view.push(follow);
    }
    view.push(withKey(button("Fit view", () => this.viewer.resetView(), true), "R"));
    body.append(section("View", view));

    // Camera — controls OrbitControls' drag can't reach: perspective FOV and a
    // roll (tilt) about the view axis. Reset snaps both sliders back to default.
    body.append(
      section("Camera", [
        slider("Field of view", 20, 90, 1, s.fov, (v) => this.viewer.setFov(v),
          { format: (v) => `${v}°`, reset: DEFAULT_FOV }),
        slider("Roll", -180, 180, 1, s.roll, (v) => this.viewer.setRoll(v), { format: (v) => `${v}°`, reset: 0 }),
        button(
          "Default lens",
          () => {
            this.viewer.resetCamera();
            this.render(); // a click, not a keystroke — re-reading the sliders is safe
          },
          true
        ),
      ])
    );

    return body;
  }

  /**
   * The Physics panel, while the scene holds a chunked object (an .npz from
   * GenerativeReconstruction's export_chunks.py): the World every object shares (they are in
   * one world, so they collide). Its clock is the playback bar; each object's own controls
   * are in its Inspector (Scene).
   */
  private buildPhysicsBody(p: PhysicsView): HTMLElement {
    const gravity = slider("Gravity", 0, 20, 0.1, p.gravity, (v) => this.viewer.setPhysicsGravity(v),
      { format: (v) => `${v.toFixed(1)} m/s²`, reset: EARTH_GRAVITY });
    gravity.title = "Moon 1.6, Mars 3.7, Earth 9.8. The welds keep the strength calibrated under Earth's";
    const body = document.createElement("div");
    body.className = "viewer-body";
    body.append(section("World", [gravity]));
    return body;
  }

  /** The simulation's playback bar (bottom centre): play / pause, restore every object, its
   *  line (updated in place), the speed (a button cycling through SPEEDS) and the click mode. */
  private buildTransport(p: PhysicsView, clickMode: ClickMode): HTMLElement {
    const bar = document.createElement("div");
    bar.id = "viewer-transport";
    bar.className = "viewer-transport";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Simulation");
    const busy = p.objects.some((o) => o.busy);
    const play = document.createElement("button");
    play.className = "viewer-iconbtn";
    play.innerHTML = p.running ? ICON_PAUSE : ICON_PLAY;
    play.title = p.running ? "Pause the simulation" : "Play the simulation (the first time calibrates every object's welds)";
    play.addEventListener("click", () => this.viewer.playPhysics(!p.running));
    const restore = document.createElement("button");
    restore.className = "viewer-iconbtn";
    restore.innerHTML = ICON_RESTORE;
    restore.title = "Restore all: every object back to rest, whole";
    restore.addEventListener("click", () => this.viewer.resetPhysics());
    play.disabled = restore.disabled = busy;
    const line = document.createElement("span");
    line.className = "viewer-transport-line";
    line.textContent = p.status;
    this.physicsLines.set("", (status) => {
      line.textContent = status;
    });
    const speed = document.createElement("button");
    speed.className = "viewer-scale-btn viewer-transport-speed";
    speed.textContent = `${p.speed}×`;
    speed.title = "Speed: slow motion runs the same steps, fewer a second (click for the next)";
    speed.addEventListener("click", () => {
      this.viewer.setPhysicsSpeed(SPEEDS[(SPEEDS.indexOf(p.speed) + 1) % SPEEDS.length]);
      this.render();
    });
    const mode = choiceRow(CLICK_MODES, clickMode, (m) => this.viewer.setClickMode(m));
    mode.setAttribute("aria-label", "Click mode");
    bar.append(play, restore, line, speed, mode);
    return bar;
  }

  /** The Inspector's Physics section for a chunked object: its line (updated in place), Drop /
   *  Restore, the drop height, glue, shatter and the presets. The first action calibrates every
   *  object's welds (~7 simulated seconds each, with progress on its line). */
  private buildPhysicsSection(item: PhysicsItem): HTMLElement {
    const line = hint(item.status);
    this.physicsLines.set(item.id, (status) => {
      line.textContent = status;
    });
    const height = () => this.dropHeights.get(item.id) ?? 3;
    const run = (action: PhysicsAction) => () => this.viewer.runPhysics(item.id, action, height());
    const drop = button("Drop", run("drop"));
    drop.title = "Lift it to the drop height, tilted, and let it fall";
    const reset = button("Restore", run("reset"), true);
    reset.title = "This object back to rest, whole, where it is placed";
    const row = document.createElement("div");
    row.className = "viewer-scale-row";
    row.append(drop, reset);
    const heightRow = slider("Drop height", 0, 4, 0.1, height(), (v) => {
      this.dropHeights.set(item.id, v);
    }, { format: (v) => `${v} m`, reset: 3 });
    // Glue on a log scale (0.3x to 300x the load each weld carries at rest): the object
    // stands above 1x; shatter's top step is "off".
    const glue = slider("Glue", -0.5, 2.5, 0.05, Math.log10(item.strength),
      (v) => this.viewer.setPhysicsStrength(item.id, 10 ** v),
      { format: (v) => `${fmtGlue(10 ** v)}×`, parse: (t) => Math.log10(parseFloat(t)), reset: 1 });
    glue.title = "Each weld breaks at this multiple of the load it carries at rest";
    const shatterTop = 10.5;
    const shatter = slider("Shatter above", 1, shatterTop,
      0.5, Math.min(item.shatterSpeed, shatterTop),
      (v) => this.viewer.setPhysicsShatterSpeed(item.id, v >= shatterTop ? Number.POSITIVE_INFINITY : v),
      { format: (v) => (v >= shatterTop ? "off" : `${v} m/s`),
        parse: (t) => (/off/i.test(t) ? shatterTop : parseFloat(t)), reset: shatterTop });
    shatter.title = "A piece hit faster than this comes loose (brittle)";
    const presets = document.createElement("div");
    presets.className = "viewer-scale-row";
    const presetCopy: Array<[PhysicsPreset, string, string]> = [
      ["shatter", "Shatter", "Brittle, dropped from 3 m"],
      ["explode", "Explode", "A blast at its middle"],
      ["volley", "Volley", "Five shots through it from here"],
      ["crumble", "Crumble", "The glue vanishes"],
    ];
    const actions = [drop, reset];
    for (const [name, label, title] of presetCopy) {
      const b = document.createElement("button");
      b.className = "viewer-scale-btn";
      b.textContent = label;
      b.addEventListener("click", () => this.viewer.physicsPreset(item.id, name));
      b.title = `${title} (from rest, default glue)`;
      presets.append(b);
      actions.push(b);
    }
    for (const b of actions) {
      b.disabled = item.busy;
    }
    return section("Physics", [line, row, heightRow, glue, shatter, presets]);
  }

  /**
   * The Capture panel: saving the scene as files, once it holds something. The
   * point-gap switch applies to both captures, so it heads the panel; each capture
   * kind is a sub-menu of its own (video only for a reconstruction with a camera
   * path to fly, i.e. two cameras or more).
   */
  private buildCaptureBody(s: ViewerState): HTMLElement {
    const body = document.createElement("div");
    body.className = "viewer-body";

    // "Fill point gaps" changes both captures, and only where there are points to fill: one
    // setting, shown in each capture it affects.
    const hasPoints = s.hasPoints || s.hasPointCloud;
    const fill = (): HTMLElement[] => {
      if (!hasPoints) {
        return [];
      }
      const row = checkbox("Fill point gaps", s.adaptivePointSize, (on) => this.viewer.setAdaptivePointSize(on));
      row.title = "Size points by each cloud's own spacing, so surfaces stay filled at high resolution";
      return [row];
    };

    // Image — save a PNG of the current view at 1×/2×/4× resolution.
    const scales = scaleButtons(
      [1, 2, 4],
      (sc) => `Save a PNG of the current view at ${sc}× resolution`,
      (sc) => this.viewer.saveViewpoint(sc)
    );
    const open = this.captureOpen;
    body.append(
      subsection("Image", open.image, (o) => (open.image = o), [...fill(), actionRow("Save PNG at", scales)])
    );

    // Camera fly-through — only a reconstruction with a camera path to fly; otherwise say so.
    const withPath = s.items.filter((i) => i.cameraCount > 1);
    const rows = withPath.length > 0
      ? [...fill(), ...this.buildVideoRows(withPath)]
      : [hint("Needs a reconstruction with two cameras or more: the video flies through them.")];
    body.append(subsection("Camera fly-through", open.video, (o) => (open.video = o), rows));
    return body;
  }

  /**
   * The Camera fly-through sub-menu: fly through a reconstruction's cameras (in image-name
   * order) and save the video. Settings live on the panel; the scale buttons start it.
   */
  private buildVideoRows(withPath: SceneItem[]): HTMLElement[] {
    const v = this.video;
    if (!withPath.some((i) => i.id === v.item)) {
      v.item = withPath[0].id;
    }
    const rows: HTMLElement[] = [];
    if (withPath.length > 1) {
      rows.push(
        choiceRow(
          withPath.map((i) => ({ label: i.label, value: i.id, title: `${i.cameraCount} cameras` })),
          v.item,
          (id) => (v.item = id)
        )
      );
    }
    rows.push(
      slider("Frames per camera", 1, 30, 1, v.framesPerCamera, (n) => (v.framesPerCamera = n)),
      slider("Video FPS", 1, 60, 1, v.fps, (n) => (v.fps = n)),
      checkbox("Loop back to the first camera", v.loop, (on) => (v.loop = on)),
      checkbox("Override field of view", v.overrideFov, (on) => {
        v.overrideFov = on;
        this.render(); // a click: show or hide the FOV slider
      })
    );
    if (v.overrideFov) {
      const fov = slider("Field of view", 10, 120, 1, v.fov, (n) => (v.fov = n), { format: (n) => `${n}°` });
      fov.title = "Vertical field of view of the video";
      rows.push(fov);
    }
    // Touch has the status pill's Cancel button; a keyboard has Esc.
    const cancel = isTouchOnly() ? "" : " (Esc cancels)";
    const scales = scaleButtons(
      [1, 2],
      (sc) => `Render the camera path at ${sc}× the cameras' image size; frustums are hidden while it runs${cancel}`,
      (sc) => {
        const { item: itemId, framesPerCamera, fps, loop } = v;
        const fov = v.overrideFov ? v.fov : undefined;
        void this.viewer.renderCameraPath({ itemId, framesPerCamera, fps, loop, fov, scale: sc });
      }
    );
    rows.push(actionRow("Render at", scales));
    return rows;
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

  /** The Scene panel's "+" add menu (its header's action). */
  private buildAddMenu(): HTMLElement {
    // One entry per loadable kind. The asset entries differ only in how the host
    // filters its file picker — what a file actually is comes from the file itself
    // (a .ply is a mesh, a point cloud or a splat, by what is in it), so a "wrong"
    // entry still loads it.
    return menuButton("+", "Add to scene", [
      { label: "COLMAP", onClick: () => this.viewer.requestAdd("colmap") },
      // The same, zipped — only where the host can unzip (a phone can't pick the
      // project folder its model and images span).
      ...(this.options.archives
        ? [{ label: "COLMAP (zip)", onClick: () => this.viewer.requestAdd("archive") }]
        : []),
      { label: "Mesh", onClick: () => this.viewer.requestAdd("mesh") },
      { label: "Point cloud", onClick: () => this.viewer.requestAdd("cloud") },
      { label: "3DGS", onClick: () => this.viewer.requestAdd("splat") },
      { label: "Tracks", onClick: () => this.viewer.requestAdd("tracks") },
      // Every asset in a folder, as one temporal item — a per-frame capture, and the
      // way in where a host's file dialog can't select several files at once.
      { label: "Asset folder", onClick: () => this.viewer.requestAdd("assetFolder") },
    ]);
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
      kind.innerHTML = TYPE_ICONS[item.type];
      kind.title = ITEM_TYPE_LABELS[item.type];
      kind.setAttribute("role", "img");
      kind.setAttribute("aria-label", ITEM_TYPE_LABELS[item.type]);

      // A click on the row (not on one of its buttons) selects it for the Inspector, or
      // deselects it; so does Enter on the focused label.
      const selected = item.id === s.selected;
      row.classList.toggle("selected", selected);
      label.tabIndex = 0;
      label.setAttribute("role", "button");
      label.setAttribute("aria-pressed", String(selected));
      const select = () => this.viewer.selectItem(selected ? null : item.id);
      row.addEventListener("click", (e) => {
        if (!(e.target as HTMLElement).closest("button, input")) {
          select();
        }
      });
      label.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select();
        }
      });

      row.append(this.visibilityToggle(item), label, kind);
      if (item.frameCount > 0) {
        // What marks an item as temporal in the Scene list.
        const frames = document.createElement("span");
        frames.className = "kind temporal";
        frames.textContent = `⏱ ${item.frameCount}`;
        frames.title = `Temporal item — ${item.frameCount} frames`;
        row.append(frames);
      }
      // Shown on hover / keyboard focus (styles.ts), so a list of items reads calmly.
      const actions = document.createElement("span");
      actions.className = "viewer-scene-actions";
      actions.append(
        iconButton("✎", "Rename", () => this.startRename(label, item)),
        iconButton("✕", "Remove", () => this.viewer.removeItem(item.id))
      );
      row.append(actions);
      body.append(row);
      if (item.frameCount > 1) {
        body.append(this.buildTimeline(item));
      }
    }
    const selected = s.items.find((i) => i.id === s.selected);
    if (selected) {
      body.append(this.buildInspector(selected, s));
    }
    return body;
  }

  /**
   * The Inspector, under the Scene list: what the selected item is, its placement, and (a
   * chunked object) its physics. Every per-item setting lives here.
   */
  private buildInspector(item: SceneItem, s: ViewerState): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "viewer-inspector";
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", `${item.label}: inspector`);
    const head = document.createElement("div");
    head.className = "viewer-inspector-head";
    const name = document.createElement("div");
    name.className = "viewer-inspector-name";
    name.textContent = item.label;
    const what = document.createElement("div");
    what.className = "viewer-inspector-type";
    what.textContent = itemDescription(item);
    head.title = item.source ? sourcePath(item.source) : item.label;
    head.append(name, what);
    wrap.append(head, section("Placement", [this.buildTransformEditor(item, s.positionStep)]));
    const physics = s.physics?.objects.find((o) => o.id === item.id);
    if (physics) {
      wrap.append(this.buildPhysicsSection(physics));
    }
    return wrap;
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
    reset.textContent = "Reset placement";
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

/** A glue multiple as the slider reads it: "0.5", "3", "30". */
function fmtGlue(k: number): string {
  return k < 1 ? k.toFixed(1) : k < 10 ? k.toFixed(1).replace(/\.0$/, "") : String(Math.round(k));
}

/** A row of "1×", "2×", … buttons that each start a render at that scale. */
function scaleButtons(
  scales: number[],
  title: (scale: number) => string,
  onClick: (scale: number) => void
): HTMLElement {
  const row = document.createElement("div");
  row.className = "viewer-scale-row";
  for (const sc of scales) {
    const b = document.createElement("button");
    b.className = "viewer-scale-btn";
    b.textContent = `${sc}×`;
    b.title = title(sc);
    b.addEventListener("click", () => onClick(sc));
    row.append(b);
  }
  return row;
}

/** A caption + the buttons it names, aligned with the slider labels above it. */
function actionRow(label: string, buttons: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "viewer-action";
  const caption = document.createElement("span");
  caption.textContent = label;
  row.append(caption, buttons);
  return row;
}

/** The caption row under the panels: which GPU backend draws the scene (once the
 *  renderer is up), the build's version, and the theme switcher. */
function buildFooter(backend: ViewerState["backend"], theme: HTMLElement): HTMLElement {
  const foot = document.createElement("div");
  foot.className = "viewer-foot";
  if (backend) {
    const el = document.createElement("span");
    el.className = "viewer-backend";
    el.dataset.backend = backend;
    el.textContent = backend;
    el.title =
      backend === "WebGPU"
        ? "Rendering with WebGPU"
        : "WebGPU isn't available here — rendering with the WebGL2 fallback";
    foot.append(el);
  }
  const help = document.createElement("button");
  help.className = "viewer-help";
  help.textContent = "?";
  help.title = "Shortcuts and mouse controls (?)";
  help.addEventListener("click", showShortcuts);
  foot.append(buildVersion(), help, theme);
  return foot;
}

/** A small muted "v<x.y.z>" caption under the panels; the running build's version
 *  (`__APP_VERSION__` is inlined from package.json at build time). */
function buildVersion(): HTMLElement {
  // A new tab: a browser host opens one, and VS Code's webview hands external
  // links to the system browser rather than navigating the panel away.
  const el = document.createElement("a");
  el.className = "viewer-version";
  el.textContent = `v${__APP_VERSION__}`;
  el.title = "3DView on GitHub";
  el.href = "https://github.com/s-esposito/3DView";
  el.target = "_blank";
  el.rel = "noopener";
  return el;
}

/** Strip a leading http(s) origin from a host URI so the tooltip reads as a file path. */
function sourcePath(uri: string): string {
  return uri.replace(/^https?:\/\/[^/]+/i, "");
}

/** Each item type as the Inspector names it. */
const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  reconstruction: "COLMAP reconstruction",
  sequence: "Sequence",
  mesh: "Mesh",
  splats: "3D Gaussian splats",
  points: "Point cloud",
  tracks: "Point tracks",
  physics: "Breakable object (physics)",
};

/** What a Scene item is, for the Inspector: its type and, where known, its size. */
function itemDescription(item: SceneItem): string {
  const type = ITEM_TYPE_LABELS[item.type];
  if (item.cameraCount > 0) return `${type} · ${item.cameraCount} cameras`;
  if (item.frameCount > 0) return `${type} · ${item.frameCount} frames`;
  return type;
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
  return parts.join(" · ") || "Empty scene";
}
