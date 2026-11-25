// What an embedding page asks to show, as the viewer's own add messages: one conversion shared by
// embed.html's URL parameters (frame.ts) and the embed.js SDK (sdk.ts). Pure, so node tests run it.
import type { AddAssetMsg, AddGroupMsg, HostToWebview, LoadColmapMsg, ViewerConfig } from "../shared/messages";

/**
 * One item to show. URLs may be relative to `base` (the embedding page, for the SDK); the files
 * must be served with CORS when they are on another origin than the viewer.
 * - `{ url }`: one file: a mesh (.glb/.gltf/.obj/.ply), a point cloud (.ply), 3D Gaussian splats
 *   (.ply/.splat/.spz/.ksplat), point tracks or a breakable physics object (.npz/.npy); a .ply is
 *   told apart by what it holds (messages.ts ASSET_KIND_EXTS).
 * - `{ colmap }`: a COLMAP sparse model folder (cameras / images / points3D, `.bin` or `.txt`);
 *   `images`, the folder of its photos, shows them in the camera frustums.
 * - `{ sequence }`: several files as ONE item with a timeline (a capture's timesteps).
 * `id` names it in later messages and events (default: one is made up); `label` is what the Scene
 * list shows (default: the file or folder name).
 */
export type EmbedItem =
  | { url: string; id?: string; label?: string }
  | { colmap: string; format?: "bin" | "txt"; images?: string; id?: string; label?: string }
  | { sequence: string[]; id?: string; label?: string };

/** The last path segment of ``url``, decoded ("model.glb"); a numbered folder keeps its parent
 *  ("sparse/0"), which alone would say nothing. */
export function nameOf(url: string): string {
  const parts = new URL(url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const last = parts.at(-1) ?? url;
  return /^\d+$/.test(last) && parts.length > 1 ? `${parts.at(-2)}/${last}` : last;
}

function asset(url: string, id: string, label?: string): AddAssetMsg {
  const name = nameOf(url);
  return { type: "addAsset", id, label: label ?? name, asset: { uri: url, name } };
}

/** The message that adds ``item`` as ``id`` (its own id wins), its URLs resolved against ``base``. */
export function itemMessage(item: EmbedItem, id: string, base: string): AddAssetMsg | LoadColmapMsg | AddGroupMsg {
  id = item.id ?? id;
  const abs = (u: string) => new URL(u, base).href;
  const folder = (u: string) => abs(u.endsWith("/") ? u : `${u}/`);
  if ("url" in item) {
    return asset(abs(item.url), id, item.label);
  }
  if ("colmap" in item) {
    const dir = folder(item.colmap);
    const ext = item.format ?? "bin";
    const msg: LoadColmapMsg = {
      type: "loadColmap",
      id,
      label: item.label ?? nameOf(dir),
      format: ext,
      urls: { cameras: `${dir}cameras.${ext}`, images: `${dir}images.${ext}`, points3d: `${dir}points3D.${ext}` },
      source: dir,
    };
    if (item.images) msg.imageBaseUrl = folder(item.images);
    return msg;
  }
  const urls = item.sequence.map(abs);
  if (urls.length === 1) {
    return asset(urls[0], id, item.label);
  }
  return {
    type: "addGroup",
    id,
    label: item.label ?? nameOf(new URL(".", urls[0]).href),
    grouping: "temporal",
    members: urls.map((u, k) => asset(u, `${id}/${k}`)),
  };
}

/** URL parameters that set one configuration field each, over `config`. */
export const CONFIG_SHORTHANDS = ["preset", "theme", "background"] as const;

/** What embed.html's URL parameters ask for: the configuration, read before anything is drawn,
 *  and the messages to send once the viewer is ready. Throws on a malformed parameter. */
export interface EmbedSetup {
  config?: ViewerConfig;
  messages: HostToWebview[];
}

/**
 * embed.html's query string as an EmbedSetup. Items keep the order of their parameters:
 * `asset=<url>`, `colmap=<folder url>`, `sequence=<url>,<url>,...` (each repeatable) and
 * `items=<JSON EmbedItem[]>`; `view=px,py,pz,tx,ty,tz` (the camera position and the point it
 * looks at); `config=<JSON ViewerConfig>`, and the shorthands `preset`, `theme`, `background`
 * laid over it.
 */
export function parseEmbedParams(search: string, base: string): EmbedSetup {
  const params = new URLSearchParams(search);
  const json = <T>(key: string, text: string): T => {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`"${key}" is not valid JSON`);
    }
  };
  const messages: HostToWebview[] = [];
  const add = (item: EmbedItem) => messages.push(itemMessage(item, `item-${messages.length + 1}`, base));
  let config: ViewerConfig | undefined;
  for (const [key, value] of params) {
    if (key === "asset") add({ url: value });
    else if (key === "colmap") add({ colmap: value });
    else if (key === "sequence") add({ sequence: value.split(",").filter(Boolean) });
    else if (key === "items") json<EmbedItem[]>(key, value).forEach(add);
    else if (key === "config") config = { ...config, ...json<ViewerConfig>(key, value) };
  }
  const view = params.get("view")?.split(",").map(Number);
  if (view) {
    if (view.length !== 6 || view.some((v) => !Number.isFinite(v))) {
      throw new Error(`"view" takes six numbers: px,py,pz,tx,ty,tz`);
    }
    messages.unshift({ type: "setView", position: [view[0], view[1], view[2]], target: [view[3], view[4], view[5]] });
  }
  for (const key of CONFIG_SHORTHANDS) {
    const value = params.get(key);
    if (value !== null) config = { ...config, [key]: value };
  }
  return { config, messages };
}
