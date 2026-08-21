// Webview entry point. Wires the host message channel, keyboard shortcuts, and
// status text to the Viewer and its UI. All real work lives in the modules. This
// bundle is host-agnostic: it talks to the embedding IDE only through the
// `window.__viewerHost` bridge (see shared/hostBridge), never a host-specific API.
import type {
  AddItem,
  HostToWebview,
  ColmapModelRef,
  GroupingChoice,
} from "../shared/messages";
import { getHostBridge } from "../shared/hostBridge";
import { Viewer, GlobalToggle } from "./viewer";
import type { TemporalFrame } from "./viewer";
import { compareNatural, sharedFolderName } from "../shared/naming";
import { ControlPanel } from "./ui/controlPanel";
import { InfoPopup, showColmapChooser, askTemporalGrouping } from "./ui/overlays";
import { ensureStyles } from "./ui/styles";
import { loadColmapFromUrls } from "./colmapLoader";
import { installDropZone } from "./dropZone";

// The host (VS Code or PyCharm/JCEF) installs `window.__viewerHost` before this
// bundle runs; we never reference a host-specific API directly.
const host = getHostBridge();
const status = document.getElementById("status")!;

ensureStyles();
const viewer = new Viewer();
const panel = new ControlPanel(viewer);
const popup = new InfoPopup();

// Selecting a camera shows its info popup; closing it (✕) clears the highlight
// but keeps the view; deselecting (Esc / exit POV) hides it.
viewer.onSelect = (cam) => {
  if (cam) {
    popup.show(cam, () => viewer.clearSelection());
  } else {
    popup.hide();
  }
};

// Content changes re-render the panel and refresh the status line.
viewer.onChange = () => {
  panel.render();
  updateStatus();
};
viewer.onError = (message) => showStatus(`Error: ${message}`);
// Async loaders report their phase (download %, "Decoding…") here.
viewer.onProgress = (message) => showStatus(message, true);

// Playback moves a temporal item's playhead; the panel updates that one slider in
// place (a re-render would rebuild it several times a second, losing any drag).
viewer.onFrame = (id, frame) => panel.setPlayhead(id, frame);

// The Scene "+" asks the host to open a picker; removal tells the host to forget.
viewer.onRequestAdd = (kind) => host.postMessage({ type: "requestAdd", kind });
viewer.onRemoveItem = (id) => host.postMessage({ type: "removed", id });
// `suggestedName` is serialized before the multi-MB `png` so the PyCharm host's
// regex parser matches the short field without scanning the whole base64 payload.
viewer.onSaveImage = (png, suggestedName) => host.postMessage({ type: "saveImage", suggestedName, png });

// Show the empty scene and its controls immediately, before any content loads.
panel.render();
showStatus("Open a reconstruction or asset — drag & drop, or use + in the Scene panel.");

// Keyboard shortcuts map to the same Viewer API the panel uses.
const TOGGLE_KEYS: Record<string, GlobalToggle> = {
  p: "points",
  f: "frustums",
  i: "images",
  b: "box",
  g: "grid",
  a: "axes",
  w: "wireframe",
  s: "shaded",
};
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) {
    return; // don't hijack keys while a control is focused
  }
  const key = e.key.toLowerCase();
  if (key === "r") {
    viewer.resetView();
    return;
  }
  if (key === "escape") {
    viewer.exitPov();
    return;
  }
  if (key === "u") {
    viewer.toggleOrientation();
    panel.render();
    return;
  }
  if (key === "e") {
    viewer.cycleSplatMode(); // 3DGS: splatting -> ellipsoids -> points
    panel.render();
    return;
  }
  const toggle = TOGGLE_KEYS[key];
  if (toggle) {
    viewer.toggleGlobal(toggle);
    panel.render();
  }
});

/** Show the centered overlay. When `busy`, prefix an animated spinner (the work
 *  runs off the main thread — e.g. a fetch or the Spark decode worker — so it
 *  keeps spinning, signalling progress even without a percentage). */
function showStatus(message: string, busy = false) {
  status.style.display = "flex";
  status.replaceChildren();
  const wrap = document.createElement("span");
  wrap.className = "viewer-status";
  if (busy) {
    const spinner = document.createElement("span");
    spinner.className = "viewer-spinner";
    wrap.append(spinner);
  }
  const text = document.createElement("span");
  text.textContent = message;
  wrap.append(text);
  status.append(wrap);
}

/** Hide the overlay once the scene has content; otherwise show a prompt. */
function updateStatus() {
  if (viewer.getState().items.length > 0) {
    status.style.display = "none";
  } else {
    showStatus("Open a reconstruction or asset — drag & drop, or use + in the Scene panel.");
  }
}

// Handle a content message, whether it arrives from the embedding host (the
// message channel below) or from an in-webview drag-and-drop (dropZone produces
// the same host-shaped messages from dropped files). Both converge here.
function handleHostMessage(msg: HostToWebview) {
  switch (msg.type) {
    case "loading":
      showStatus(msg.message, true);
      break;
    case "addReconstruction":
      viewer.addReconstruction(msg.id, msg.label, msg.data, msg.source); // fires onChange
      break;
    case "addAsset":
      showStatus(`Loading ${msg.label}…`, true);
      viewer.addAsset(msg.id, msg.label, msg.asset.uri, msg.asset.name); // async; onChange/onError
      break;
    case "loadColmap":
      // The host hands us URLs (not parsed data); fetch + parse in-browser, then
      // converge on the same addReconstruction path the inline `data` case uses.
      loadColmapModel(msg);
      break;
    case "addGroup":
      // Several items from one user action — ask once what they are.
      void addItems(msg.id, msg.label, msg.members, msg.grouping);
      break;
    case "chooseColmap":
      // Several models found (e.g. sparse/0, sparse/1); let the user pick which to
      // load. Unselected models' trio URLs are freed so dropped/demo blobs aren't
      // left pinned. (imageUrls are shared across models + needed lazily — see below.)
      showColmapChooser(
        msg.models, // ColmapModelRef has the label/source ChooserModel reads
        (selected) => {
          msg.models.forEach((m, i) => {
            if (!selected.includes(i)) {
              revokeColmapTrio(m.urls);
            }
          });
          const picked = msg.models.filter((_, i) => selected.includes(i));
          // Picking several chains into the same grouping question every other
          // multi-item path asks — one question per modal, one code path.
          const label = sharedFolderName(picked.map((m) => m.source ?? m.label));
          const members: AddItem[] = picked.map((m) => ({ type: "loadColmap", ...m }));
          void addItems(nextGroupId(), label ?? picked[0].label, members);
        },
        () => msg.models.forEach((m) => revokeColmapTrio(m.urls))
      );
      break;
    case "error":
      showStatus(`Error: ${msg.message}`);
      break;
  }
}

/**
 * Several items that arrived from ONE user action. Ask once whether they are a
 * capture's timesteps, then either build one temporal item or replay each member
 * through the very handler it would have taken alone — so nothing about the
 * single-item paths changes, in any host.
 */
async function addItems(
  groupId: string,
  label: string,
  members: AddItem[],
  grouping?: GroupingChoice
) {
  if (members.length < 2) {
    members.forEach(handleHostMessage);
    return;
  }
  // Loads finish out of order and pickers return their own order; the timeline
  // reads labels the way a person does.
  const ordered = [...members].sort((a, b) => compareNatural(a.label, b.label));
  const answer = grouping ?? (await askTemporalGrouping(ordered.length, label));
  if (answer === "separate") {
    ordered.forEach(handleHostMessage);
    return;
  }
  if (answer === "cancel") {
    ordered.forEach(release);
    return;
  }
  const frames: TemporalFrame[] = [];
  for (const m of ordered) {
    const frame = await toFrame(m);
    if (frame) {
      frames.push(frame);
    }
  }
  await viewer.addTemporal(groupId, label, frames);
}

/** One group member as a frame the Viewer can build, fetching the model first for
 *  the URL-served kind. Undefined when that fetch failed — the sequence goes on
 *  without it, as it does for a frame the Viewer itself can't build. */
async function toFrame(m: AddItem): Promise<TemporalFrame | undefined> {
  const { id, label } = m;
  if (m.type === "addAsset") {
    return { kind: "asset", id, label, uri: m.asset.uri, name: m.asset.name };
  }
  if (m.type === "addReconstruction") {
    return { kind: "reconstruction", id, label, data: m.data, source: m.source };
  }
  showStatus(`Loading ${label}…`, true);
  try {
    return { kind: "reconstruction", id, label, data: await loadColmapData(m), source: m.source };
  } catch (err) {
    showStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Free the bytes behind an item the user decided not to load. */
function release(m: AddItem) {
  if (m.type === "addAsset") {
    URL.revokeObjectURL(m.asset.uri);
  } else if (m.type === "loadColmap") {
    revokeColmapTrio(m.urls);
  }
}

/** Group ids for content the webview groups itself (a chooser pick), mirroring the
 *  `dnd-` ids drag-and-drop mints — the host never sees these and never replays them. */
let groupCounter = 0;
function nextGroupId(): string {
  return `web-group-${++groupCounter}`;
}

/**
 * Fetch + parse a URL-served COLMAP model. The trio is fetched exactly once, so the
 * URLs are freed either way: a dropped / demo blob: model (a large points3D
 * especially) must not stay pinned for the session. A no-op on non-blob host URLs
 * (VS Code / PyCharm). The per-image `imageUrls` are deliberately NOT revoked —
 * frustum textures load lazily and re-fetch after eviction (and the map is shared
 * across a chooser's models).
 */
function loadColmapData(m: ColmapModelRef) {
  return loadColmapFromUrls(m.urls, m.format, m.imageBaseUrl, m.imageUrls).finally(() =>
    revokeColmapTrio(m.urls)
  );
}

/** Fetch + parse a URL-served COLMAP model and add it to the scene. */
function loadColmapModel(m: ColmapModelRef) {
  showStatus(`Loading ${m.label}…`, true);
  loadColmapData(m)
    .then((data) => viewer.addReconstruction(m.id, m.label, data, m.source))
    .catch((err) => showStatus(`Error: ${err instanceof Error ? err.message : String(err)}`));
}

function revokeColmapTrio(urls: { cameras: string; images: string; points3d: string }) {
  URL.revokeObjectURL(urls.cameras);
  URL.revokeObjectURL(urls.images);
  URL.revokeObjectURL(urls.points3d);
}

window.addEventListener("message", (event: MessageEvent<HostToWebview>) =>
  handleHostMessage(event.data)
);

// Drag-and-drop is host-agnostic: dropped files are read into blob: URLs and fed
// through the same handler as host messages (see dropZone.ts).
installDropZone(handleHostMessage);

// Tell the host we are alive and ready to receive content.
host.postMessage({ type: "ready" });
