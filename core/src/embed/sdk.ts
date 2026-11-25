// embed.js: the JS SDK for a web page embedding 3DView. `ThreeDView.mount(element, options)` puts
// embed.html in an iframe and resolves, once the viewer is ready, to an EmbeddedViewer: promises
// over the same messages and events the IDE hosts use (messages.ts), nothing of its own. A plain
// script that defines the global `ThreeDView`.
import type {
  CaptureMsg, HostToWebview, PhysicsMode, ViewerConfig, ViewerSnapshot, WebviewToHost,
} from "../shared/messages";
import { itemMessage, type EmbedItem } from "./items";

/** Where this script was loaded from (<major>/dist/embed.js): embed.html is one folder up. */
const HERE = (document.currentScript as HTMLScriptElement | null)?.src ?? location.href;

export interface MountOptions {
  /** How the viewer looks and what a person may do, applied before anything is drawn. */
  config?: ViewerConfig;
  /** Items to show at once (relative URLs resolve against the page). */
  items?: EmbedItem[];
  /** The camera's starting position and the point it looks at, in the scene's frame. */
  view?: { position: [number, number, number]; target: [number, number, number] };
  /** The embed.html to load; default: the one of embed.js's own major. */
  src?: string;
}

type EventOf<T extends WebviewToHost["type"]> = Extract<WebviewToHost, { type: T }>;
type Waiter = { resolve: (e: WebviewToHost) => void; reject: (err: Error) => void };

let mounted = 0;

/** A viewer on the page. Every method sends one message; those that return a promise resolve with
 *  the viewer's answer. */
export class EmbeddedViewer {
  /** 3DView's version and the embedding API's (messages.ts API_VERSION). */
  version = "";
  apiVersion = 0;
  private readonly listeners = new Map<string, Set<(e: WebviewToHost) => void>>();
  /** Requests and adds waiting for their answer, by requestId / item id. */
  private readonly waiting = new Map<string | number, Waiter>();
  private queue: HostToWebview[] | null = [];
  private nextId = 0;
  private readonly prefix = `3dview-${++mounted}`;
  private readonly onMessage = (event: MessageEvent) => {
    if (event.source === this.iframe.contentWindow) this.receive(event.data as WebviewToHost);
  };

  constructor(readonly iframe: HTMLIFrameElement, private readonly base: string) {
    window.addEventListener("message", this.onMessage);
  }

  /** Listen for an event (or a reply); returns the function that stops listening. */
  on<T extends WebviewToHost["type"]>(type: T, listener: (event: EventOf<T>) => void): () => void {
    const set = this.listeners.get(type) ?? new Set();
    this.listeners.set(type, set);
    const fn = listener as (e: WebviewToHost) => void;
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Send any message of the protocol as it is. Held until the viewer is ready. */
  send(msg: HostToWebview): void {
    if (this.queue) this.queue.push(msg);
    else this.iframe.contentWindow?.postMessage(msg, "*");
  }

  /** Add an item; resolves with its id once it is drawn, rejects if it cannot be loaded. */
  add(item: EmbedItem): Promise<string> {
    const msg = itemMessage(item, `${this.prefix}-item-${++this.nextId}`, this.base);
    const done = this.wait(msg.id).then(() => msg.id);
    this.send(msg);
    return done;
  }

  remove(id: string): void {
    this.send({ type: "removeItem", id });
  }
  /** Change the configuration: the fields given merge into the current one. */
  configure(config: ViewerConfig): void {
    this.send({ type: "configure", ...config });
  }
  /** Move the camera and make that the scene's home view (scene frame). */
  setView(position: [number, number, number], target: [number, number, number]): void {
    this.send({ type: "setView", position, target });
  }
  /** Place an item, or a named node in it, by a 4x4 matrix, row-major (scene frame). */
  setTransform(id: string, matrix: number[], node?: string): void {
    this.send({ type: "setTransform", id, matrix, node });
  }
  setVisible(id: string, visible: boolean): void {
    this.send({ type: "setItemVisible", id, visible });
  }
  setLabel(id: string, label: string): void {
    this.send({ type: "setItemLabel", id, label });
  }
  select(id: string | null): void {
    this.send({ type: "selectItem", id });
  }
  setFrame(id: string, frame: number): void {
    this.send({ type: "setFrame", id, frame });
  }
  setPlaying(id: string, playing: boolean): void {
    this.send({ type: "setPlaying", id, playing });
  }
  setPhysicsMode(id: string, mode: PhysicsMode): void {
    this.send({ type: "setPhysicsMode", id, mode });
  }
  /** Run the simulation, stop it, or put every object back where it started. */
  physics(action: "play" | "pause" | "restoreAll"): void {
    this.send({ type: "physics", action });
  }

  getState(): Promise<ViewerSnapshot> {
    return this.request({ type: "getState" }).then((r) => (r as EventOf<"state">).state);
  }
  /** A PNG data URL of the current view (see messages.ts CaptureMsg). */
  capture(options: Omit<CaptureMsg, "type" | "requestId"> = {}): Promise<string> {
    return this.request({ type: "capture", ...options }).then((r) => {
      const { data, error } = r as EventOf<"captured">;
      if (data === undefined) throw new Error(error ?? "capture failed");
      return data;
    });
  }

  /** Take the viewer off the page; whatever is still waiting rejects. */
  destroy(): void {
    window.removeEventListener("message", this.onMessage);
    this.iframe.remove();
    this.waiting.forEach((w) => w.reject(new Error("the viewer was destroyed")));
    this.waiting.clear();
    this.listeners.clear();
  }

  /** Resolves on the viewer's ready. */
  ready(): Promise<this> {
    return this.wait(`${this.prefix}-ready`).then(() => this);
  }

  private request(msg: HostToWebview & { requestId?: string | number }): Promise<WebviewToHost> {
    msg.requestId = `${this.prefix}-req-${++this.nextId}`;
    const done = this.wait(msg.requestId);
    this.send(msg);
    return done;
  }

  private wait(key: string | number): Promise<WebviewToHost> {
    return new Promise((resolve, reject) => this.waiting.set(key, { resolve, reject }));
  }

  private settle(key: string | number | undefined, event: WebviewToHost, error?: string): void {
    const w = key === undefined ? undefined : this.waiting.get(key);
    if (!w) return;
    this.waiting.delete(key!);
    if (error === undefined) w.resolve(event);
    else w.reject(new Error(error));
  }

  private receive(event: WebviewToHost): void {
    switch (event.type) {
      case "ready":
        this.version = event.version;
        this.apiVersion = event.apiVersion;
        this.queue?.forEach((m) => this.iframe.contentWindow?.postMessage(m, "*"));
        this.queue = null;
        this.settle(`${this.prefix}-ready`, event);
        break;
      case "itemLoaded":
        this.settle(event.id, event);
        break;
      case "itemFailed":
        this.settle(event.id, event, event.message);
        break;
      case "removed":
        this.settle(event.id, event, "removed before it was loaded"); // nothing once it was
        break;
      case "state":
      case "captured":
        this.settle(event.requestId, event);
        break;
    }
    this.listeners.get(event.type)?.forEach((fn) => fn(event));
  }
}

/**
 * Put a viewer in ``target`` (an element, or a CSS selector): an iframe filling it. Resolves once
 * the viewer is ready; the `items` are then added (wait for them with `on("itemLoaded")`, or add
 * them with `add()` to get a promise each).
 */
export async function mount(target: HTMLElement | string, options: MountOptions = {}): Promise<EmbeddedViewer> {
  const el = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
  if (!el) throw new Error(`ThreeDView.mount: no element ${String(target)}`);
  const src = new URL(options.src ?? "../embed.html", HERE);
  if (options.config) src.searchParams.set("config", JSON.stringify(options.config));
  const iframe = document.createElement("iframe");
  iframe.src = src.href;
  iframe.title = "3DView";
  iframe.style.cssText = "width:100%;height:100%;border:0;display:block";
  const viewer = new EmbeddedViewer(iframe, document.baseURI);
  const ready = viewer.ready();
  el.append(iframe);
  if (options.view) viewer.setView(options.view.position, options.view.target);
  options.items?.forEach((item) => void viewer.add(item).catch(() => undefined)); // failures: on("itemFailed")
  return ready;
}

(globalThis as { ThreeDView?: unknown }).ThreeDView = { mount };
