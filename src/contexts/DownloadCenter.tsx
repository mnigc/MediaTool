import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { defaultDownloadDir } from "../lib/shell";
import {
  cancelJob,
  dlActiveTasks,
  getThumbnail,
  onDownloadDone,
  onDownloadProgress,
  onDownloadStarted,
  onStreamlinkInstallProgress,
  onYtdlpInstallProgress,
  streamlinkInstall,
  streamlinkLatestRelease,
  streamlinkStatus,
  ytdlpInstall,
  ytdlpLatestVersion,
  ytdlpStartDownload,
  ytdlpStatus,
} from "../lib/engine";
import { readStorage, writeStorage } from "../lib/storage";
import { useI18n } from "../i18n";
import { useUploads } from "./UploadCenter";
import { runSteps } from "../workflow/runner";
import type { PipelineRun } from "../workflow/types";
import type {
  DownloadRequest,
  StreamlinkStatus,
  WorkflowStepInput,
  YtdlpStatus,
} from "../types";
import { stepsForPipelineIds } from "../workflow/pipelines";

/* ── Types ──────────────────────────────────────────────────────── */

export type DownloadPhase = "running" | "done" | "error" | "cancelled";

export interface DownloadTask {
  id: string;
  url: string;
  title: string;
  kind: "download" | "record";
  quality: string;
  phase: DownloadPhase;
  percent: number;
  speed?: string | null;
  eta?: string | null;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
  postprocessing?: boolean;
  output?: string | null;
  error?: string | null;
  limitReached?: boolean;
  /** Post-processing steps bound to this task (run after a successful
   *  download). Resolved from the form's preset ids at start time. */
  pipelineSteps: WorkflowStepInput[];
  /** Upload targets bound at start time; the final product is pushed to
   *  them when the download (and its pipeline, if any) completes. */
  uploadTo: string[];
  /** Runtime state of the bound pipeline; absent until it first runs. */
  pipeline?: PipelineRun | null;
  /** Cover image URL from the link probe (may be absent for batches). */
  thumbnail?: string | null;
  createdAt: number;
  /** For retrying a plain download. Absent on monitor-driven recordings. */
  retryReq?: DownloadRequest;
}

export interface DownloadSettings {
  outputDir: string | null;
  quality: string;
  cookiesFile: string;
  cookiesText: string;
  proxy: string;
  subtitles: boolean;
}

/* ── Persistence ────────────────────────────────────────────────── */

const TASKS_KEY = "mediatool.dl.tasks";
const SETTINGS_KEY = "mediatool.dl.settings";

/** Containers that actually carry video frames — audio outputs have nothing
 *  to grab a poster from. */
const THUMB_EXTS = /\.(mp4|mkv|webm|mov|m4v|ts|flv|avi)$/i;

/** Tasks whose frame is being extracted right now. Module-level so a
 *  StrictMode remount never triggers a second extraction. */
const thumbPending = new Set<string>();

/** Locally extracted poster frames, keyed by task id. Kept in memory only —
 *  they are base64 data URLs that would bloat the persisted task list. */
function dropThumb(prev: Record<string, string>, id: string): Record<string, string> {
  if (!(id in prev)) return prev;
  const next = { ...prev };
  delete next[id];
  return next;
}

/** Drop frames of tasks that are gone; the same map is returned when nothing
 *  changed so the card list does not re-render for no reason. */
function dropThumbs(prev: Record<string, string>, keepIds: Set<string>): Record<string, string> {
  const stale = Object.keys(prev).filter((id) => !keepIds.has(id));
  if (stale.length === 0) return prev;
  const next = { ...prev };
  for (const id of stale) delete next[id];
  return next;
}

function loadSettings(): DownloadSettings {
  const fallback: DownloadSettings = {
    outputDir: null,
    quality: "best",
    cookiesFile: "",
    cookiesText: "",
    proxy: "",
    subtitles: false,
  };
  try {
    const raw = readStorage(SETTINGS_KEY);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<DownloadSettings>) };
  } catch {
    return fallback;
  }
}

/** Terminal tasks survive restarts; in-flight ones are dropped (their
 *  processes died with the app). */
function loadTasks(): DownloadTask[] {
  try {
    const raw = readStorage(TASKS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return (arr as DownloadTask[])
      .filter((t) => t && typeof t.id === "string" && t.phase !== "running")
      .map((t) => ({
        ...t,
        // Older persisted tasks predate pipelineSteps.
        pipelineSteps: Array.isArray(t.pipelineSteps) ? t.pipelineSteps : [],
        pipeline: null,
      }))
      .slice(-100);
  } catch {
    return [];
  }
}

/* ── Context ────────────────────────────────────────────────────── */

interface DownloadCenterValue {
  ytdlp: YtdlpStatus | null;
  ytdlpInstalling: boolean;
  ytdlpInstallMessage: string;
  /** Live download percentage while installing, or null when unknown. */
  ytdlpInstallPercent: number | null;
  ytdlpChecking: boolean;
  /** Latest upstream release tag found by "检查更新", or null. */
  ytdlpLatest: string | null;
  refreshYtdlp: () => void;
  installYtdlp: () => Promise<void>;
  checkYtdlpUpdate: () => Promise<void>;
  /** Live-recording engine; recordings fall back to yt-dlp when it's absent. */
  streamlink: StreamlinkStatus | null;
  streamlinkInstalling: boolean;
  streamlinkInstallMessage: string;
  streamlinkInstallPercent: number | null;
  streamlinkChecking: boolean;
  streamlinkLatest: string | null;
  refreshStreamlink: () => void;
  installStreamlink: () => Promise<void>;
  checkStreamlinkUpdate: () => Promise<void>;
  tasks: DownloadTask[];
  /** Poster frames extracted from finished files, keyed by task id. */
  thumbs: Record<string, string>;
  settings: DownloadSettings;
  updateSettings: (patch: Partial<DownloadSettings>) => void;
  startDownload: (opts: {
    url: string;
    title?: string | null;
    thumbnail?: string | null;
    quality?: string;
    audioFormat?: string | null;
    /** Preset ids selected in the form; resolved into steps at start. */
    pipelineIds?: string[];
    /** Pre-resolved steps (retry path). Takes precedence over preset ids. */
    pipelineSteps?: WorkflowStepInput[];
    /** Upload targets bound to this download. */
    uploadTo?: string[];
  }) => Promise<void>;
  cancelTask: (id: string) => void;
  removeTask: (id: string) => void;
  retryTask: (id: string) => void;
  runPipeline: (taskId: string) => void;
  clearFinished: (kind?: "download" | "record") => void;
  clearAll: () => void;
}

const DownloadCenterContext = createContext<DownloadCenterValue | null>(null);

export function useDownloads(): DownloadCenterValue {
  const v = useContext(DownloadCenterContext);
  if (!v) throw new Error("useDownloads must be used within DownloadCenterProvider");
  return v;
}

export function DownloadCenterProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [ytdlp, setYtdlp] = useState<YtdlpStatus | null>(null);  const [ytdlpInstalling, setYtdlpInstalling] = useState(false);
  const [ytdlpInstallMessage, setYtdlpInstallMessage] = useState("");
  const [ytdlpInstallPercent, setYtdlpInstallPercent] = useState<number | null>(null);
  const [ytdlpChecking, setYtdlpChecking] = useState(false);
  const [ytdlpLatest, setYtdlpLatest] = useState<string | null>(null);
  const [streamlink, setStreamlink] = useState<StreamlinkStatus | null>(null);
  const [streamlinkInstalling, setStreamlinkInstalling] = useState(false);
  const [streamlinkInstallMessage, setStreamlinkInstallMessage] = useState("");
  const [streamlinkInstallPercent, setStreamlinkInstallPercent] = useState<number | null>(null);
  const [streamlinkChecking, setStreamlinkChecking] = useState(false);
  const [streamlinkLatest, setStreamlinkLatest] = useState<string | null>(null);
  const [tasks, setTasks] = useState<DownloadTask[]>(loadTasks);
  const [settings, setSettings] = useState<DownloadSettings>(loadSettings);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  // Auto-upload hook: resolved once, used inside mount-only listeners.
  const { uploadOnce } = useUploads();
  const uploadOnceRef = useRef(uploadOnce);
  uploadOnceRef.current = uploadOnce;

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const tRef = useRef(t);
  tRef.current = t;
  const thumbsRef = useRef(thumbs);
  thumbsRef.current = thumbs;

  /** Grab a poster frame from a finished file when no probe thumbnail is
   *  available — batches skip link probing entirely, and remote thumbnails
   *  are frequently hotlink-protected. */
  const kickThumb = useCallback((id: string, output: string | null) => {
    if (!output || !THUMB_EXTS.test(output)) return;
    if (thumbsRef.current[id] || thumbPending.has(id)) return;
    thumbPending.add(id);
    void getThumbnail(output, "video")
      .then((url) => {
        if (!url) return;
        setThumbs((prev) => (prev[id] ? prev : { ...prev, [id]: url }));
      })
      .catch(() => {})
      .finally(() => {
        thumbPending.delete(id);
      });
  }, []);

  /** In-flight pipeline runs keyed by their owning task id. */
  const pipelineHandles = useRef(new Map<string, () => void>());

  /** Placeholder ids whose card was cancelled/deleted before the backend
   *  returned the real job id. A cancel aimed at a placeholder is a no-op on
   *  the engine (the yt-dlp process registers milliseconds later under the
   *  real id), so the real id gets the cancel once it lands — otherwise the
   *  download runs on with no card and no way to stop it. */
  const cancelRequestedRef = useRef(new Set<string>());

  /* persist tasks (terminal only) + settings */
  useEffect(() => {
    try {
      writeStorage(
        TASKS_KEY,
        JSON.stringify(tasks.filter((x) => x.phase !== "running").slice(-100))
      );
    } catch {
      /* ignore quota errors */
    }
  }, [tasks]);

  useEffect(() => {
    writeStorage(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  /* resolve the default output dir once (system Downloads folder) */
  useEffect(() => {
    if (settingsRef.current.outputDir) return;
    defaultDownloadDir()
      .then((d) =>
        setSettings((s) => (s.outputDir ? s : { ...s, outputDir: d }))
      )
      .catch(() => {});
  }, []);

  const refreshYtdlp = useCallback(() => {
    ytdlpStatus().then(setYtdlp).catch(() => setYtdlp(null));
  }, []);

  useEffect(() => {
    refreshYtdlp();
  }, [refreshYtdlp]);

  const refreshStreamlink = useCallback(() => {
    streamlinkStatus().then(setStreamlink).catch(() => setStreamlink(null));
  }, []);

  /* The bundled engine is unpacked in the background on first launch, and that
   * can finish either side of the progress listener below being attached, so
   * keep re-probing while it reads as absent instead of trusting one answer. */
  useEffect(() => {
    let alive = true;
    const probe = (tries: number) => {
      streamlinkStatus()
        .then((s) => {
          if (!alive) return;
          setStreamlink(s);
          if (!s.installed && tries > 0) setTimeout(() => probe(tries - 1), 3000);
        })
        .catch(() => {
          if (alive) setStreamlink(null);
        });
    };
    probe(6);
    return () => {
      alive = false;
    };
  }, []);

  const installYtdlp = useCallback(async () => {
    if (ytdlpInstalling) return;
    setYtdlpInstalling(true);
    // A fresh install/upgrade supersedes any release found by a check.
    setYtdlpLatest(null);
    setYtdlpInstallMessage(t("dl.installing"));
    setYtdlpInstallPercent(null);
    try {
      const s = await ytdlpInstall();
      setYtdlp(s);
    } catch (e) {
      setYtdlpInstallMessage(String(e));
    } finally {
      setYtdlpInstalling(false);
    }
  }, [ytdlpInstalling, t]);

  /** "检查更新" only compares release tags; the download stays behind the
   *  explicit upgrade button shown next to the result. */
  const checkYtdlpUpdate = useCallback(async () => {
    const installed = ytdlp?.version;
    if (ytdlpChecking || !installed) return;
    setYtdlpChecking(true);
    setYtdlpInstallMessage("");
    try {
      const latest = await ytdlpLatestVersion();
      setYtdlpLatest(latest);
    } catch (e) {
      setYtdlpInstallMessage(t("dl.latestError", { message: String(e).replace(/^Error: /, "") }));
    } finally {
      setYtdlpChecking(false);
    }
  }, [ytdlpChecking, ytdlp?.version, t]);

  useEffect(() => {
    let un: (() => void) | null = null;
    let active = true;
    onYtdlpInstallProgress((e) => {
      setYtdlpInstallMessage(e.message);
      setYtdlpInstallPercent(e.stage === "downloading" ? e.percent ?? null : null);
      if (e.stage === "done") refreshYtdlp();
    }).then((fn) => {
      if (!active) fn();
      else un = fn;
    });
    return () => {
      active = false;
      un?.();
    };
  }, [refreshYtdlp]);

  const installStreamlink = useCallback(async () => {
    if (streamlinkInstalling) return;
    setStreamlinkInstalling(true);
    setStreamlinkLatest(null);
    setStreamlinkInstallMessage(t("dl.installing"));
    setStreamlinkInstallPercent(null);
    try {
      const s = await streamlinkInstall();
      setStreamlink(s);
    } catch (e) {
      setStreamlinkInstallMessage(String(e));
    } finally {
      setStreamlinkInstalling(false);
    }
  }, [streamlinkInstalling, t]);

  const checkStreamlinkUpdate = useCallback(async () => {
    const installed = streamlink?.version;
    if (streamlinkChecking || !installed) return;
    setStreamlinkChecking(true);
    setStreamlinkInstallMessage("");
    try {
      const release = await streamlinkLatestRelease();
      setStreamlinkLatest(release.tag);
    } catch (e) {
      setStreamlinkInstallMessage(t("dl.latestError", { message: String(e).replace(/^Error: /, "") }));
    } finally {
      setStreamlinkChecking(false);
    }
  }, [streamlinkChecking, streamlink?.version, t]);

  useEffect(() => {
    let un: (() => void) | null = null;
    let active = true;
    onStreamlinkInstallProgress((e) => {
      setStreamlinkInstallMessage(e.message);
      setStreamlinkInstallPercent(e.stage === "downloading" ? e.percent ?? null : null);
      if (e.stage === "done") refreshStreamlink();
    }).then((fn) => {
      if (!active) fn();
      else un = fn;
    });
    return () => {
      active = false;
      un?.();
    };
  }, [refreshStreamlink]);

  /* Persisted tasks carry no thumbnails, so re-extract frames for the most
   * recent finished ones. Capped: every grab is one ffmpeg round trip. */
  useEffect(() => {
    for (const t of tasksRef.current.slice(0, 12)) {
      if (t.output && !t.thumbnail) kickThumb(t.id, t.output);
    }
  }, [kickThumb]);

  /* ── pipeline execution (workflow engine) ─────────────────────── */

  /** Run the post-processing steps bound to a finished task. Progress is
   *  written onto the task itself so its card shows an inline sub-progress
   *  instead of spawning a separate workflow entry. */
  const runPipelineInternal = useCallback(
    (taskId: string, input: string, steps: WorkflowStepInput[]) => {
      if (steps.length === 0) return;
      const uploadTo = tasksRef.current.find((x) => x.id === taskId)?.uploadTo ?? [];
      setTasks((prev) =>
        prev.map((x) =>
          x.id === taskId
            ? {
                ...x,
                pipeline: {
                  phase: "running" as DownloadPhase,
                  stepIndex: 0,
                  percent: 0,
                  output: null,
                  error: null,
                  note: null,
                },
              }
            : x
        )
      );
      const handle = runSteps({
        input,
        steps,
        // No outputDir: results land next to the acquired file.
        allowCopyFallback: true,
        onProgress: (percent, stepIndex) => {
          setTasks((prev) =>
            prev.map((x) =>
              x.id === taskId && x.pipeline
                ? {
                    ...x,
                    pipeline: {
                      ...x.pipeline,
                      stepIndex,
                      percent,
                    },
                  }
                : x
            )
          );
        },
        onFinish: (ok, error, output, note) => {
          setTasks((prev) =>
            prev.map((x) =>
              x.id === taskId && x.pipeline
                ? {
                    ...x,
                    pipeline: {
                      ...x.pipeline,
                      phase: ok
                        ? ("done" as DownloadPhase)
                        : error === tRef.current("job.cancelled")
                          ? ("cancelled" as DownloadPhase)
                          : ("error" as DownloadPhase),
                      percent: ok ? 100 : x.pipeline.percent,
                      output: output ?? null,
                      error: error ?? null,
                      note: note ?? null,
                    },
                  }
                : x
            )
          );
          // Completion hook: the pipeline's final output is the product —
          // push it to the bound upload targets.
          if (ok && output) {
            uploadOnceRef.current([output], uploadTo, `pipe-${taskId}-${output}`);
          }
          pipelineHandles.current.delete(taskId);
        },
        t: (key, vars) => tRef.current(key, vars),
      });
      pipelineHandles.current.set(taskId, handle.cancel);
    },
    []
  );

  /* ── event wiring ─────────────────────────────────────────────── */

  useEffect(() => {
    // Keep the listen promises themselves: the promise can resolve after
    // cleanup runs (StrictMode remounts, slow IPC), so `.then(push)` would
    // leave the first mount's listeners attached forever — every event then
    // handled twice. Unlistening through the promise is always exactly once.
    const unlistens: Array<Promise<() => void>> = [];

    const patchTask = (id: string, patch: Partial<DownloadTask>) => {
      setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    };

    unlistens.push(
      onDownloadProgress((e) => {
        setTasks((prev) => {
          if (!prev.some((x) => x.id === e.id)) return prev;
          return prev.map((x) =>
            // Same as the encode cards: a cancelled task's lingering engine
            // events must not flip the card back to "running".
            x.id === e.id && x.phase === "running"
              ? {
                  ...x,
                  percent: e.percent,
                  speed: e.speed ?? x.speed,
                  eta: e.eta ?? null,
                  downloadedBytes: e.downloadedBytes ?? x.downloadedBytes,
                  totalBytes: e.totalBytes ?? x.totalBytes,
                  postprocessing: e.postprocessing ?? false,
                }
              : x
          );
        });
      })
    );

    unlistens.push(
      onDownloadStarted((e) => {
        // Monitor-driven recordings announce themselves here. Plain downloads
        // create their card via startDownload(); dedupe on the real id.
        setTasks((prev) => {
          if (prev.some((x) => x.id === e.id)) return prev;
          const card: DownloadTask = {
            id: e.id,
            url: e.url,
            title: e.title,
            kind: e.kind === "record" ? "record" : "download",
            quality: "",
            phase: "running",
            percent: 0,
            pipelineSteps: e.pipeline ?? [],
            uploadTo: e.uploadTo ?? [],
            pipeline: null,
            createdAt: Date.now(),
          };
          return [card, ...prev];
        });
      })
    );

    unlistens.push(
      onDownloadDone((e) => {
        const existing = tasksRef.current.find((x) => x.id === e.id);
        // Batch items start with the URL as their title; once the real file
        // exists, show the produced filename instead.
        const titleFromFile =
          existing && /^https?:\/\//i.test(existing.title) && e.output
            ? e.output.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "")
            : null;
        patchTask(e.id, {
          phase: e.ok ? "done" : e.cancelled ? "cancelled" : "error",
          percent: e.ok ? 100 : existing?.percent ?? 0,
          output: e.output ?? null,
          error: e.error ?? null,
          limitReached: e.limitReached === true,
          postprocessing: false,
          ...(titleFromFile ? { title: titleFromFile } : {}),
        });
        // Completion hook: run the bound post-processing workflow — only on
        // the running→done transition, so a duplicated done event can never
        // start a second pipeline run for the same file.
        if (
          e.ok &&
          e.output &&
          existing?.phase === "running" &&
          existing.pipelineSteps.length > 0
        ) {
          runPipelineInternal(e.id, e.output, existing.pipelineSteps);
        }
        // Completion hook: without post-processing the downloaded file IS the
        // final product — push it to the bound upload targets.
        if (
          e.ok &&
          e.output &&
          existing?.phase === "running" &&
          existing.pipelineSteps.length === 0
        ) {
          uploadOnceRef.current([e.output], existing.uploadTo ?? [], `dl-${e.id}`);
        }
        // Batches skip link probing and remote thumbnails are often
        // hotlink-protected, so grab a frame from the finished file instead.
        // Recordings have no cover to show at all, so they're excluded.
        if (e.ok && e.output && e.kind !== "record" && !existing?.thumbnail) {
          kickThumb(e.id, e.output);
        }
      })
    );

    return () => {
      for (const p of unlistens) p.then((un) => un());
    };
  }, [runPipelineInternal, kickThumb]);

  /* Re-adopt in-flight jobs: their download-started event fired while no
     listener existed (reload/HMR) or their card was lost to the
     placeholder→real-id race. Runs on mount and then polls, so a running
     engine job can never stay cardless — an orphan with no way to cancel. */
  useEffect(() => {
    const adopt = () => {
      dlActiveTasks()
        .then((list) => {
          setTasks((prev) => {
            const missing = list.filter((j) => !prev.some((x) => x.id === j.id));
            if (missing.length === 0) return prev;
            return [
              ...missing.map((j) => ({
                id: j.id,
                url: j.url,
                title: j.title,
                kind: (j.kind === "record" ? "record" : "download") as DownloadTask["kind"],
                quality: "",
                phase: "running" as const,
                percent: 0,
                pipelineSteps: j.pipeline ?? [],
                uploadTo: j.uploadTo ?? [],
                pipeline: null,
                createdAt: Date.now(),
              })),
              ...prev,
            ];
          });
        })
        .catch(() => {});
    };
    adopt();
    const timer = setInterval(adopt, 5000);
    return () => clearInterval(timer);
  }, []);

  /* ── actions ──────────────────────────────────────────────────── */

  const startDownload = useCallback(
    async (opts: {
      url: string;
      title?: string | null;
      thumbnail?: string | null;
      quality?: string;
      audioFormat?: string | null;
      pipelineIds?: string[];
      pipelineSteps?: WorkflowStepInput[];
      uploadTo?: string[];
    }) => {
      const s = settingsRef.current;
      const dir = s.outputDir;
      if (!dir) throw new Error(t("dl.noOutputDir"));
      const quality = opts.quality || s.quality;
      const req: DownloadRequest = {
        url: opts.url,
        quality,
        audioFormat: opts.audioFormat ?? (quality === "audio" ? "mp3" : null),
        outputDir: dir,
        cookiesFile: s.cookiesFile || null,
        cookiesText: s.cookiesText || null,
        proxy: s.proxy || null,
        subtitles: s.subtitles,
        kind: "download",
        title: opts.title ?? null,
      };
      const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const card: DownloadTask = {
        id: tempId,
        url: opts.url,
        title: opts.title || opts.url,
        kind: "download",
        quality,
        phase: "running",
        percent: 0,
        pipelineSteps:
          opts.pipelineSteps ?? stepsForPipelineIds(opts.pipelineIds ?? []),
        uploadTo: opts.uploadTo ?? [],
        pipeline: null,
        thumbnail: opts.thumbnail ?? null,
        createdAt: Date.now(),
        retryReq: req,
      };
      setTasks((prev) => [card, ...prev]);
      try {
        const res = await ytdlpStartDownload(req);
      setTasks((prev) => {
        // A download-started/progress event may have created the real card
        // already; in that case drop the placeholder instead of duplicating.
        if (prev.some((x) => x.id === res.id)) {
          return prev.filter((x) => x.id !== tempId);
        }
        return prev.map((x) => (x.id === tempId ? { ...x, id: res.id } : x));
      });
      const cancelPending = cancelRequestedRef.current.delete(tempId);
      if (cancelPending) void cancelJob(res.id);
      } catch (err) {
        setTasks((prev) =>
          prev.map((x) =>
            x.id === tempId ? { ...x, phase: "error", error: String(err) } : x
          )
        );
        throw err;
      }
    },
    [t]
  );

  const cancelTask = useCallback((id: string) => {
    // A finished download may still be running its bound pipeline.
    pipelineHandles.current.get(id)?.();
    // A running placeholder carries a temp id the engine doesn't know yet;
    // remember it so startDownload re-aims the cancel at the real id.
    if (tasksRef.current.some((x) => x.id === id && x.phase === "running")) {
      cancelRequestedRef.current.add(id);
    }
    void cancelJob(id);
    setTasks((prev) =>
      prev.map((x) => (x.id === id && x.phase === "running" ? { ...x, phase: "cancelled" } : x))
    );
  }, []);

  const removeTask = useCallback((id: string) => {
    const task = tasksRef.current.find((x) => x.id === id);
    if (task?.phase === "running") {
      cancelRequestedRef.current.add(id);
      void cancelJob(id);
    } else {
      // Terminal cards normally have no backend entry, so this is a no-op —
      // but a stale "cancelled" card whose engine process lingers still gets
      // reaped here instead of being orphaned with its card deleted.
      void cancelJob(id);
    }
    if (task?.pipeline?.phase === "running") pipelineHandles.current.get(id)?.();
    setTasks((prev) => prev.filter((x) => x.id !== id));
    setThumbs((prev) => dropThumb(prev, id));
  }, []);

  const retryTask = useCallback(
    (id: string) => {
      const task = tasksRef.current.find((x) => x.id === id);
      if (!task?.retryReq) return;
      void startDownload({
        url: task.retryReq.url,
        title: task.title,
        thumbnail: task.thumbnail,
        quality: task.retryReq.quality,
        audioFormat: task.retryReq.audioFormat,
        pipelineSteps: task.pipelineSteps,
        uploadTo: task.uploadTo,
      }).then(
        // The retry card replaces the failed one; if the retry never even
        // started, keep the old card so the failure isn't lost.
        () => {
          setTasks((prev) => prev.filter((x) => x.id !== id));
          setThumbs((prev) => dropThumb(prev, id));
        },
        () => {}
      );
    },
    [startDownload]
  );

  const runPipeline = useCallback(
    (taskId: string) => {
      const task = tasksRef.current.find((x) => x.id === taskId);
      if (!task?.output || task.phase !== "done") return;
      if (task.pipelineSteps.length === 0) return;
      if (task.pipeline?.phase === "running") return;
      runPipelineInternal(task.id, task.output, task.pipelineSteps);
    },
    [runPipelineInternal]
  );

  const clearFinished = useCallback((kind?: "download" | "record") => {
    // Keep anything with work in flight, including a running pipeline on an
    // already-finished download. `kind` limits the sweep to one list, so the
    // record page never wipes download history and vice versa.
    const keptIds = new Set(
      tasksRef.current
        .filter((x) => x.phase === "running" || x.pipeline?.phase === "running" || (kind !== undefined && x.kind !== kind))
        .map((x) => x.id)
    );
    setTasks((prev) =>
      prev.filter(
        (x) =>
          x.phase === "running" ||
          x.pipeline?.phase === "running" ||
          (kind !== undefined && x.kind !== kind)
      )
    );
    setThumbs((prev) => dropThumbs(prev, keptIds));
  }, []);

  const clearAll = useCallback(() => {
    for (const x of tasksRef.current) {
      if (x.phase === "running" || x.pipeline?.phase === "running") {
        cancelRequestedRef.current.add(x.id);
        void cancelJob(x.id);
      }
    }
    for (const [id, cancel] of pipelineHandles.current) {
      cancel();
      pipelineHandles.current.delete(id);
    }
    setTasks([]);
    setThumbs({});
  }, []);

  const updateSettings = useCallback((patch: Partial<DownloadSettings>) => {
    setSettings((s) => ({ ...s, ...patch }));
  }, []);

  const value = useMemo<DownloadCenterValue>(
    () => ({
      ytdlp,
      ytdlpInstalling,
      ytdlpInstallMessage,
      ytdlpInstallPercent,
      ytdlpChecking,
      ytdlpLatest,
      refreshYtdlp,
      installYtdlp,
      checkYtdlpUpdate,
      streamlink,
      streamlinkInstalling,
      streamlinkInstallMessage,
      streamlinkInstallPercent,
      streamlinkChecking,
      streamlinkLatest,
      refreshStreamlink,
      installStreamlink,
      checkStreamlinkUpdate,
      tasks,
      thumbs,
      settings,
      updateSettings,
      startDownload,
      cancelTask,
      removeTask,
      retryTask,
      runPipeline,
      clearFinished,
      clearAll,
    }),
    [
      ytdlp,
      ytdlpInstalling,
      ytdlpInstallMessage,
      ytdlpInstallPercent,
      ytdlpChecking,
      ytdlpLatest,
      refreshYtdlp,
      installYtdlp,
      checkYtdlpUpdate,
      streamlink,
      streamlinkInstalling,
      streamlinkInstallMessage,
      streamlinkInstallPercent,
      streamlinkChecking,
      streamlinkLatest,
      refreshStreamlink,
      installStreamlink,
      checkStreamlinkUpdate,
      tasks,
      thumbs,
      settings,
      updateSettings,
      startDownload,
      cancelTask,
      removeTask,
      retryTask,
      runPipeline,
      clearFinished,
      clearAll,
    ]
  );

  return <DownloadCenterContext.Provider value={value}>{children}</DownloadCenterContext.Provider>;
}
