//! One seam between the app and whatever is running it.
//!
//! The desktop build talks to the Rust engine through Tauri's `invoke` and its
//! webview event bus; the container build talks to the same engine over HTTP
//! and a WebSocket. Everything that differs between the two — command calls,
//! events, file pickers, "reveal in folder", drag-drop, the update check — is
//! decided here, so no page has to know which shell it is in.
//!
//! The two transports are deliberately isomorphic: the server exposes
//! `POST /api/invoke/{command}` with the same camelCase argument object Tauri
//! builds, and rejects with the same bare error string, so a call written
//! against one works unchanged against the other.

export type UnlistenFn = () => void;

/** Tauri injects this into the webview before any of our code runs. */
export const isDesktop: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Served by mediatool-server, or `vite dev` with a separate API origin. */
const API_BASE: string =
  (import.meta.env?.VITE_MEDIATOOL_URL as string | undefined)?.replace(/\/$/, "") ?? "";

const TOKEN_KEY = "mediatool.webToken";

/* ── Access token (web mode only) ─────────────────────────────── */

let token: string | null = (() => {
  if (!isDesktop) {
    const fromUrl = new URLSearchParams(window.location.search).get("token");
    if (fromUrl) {
      // Drop it from the address bar: a token in the URL ends up in browser
      // history and in anyone's shoulder-surfing range.
      window.history.replaceState(null, "", window.location.pathname);
      window.localStorage.setItem(TOKEN_KEY, fromUrl);
    }
  }
  return isDesktop ? null : window.localStorage.getItem(TOKEN_KEY);
})();

const unauthorizedListeners = new Set<() => void>();

/** Called when the server rejects our token, so the UI can ask for a new one. */
export function onUnauthorized(cb: () => void): UnlistenFn {
  unauthorizedListeners.add(cb);
  return () => unauthorizedListeners.delete(cb);
}

export function hasToken(): boolean {
  return isDesktop || (token !== null && token.length > 0);
}

export function getToken(): string {
  return token ?? "";
}

/** Store a token and reconnect the event socket with it. */
export function setToken(value: string): void {
  token = value.trim();
  if (!isDesktop) window.localStorage.setItem(TOKEN_KEY, token);
  resetSocket();
}

export function clearToken(): void {
  token = null;
  window.localStorage.removeItem(TOKEN_KEY);
  resetSocket();
}

/* ── Commands ─────────────────────────────────────────────────── */

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isDesktop) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<T>(command, args);
  }
  return rpc<T>(command, args);
}

async function rpc<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}/api/invoke/${command}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token ?? ""}`,
    },
    body: JSON.stringify(args ?? {}),
  });
  if (res.status === 401 || res.status === 403) {
    unauthorizedListeners.forEach((cb) => cb());
    throw new Error("访问令牌无效");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    // Tauri rejects with the error value itself, which `AppError` serializes
    // to a plain string; throw the same thing so `String(err)` reads the same
    // in both shells.
    throw typeof body === "string" ? body : new Error(`命令失败: ${command}`);
  }
  return body as T;
}

/* ── Media preview URLs ──────────────────────────────────────── */

/** A URL a `<video>`/`<img>` element can load a local file from, in either
 *  shell. Desktop streams it through the asset protocol; web mode streams
 *  from the authenticated `/api/media` endpoint (token in the query, like
 *  the WS handshake). */
export async function mediaStreamUrl(path: string): Promise<string> {
  if (isDesktop) {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    return convertFileSrc(path);
  }
  const params = new URLSearchParams({ path, token: token ?? "" });
  return `${API_BASE}/api/media?${params.toString()}`;
}

/* ── Events ───────────────────────────────────────────────────── */

type Handler = (payload: unknown) => void;

const handlers = new Map<string, Set<Handler>>();
let socket: WebSocket | null = null;
let retryAt = 0;

export function listen<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  if (isDesktop) {
    return import("@tauri-apps/api/event").then(({ listen: tauriListen }) =>
      tauriListen<T>(event, (e) => cb(e.payload)).then((un) => () => un())
    );
  }
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  const wrapped: Handler = (payload) => cb(payload as T);
  set.add(wrapped);
  openSocket();
  return Promise.resolve(() => {
    handlers.get(event)?.delete(wrapped);
  });
}

function socketUrl(): string {
  const url = new URL(API_BASE || window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/events";
  url.search = `token=${encodeURIComponent(token ?? "")}`;
  return url.toString();
}

function openSocket(): void {
  if (socket || !hasToken() || Date.now() < retryAt) return;
  const ws = new WebSocket(socketUrl());
  socket = ws;
  ws.onmessage = (e) => {
    let frame: { event?: string; payload?: unknown };
    try {
      frame = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (!frame?.event) return;
    handlers.get(frame.event)?.forEach((h) => h(frame.payload));
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    // Back off: a stopped container should not be hammered by every open tab.
    retryAt = Date.now() + Math.min(30000, 1000 + Math.random() * 1000);
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (!handlers.size) return;
  window.setTimeout(openSocket, Math.max(0, retryAt - Date.now()));
}

function resetSocket(): void {
  const ws = socket;
  socket = null;
  retryAt = 0;
  ws?.close();
  if (handlers.size) openSocket();
}

/* ── Everything else the shells disagree about ────────────────── */

/** A folder reveal only means something on the machine that owns the files. */
export const canRevealInFolder = isDesktop;

/** Native drag-drop hands over absolute paths; a browser web download prompt cannot. */
export function onFileDrop(cb: (paths: string[]) => void): Promise<UnlistenFn> {
  if (!isDesktop) return Promise.resolve(() => {});
  return import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") cb(event.payload.paths);
      })
      .then((un) => () => un())
  );
}

/** Absolute paths of files the user picked. Desktop: native dialog.
 *  Web: the allowlisted directory browser registered by `FileBrowserProvider`. */
export interface PickOptions {
  multiple?: boolean;
  directory?: boolean;
  title?: string;
  /** Label of the extension filter in the native dialog. */
  filterName?: string;
  extensions?: string[];
}

type Picker = (options: PickOptions) => Promise<string[]>;

let registeredPicker: Picker | null = null;

/** Called once by the directory browser; returns `[]` when the user cancels. */
export function registerFilePicker(picker: Picker | null): void {
  registeredPicker = picker;
}

export async function pickPaths(options: PickOptions): Promise<string[]> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({
      multiple: options.multiple ?? false,
      directory: options.directory ?? false,
      title: options.title,
      filters: options.extensions?.length
        ? [
            {
              name: options.filterName ?? options.title ?? "Files",
              extensions: options.extensions,
            },
          ]
        : undefined,
    });
    if (sel === null) return [];
    return Array.isArray(sel) ? sel : [sel];
  }
  if (!registeredPicker) return [];
  return registeredPicker(options);
}

/** The Downloads folder, used to seed the download output directory. */
export async function defaultDownloadDir(): Promise<string> {
  if (isDesktop) {
    const { downloadDir } = await import("@tauri-apps/api/path");
    return downloadDir();
  }
  // Convention set in docker-compose: the writable output mount is listed
  // after the read-only library.
  const { fsRoots } = await import("./engine");
  const roots = await fsRoots();
  return roots.length ? roots[roots.length - 1] : "";
}

/** Open a URL outside the app: a live room the user added, a provider consent
 *  page, release notes. Never a URL built from untrusted input. */
export function openExternal(url: string): void {
  if (isDesktop) {
    void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url));
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Min/max/close exist only in a window the app owns; a browser tab has its
 *  own chrome, so all three are no-ops there rather than failed calls. */
export const hasWindowControls = isDesktop;

type TauriWindow = import("@tauri-apps/api/window").Window;

function windowControl(run: (win: TauriWindow) => Promise<void>): void {
  if (!isDesktop) return;
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
    run(getCurrentWindow())
  );
}

export function minimizeWindow(): void {
  windowControl((win) => win.minimize());
}

/** The window starts hidden (tauri.conf) so the white cold-start screen is
 *  never seen; call once after the first paint to reveal it. */
export function revealWindow(): void {
  if (!isDesktop) return;
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
    getCurrentWindow().show().then(() => getCurrentWindow().setFocus())
  );
}

export function toggleMaximized(): void {
  windowControl((win) => win.toggleMaximize());
}

export function closeWindow(): void {
  windowControl((win) => win.close());
}

/** Version of whatever is running the engine: the app bundle, or the server
 *  process (`/healthz` is the one endpoint that answers without a token). */
export async function appVersion(): Promise<string> {
  if (isDesktop) {
    const { getVersion } = await import("@tauri-apps/api/app");
    return getVersion();
  }
  const res = await fetch(`${API_BASE}/healthz`).catch(() => null);
  if (!res?.ok) return "";
  const body = (await res.json().catch(() => null)) as { version?: string } | null;
  return body?.version ?? "";
}

/** React to the OS theme only where the webview cannot see it by itself. */
export function onSystemThemeChange(cb: (dark: boolean) => void): Promise<UnlistenFn> {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const onMedia = (e: MediaQueryListEvent) => cb(e.matches);
  mql.addEventListener("change", onMedia);
  const base: UnlistenFn = () => mql.removeEventListener("change", onMedia);
  if (isDesktop) {
    // Tauri repaints its own decorations from the window theme, which the
    // media query learns about late; listen to the window as well.
    return import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onThemeChanged((e) => cb(e.payload === "dark"))
      )
      .then((un) => () => {
        un();
        base();
      })
      .catch(() => base);
  }
  return Promise.resolve(base);
}

/** The updater and relaunch manage the desktop binary; a container image is
 *  replaced by `docker compose pull`, not from inside itself. */
export const canSelfUpdate = isDesktop;
