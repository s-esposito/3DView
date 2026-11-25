// The embedding configuration (messages.ts ViewerConfig): its presets, and what the viewer keeps
// of it — the chrome (UiConfig) and what a person may do (InteractionConfig). The look (theme,
// background, helpers, upright, splat mode) goes straight to the Viewer's own setters.
import type { PanelName, ViewerConfig } from "../shared/messages";

/** Every panel, in the rail's order. */
export const ALL_PANELS: readonly PanelName[] = ["scene", "display", "physics", "capture"];

/** The chrome as configured (ViewerConfig.ui; `open` is an ask, not state: Viewer.onOpenPanel). */
export interface UiConfig {
  panels: PanelName[];
  footer: boolean;
  fps: boolean;
  themeSwitcher: boolean;
  help: boolean;
  keyboard: boolean;
}

export interface InteractionConfig {
  select: boolean;
  edit: boolean;
  physics: boolean;
}

/** Everything, as in VS Code: what a viewer with no configuration has. */
export const FULL_UI: UiConfig = {
  panels: [...ALL_PANELS], footer: true, fps: true, themeSwitcher: true, help: true, keyboard: true,
};
export const FULL_INTERACTION: InteractionConfig = { select: true, edit: true, physics: true };

export const PRESETS: Record<NonNullable<ViewerConfig["preset"]>, ViewerConfig> = {
  full: { ui: FULL_UI, interaction: FULL_INTERACTION },
  /** A showcase: the Scene panel (the items, a sequence's timeline) and nothing to change. */
  presentation: {
    show: { grid: false, axes: false, box: false },
    ui: { panels: ["scene"], open: "scene", footer: false },
    interaction: { select: false, edit: false, physics: false },
  },
};

/** ``config`` laid over the preset it names (if any): the preset's fields, then its own. */
export function expand(config: ViewerConfig): ViewerConfig {
  const base: ViewerConfig = config.preset ? PRESETS[config.preset] : {};
  return {
    ...base,
    ...config,
    show: { ...base.show, ...config.show },
    ui: { ...base.ui, ...config.ui },
    interaction: { ...base.interaction, ...config.interaction },
  };
}
