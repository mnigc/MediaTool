import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  cancelUpload,
  oauthBegin,
  oauthCancel,
  onOauthResult,
  onUploadDone,
  onUploadProgress,
  uploadStart,
} from "../lib/tauri";
import { readStorage, writeStorage } from "../lib/storage";
import { useI18n } from "../i18n";
import type {
  OauthBeginResult,
  UploadTarget,
  UploadTask,
} from "../types";

/* ── Persistence ────────────────────────────────────────────────── */

const TARGETS_KEY = "mediatool.upload.targets";
const TASKS_KEY = "mediatool.upload.tasks";

/** Uploads share the CPU-bound encode queue's concurrency style, but a small
 *  fixed pool of their own: two parallel transfers keep the line busy without
 *  starving any single one. */
const MAX_CONCURRENT = 2;

function loadTargets(): UploadTarget[] {
  try {
    const raw = readStorage(TARGETS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return (arr as UploadTarget[]).filter(
      (t) => t && typeof t.id === "string" && typeof t.kind === "string"
    );
  } catch {
    return [];
  }
}

/** Only terminal uploads survive a restart; in-flight transfers died with
 *  the previous process and their sessions cannot be re-adopted. */
function loadTasks(): UploadTask[] {
  try {
    const raw = readStorage(TASKS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const tasks = (arr as UploadTask[]).filter(
      (t) =>
        t &&
        typeof t.id === "string" &&
        t.phase !== "running" &&
        t.phase !== "queued"
    );
    const n = tasks.reduce((max, t) => {
      const m = /^up-(\d+)$/.exec(t.id);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    if (n > 0) uiCounter = n;
    return tasks;
  } catch {
    return [];
  }
}

/* ── Context ────────────────────────────────────────────────────── */

export interface OauthFlowState {
  requestId: string;
  kind: UploadTarget["kind"];
  redirectUri: string;
  error: string | null;
  done: boolean;
}

interface UploadCenterValue {
  targets: UploadTarget[];
  uploads: UploadTask[];
  oauth: OauthFlowState | null;
  saveTarget: (target: UploadTarget) => void;
  removeTarget: (id: string) => void;
  /** Queue one upload per (file × target). */
  startUpload: (files: string[], targetIds: string[]) => void;
  /** Completion-hook entry: uploads `files` to `targetIds` once per
   *  `dedupeKey`. Whether to upload and where is decided by the caller's
   *  bound target ids — an empty list is a no-op. */
  uploadOnce: (files: string[], targetIds: string[], dedupeKey: string) => void;
  cancelUploadTask: (id: string) => void;
  retryUploadTask: (id: string) => void;
  removeUploadTask: (id: string) => void;
  clearFinishedUploads: () => void;
  /** Start a browser OAuth flow for `draft`; on success the refresh token is
   *  merged in and the target is saved. Backend opens the browser itself. */
  beginOauth: (draft: UploadTarget) => Promise<void>;
  cancelOauth: () => void;
}

const UploadCenterContext = createContext<UploadCenterValue | null>(null);

export function useUploads(): UploadCenterValue {
  const v = useContext(UploadCenterContext);
  if (!v) throw new Error("useUploads must be used within UploadCenterProvider");
  return v;
}

let uiCounter = 0;

export function UploadCenterProvider({
  onToast,
  children,
}: {
  onToast?: (type: "success" | "error" | "info", msg: string) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [targets, setTargets] = useState<UploadTarget[]>(loadTargets);
  const [uploads, setUploads] = useState<UploadTask[]>(loadTasks);
  const [oauth, setOauth] = useState<OauthFlowState | null>(null);

  const tRef = useRef(t);
  tRef.current = t;
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;

  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;

  // Draft a login is running for; on success its refresh token is merged in.
  const oauthDraftRef = useRef<UploadTarget | null>(null);

  const pendingQueue = useRef<string[]>([]);
  const runningCount = useRef(0);
  const startingRef = useRef<Set<string>>(new Set());
  const autoUploaded = useRef<Set<string>>(new Set());
  // Speed estimation needs the previous sample per transfer.
  const lastTick = useRef<Record<string, { bytes: number; at: number }>>({});

  useEffect(() => {
    writeStorage(TARGETS_KEY, JSON.stringify(targets));
  }, [targets]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        const terminal = uploads
          .filter((u) => u.phase !== "running" && u.phase !== "queued")
          .slice(-100)
          .map(({ rustId: _r, speed: _s, ...rest }) => rest);
        writeStorage(TASKS_KEY, JSON.stringify(terminal));
      } catch {
        // ignore quota / serialization errors
      }
    }, 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [uploads]);

  const patchTask = useCallback((id: string, patch: Partial<UploadTask>) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  }, []);

  /** Start the next queued transfers while the pool has free slots. */
  const drainQueue = useCallback(() => {
    while (
      runningCount.current < MAX_CONCURRENT &&
      pendingQueue.current.length > 0
    ) {
      const next = pendingQueue.current.shift()!;
      const task = uploadsRef.current.find((u) => u.id === next);
      if (task && task.phase === "queued") {
        void dispatchOne(next);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function dispatchOne(id: string) {
    const task = uploadsRef.current.find((u) => u.id === id);
    if (!task || task.phase !== "queued") return;
    if (startingRef.current.has(id)) return;
    startingRef.current.add(id);
    try {
      const target = targetsRef.current.find((x) => x.id === task.targetId);
      if (!target) {
        patchTask(id, { phase: "error", error: tRef.current("upload.err.noTarget") });
        drainQueue();
        return;
      }
      const { id: _tid, name: _n, ...config } = target;
      const res = await uploadStart({
        target: config as unknown as Record<string, unknown>,
        filePath: task.filePath,
        name: task.fileName,
      });
      runningCount.current += 1;
      lastTick.current[res.id] = { bytes: 0, at: Date.now() };
      patchTask(id, { rustId: res.id, phase: "running", percent: 0 });
    } catch (err) {
      patchTask(id, { phase: "error", error: String(err) });
      drainQueue();
    } finally {
      startingRef.current.delete(id);
    }
  }

  /* ── event wiring ─────────────────────────────────────────────── */

  useEffect(() => {
    let active = true;
    const unlisteners: Array<() => void> = [];

    const progressUn = onUploadProgress((e) => {
      setUploads((prev) =>
        prev.map((u) => {
          if (u.rustId !== e.id) return u;
          const prevTick = lastTick.current[e.id];
          let speed = u.speed ?? null;
          if (prevTick) {
            const dt = (Date.now() - prevTick.at) / 1000;
            if (dt > 0.4) {
              const bps = Math.max(0, e.uploadedBytes - prevTick.bytes) / dt;
              speed = `${formatSpeed(bps)}`;
              lastTick.current[e.id] = { bytes: e.uploadedBytes, at: Date.now() };
            }
          }
          return { ...u, percent: e.percent, speed };
        })
      );
    });

    const doneUn = onUploadDone((e) => {
      const task = uploadsRef.current.find((u) => u.rustId === e.id);
      delete lastTick.current[e.id];
      if (task && task.phase === "running") {
        runningCount.current = Math.max(0, runningCount.current - 1);
      }
      if (task) {
        patchTask(task.id, {
          phase: e.ok ? "done" : e.cancelled ? "cancelled" : "error",
          percent: e.ok ? 100 : task.percent,
          error: e.error ?? null,
          url: e.url ?? null,
          speed: null,
        });
        if (e.ok) {
          onToastRef.current?.("success", tRef.current("upload.toast.done", { name: task.targetName }));
        } else if (!e.cancelled) {
          onToastRef.current?.(
            "error",
            tRef.current("upload.toast.fail", { name: task.targetName, error: e.error ?? tRef.current("job.unknownError") })
          );
        }
      }
      // Persist rotated refresh tokens so the target stays usable.
      if (e.newRefreshToken && task) {
        setTargets((prev) =>
          prev.map((x) =>
            x.id === task.targetId && "refreshToken" in x
              ? ({ ...x, refreshToken: e.newRefreshToken! } as UploadTarget)
              : x
          )
        );
      }
      drainQueue();
    });

    const oauthUn = onOauthResult((e) => {
      setOauth((prev) => {
        if (!prev || prev.requestId !== e.requestId) return prev;
        return { ...prev, done: true, error: e.ok ? null : e.error ?? null };
      });
      const draft = oauthDraftRef.current;
      oauthDraftRef.current = null;
      if (!e.ok) {
        const msg = e.error ?? tRef.current("upload.oauth.failed");
        onToastRef.current?.("error", msg);
        setOauth((prev) => (prev && prev.requestId === e.requestId ? { ...prev, done: true, error: msg } : prev));
        return;
      }
      if (draft) {
        const merged = mergeRefreshToken(draft, e.refreshToken ?? "");
        setTargets((targets) => {
          const exists = targets.some((x) => x.id === draft.id);
          return exists
            ? targets.map((x) => (x.id === draft.id ? merged : x))
            : [...targets, merged];
        });
      }
      onToastRef.current?.("success", tRef.current("upload.oauth.success"));
    });

    void Promise.all([progressUn, doneUn, oauthUn]).then(([a, b, c]) => {
      if (!active) {
        a();
        b();
        c();
        return;
      }
      unlisteners.push(a, b, c);
    });

    return () => {
      active = false;
      unlisteners.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── actions ──────────────────────────────────────────────────── */

  const saveTarget = useCallback((target: UploadTarget) => {
    setTargets((prev) => {
      const exists = prev.some((x) => x.id === target.id);
      return exists ? prev.map((x) => (x.id === target.id ? target : x)) : [...prev, target];
    });
  }, []);

  const removeTarget = useCallback((id: string) => {
    setTargets((prev) => prev.filter((x) => x.id !== id));
    // Queued cards pointing at the removed target cannot run anymore.
    setUploads((prev) =>
      prev.map((u) =>
        u.targetId === id && u.phase === "queued"
          ? { ...u, phase: "error", error: "Target removed" }
          : u
      )
    );
  }, []);

  const startUpload = useCallback(
    (files: string[], targetIds: string[]) => {
      const created: UploadTask[] = [];
      for (const file of files) {
        for (const targetId of targetIds) {
          const target = targetsRef.current.find((x) => x.id === targetId);
          if (!target) continue;
          uiCounter += 1;
          const norm = file.replace(/\\/g, "/");
          created.push({
            id: `up-${uiCounter}`,
            targetId,
            targetName: target.name,
            kind: target.kind,
            filePath: file,
            fileName: norm.slice(norm.lastIndexOf("/") + 1),
            size: 0,
            percent: 0,
            phase: "queued",
            error: null,
            url: null,
            createdAt: Date.now(),
          });
        }
      }
      if (created.length === 0) return;
      setUploads((prev) => [...prev, ...created]);
      pendingQueue.current.push(...created.map((u) => u.id));
      setTimeout(drainQueue, 0);
    },
    [drainQueue]
  );

  const uploadOnce = useCallback(
    (files: string[], targetIds: string[], dedupeKey: string) => {
      if (targetIds.length === 0) return;
      if (autoUploaded.current.has(dedupeKey)) return;
      autoUploaded.current.add(dedupeKey);
      startUpload(files, targetIds);
    },
    [startUpload]
  );

  const cancelUploadTask = useCallback(
    (id: string) => {
      const task = uploadsRef.current.find((u) => u.id === id);
      if (task?.rustId) void cancelUpload(task.rustId);
      if (task?.phase === "running") {
        runningCount.current = Math.max(0, runningCount.current - 1);
      }
      pendingQueue.current = pendingQueue.current.filter((x) => x !== id);
      patchTask(id, { phase: "cancelled" });
    },
    [patchTask]
  );

  const retryUploadTask = useCallback(
    (id: string) => {
      const task = uploadsRef.current.find((u) => u.id === id);
      if (!task) return;
      patchTask(id, { phase: "queued", percent: 0, error: null, url: null, rustId: undefined });
      pendingQueue.current.push(id);
      setTimeout(drainQueue, 0);
    },
    [drainQueue, patchTask]
  );

  const removeUploadTask = useCallback(
    (id: string) => {
      const task = uploadsRef.current.find((u) => u.id === id);
      if (task?.phase === "running" && task.rustId) {
        void cancelUpload(task.rustId);
        runningCount.current = Math.max(0, runningCount.current - 1);
      }
      pendingQueue.current = pendingQueue.current.filter((x) => x !== id);
      setUploads((prev) => prev.filter((u) => u.id !== id));
    },
    []
  );

  const clearFinishedUploads = useCallback(() => {
    setUploads((prev) =>
      prev.filter((u) => u.phase === "running" || u.phase === "queued")
    );
  }, []);

  const beginOauth = useCallback(async (draft: UploadTarget) => {
    let req: OauthBeginResult;
    try {
      const base = draft as unknown as Record<string, unknown>;
      req = await oauthBegin({
        kind: draft.kind as "youtube" | "gdrive" | "onedrive",
        clientId: String(base.clientId ?? ""),
        clientSecret: typeof base.clientSecret === "string" ? base.clientSecret : undefined,
        tenant: typeof base.tenant === "string" ? base.tenant : undefined,
        proxy: typeof base.proxy === "string" && base.proxy ? base.proxy : undefined,
      });
    } catch (err) {
      onToastRef.current?.("error", String(err));
      return;
    }
    oauthDraftRef.current = draft;
    setOauth({
      requestId: req.requestId,
      kind: draft.kind,
      redirectUri: req.redirectUri,
      error: null,
      done: false,
    });
  }, []);

  const cancelOauth = useCallback(() => {
    if (oauth?.requestId) void oauthCancel(oauth.requestId);
    oauthDraftRef.current = null;
    setOauth(null);
  }, [oauth?.requestId]);

  const value: UploadCenterValue = {
    targets,
    uploads,
    oauth,
    saveTarget,
    removeTarget,
    startUpload,
    uploadOnce,
    cancelUploadTask,
    retryUploadTask,
    removeUploadTask,
    clearFinishedUploads,
    beginOauth,
    cancelOauth,
  };

  return <UploadCenterContext.Provider value={value}>{children}</UploadCenterContext.Provider>;
}

/* ── helpers ────────────────────────────────────────────────────── */

function mergeRefreshToken(draft: UploadTarget, refreshToken: string): UploadTarget {
  const next = { ...draft } as UploadTarget & { refreshToken?: string };
  if (
    next.kind === "youtube" ||
    next.kind === "gdrive" ||
    next.kind === "onedrive"
  ) {
    next.refreshToken = refreshToken;
  }
  return next;
}

function formatSpeed(bps: number): string {
  if (!isFinite(bps) || bps <= 0) return "—";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bps) / Math.log(1024)));
  const v = bps / Math.pow(1024, i);
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
