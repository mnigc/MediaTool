import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  cancelJob,
  detectGpu,
  estimateSize,
  onDone,
  onProgress,
  probeFile,
  startJob,
} from "../lib/tauri";
import { defaultParams } from "../lib/defaults";
import { useI18n } from "../i18n";
import type { GpuInfo } from "../types";
import type { Job, JobParams, ToolId, ToolParams } from "../types";

export interface TaskSettings {
  outputDir: string | null;
  outputSuffix: string;
  maxConcurrent: number;
  gpu: string;
  overwritePolicy: "overwrite" | "rename" | "skip";
}

export interface TaskStats {
  queuedCount: number;
  doneCount: number;
  failedCount: number;
  runningCount: number;
}

const SETTINGS_KEY = "mediapress.settings";

function loadSettings(): TaskSettings {
  const fallback: TaskSettings = {
    outputDir: null,
    outputSuffix: "_mediapress",
    maxConcurrent: 2,
    gpu: "",
    overwritePolicy: "rename",
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<TaskSettings>;
    return {
      ...fallback,
      ...saved,
      overwritePolicy:
        saved.overwritePolicy === "overwrite" || saved.overwritePolicy === "skip"
          ? saved.overwritePolicy
          : "rename",
    };
  } catch {
    return fallback;
  }
}

function saveSettings(s: TaskSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // ignore persistence failures (private mode etc.)
  }
}

interface TaskCenterValue {
  jobs: Job[];
  loading: boolean;
  error: string | null;
  settings: TaskSettings;
  gpuInfo: GpuInfo;
  stats: TaskStats;
  allDone: boolean;
  overall: number;
  totalIn: number;
  totalOut: number;
  registerDropHandler: (fn: ((paths: string[]) => void) | null) => void;
  addCompressFiles: (paths: string[]) => void;
  pickFiles: () => Promise<void>;
  chooseOutput: () => Promise<void>;
  setOutputDir: (dir: string | null) => void;
  setOutputSuffix: (suffix: string) => void;
  setMaxConcurrent: (n: number) => void;
  setGpu: (gpu: string) => void;
  setOverwritePolicy: (v: "overwrite" | "rename" | "skip") => void;
  startOne: (uiId: string) => Promise<void>;
  startAll: (toolId?: string) => Promise<void>;
  cancelOne: (uiId: string) => void;
  removeOne: (uiId: string) => void;
  retryOne: (uiId: string) => void;
  retryAllFailed: () => void;
  changeParams: (uiId: string, params: JobParams) => void;
  syncParamsToAll: (uiId: string) => void;
  clearFinished: () => void;
  clearAll: () => void;
  reorderStart: (uiId: string) => void;
  reorderOver: (uiId: string) => void;
  reorderDrop: (uiId: string) => void;
  addTasks: (toolId: ToolId, paths: string[], params: ToolParams) => Promise<void>;
}

const TaskCenterContext = createContext<TaskCenterValue | null>(null);

export function useTasks(): TaskCenterValue {
  const v = useContext(TaskCenterContext);
  if (!v) throw new Error("useTasks must be used within TaskCenterProvider");
  return v;
}

let uiCounter = 0;

export function TaskCenterProvider({
  onToast,
  children,
}: {
  onToast?: (type: "success" | "error" | "info", msg: string) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<TaskSettings>(loadSettings);
  const [gpuInfo, setGpuInfo] = useState<GpuInfo>({ available: false, backends: [] });

  const jobsRef = useRef<Job[]>(jobs);
  jobsRef.current = jobs;

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const maxConcurrentRef = useRef(settings.maxConcurrent);
  maxConcurrentRef.current = settings.maxConcurrent;

  const pendingQueue = useRef<string[]>([]);
  const runningCount = useRef(0);

  const dragId = useRef<string | null>(null);
  const dragOverId = useRef<string | null>(null);

  // Refined size-estimate (real sample encode) state.
  const estimateTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const estimateTokens = useRef<Record<string, number>>({});

  // Window-level drops are routed to the active tool's workbench.
  const dropHandlerRef = useRef<((paths: string[]) => void) | null>(null);
  function registerDropHandler(fn: ((paths: string[]) => void) | null) {
    dropHandlerRef.current = fn;
  }

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    let active = true;
    const unlisteners: Array<() => void> = [];

    const progressUn = onProgress((e) => {
      setJobs((prev) =>
        prev.map((j) =>
          j.rustId === e.id
            ? { ...j, percent: e.percent, phase: "running", speed: e.speed ?? null }
            : j
        )
      );
    });

    const doneUn = onDone((e) => {
      runningCount.current = Math.max(0, runningCount.current - 1);
      const phase: Job["phase"] = e.ok ? "done" : e.cancelled ? "cancelled" : "error";
      setJobs((prev) =>
        prev.map((j) =>
          j.rustId === e.id
            ? {
                ...j,
                phase,
                output: e.output ?? null,
                error: e.error ?? null,
                outputSize: e.outputSize ?? null,
              }
            : j
        )
      );

      if (e.ok) {
        optsToast("success", t("toast.done"));
      } else if (!e.cancelled) {
        optsToast("error", t("toast.fail", { error: e.error ?? t("job.unknownError") }));
      }

      if (
        pendingQueue.current.length > 0 &&
        runningCount.current < maxConcurrentRef.current
      ) {
        const next = pendingQueue.current.shift()!;
        void startOne(next);
      }
    });

    void Promise.all([progressUn, doneUn]).then(([a, b]) => {
      if (!active) {
        a();
        b();
        return;
      }
      unlisteners.push(a, b);
    });

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          dropHandlerRef.current?.(event.payload.paths);
        }
      })
      .then((fn) => {
        if (!active) {
          fn();
          return;
        }
        unlisteners.push(fn);
      });

    return () => {
      active = false;
      unlisteners.forEach((u) => u());
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 900);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    detectGpu()
      .then(setGpuInfo)
      .catch(() => setGpuInfo({ available: false, backends: [] }));
  }, []);

  function optsToast(type: "success" | "error" | "info", msg: string) {
    onToast?.(type, msg);
  }

  async function addCompressFiles(paths: string[]) {
    setError(null);
    for (const p of paths) {
      try {
        const info = await probeFile(p);
        const params = defaultParams(info);
        uiCounter += 1;
        const job: Job = {
          uiId: `ui-${uiCounter}`,
          toolId: "compress",
          info,
          params,
          percent: 0,
          phase: info.mediaType === "unknown" ? "error" : "queued",
          output: null,
          outputSize: null,
        };
        if (info.mediaType === "unknown") job.error = t("job.unknownError");
        setJobs((prev) => [...prev, job]);
        if (info.mediaType !== "unknown") scheduleEstimate(job.uiId);
      } catch (err) {
        setError(t("err.read", { error: String(err) }));
      }
    }
  }

  /** Create tasks for toolbox tools (single shared params for this batch). */
  async function addTasks(toolId: ToolId, paths: string[], params: ToolParams) {
    setError(null);
    for (const p of paths) {
      try {
        const info = await probeFile(p);
        uiCounter += 1;
        const job: Job = {
          uiId: `ui-${uiCounter}`,
          toolId,
          info,
          params,
          percent: 0,
          phase: info.mediaType === "unknown" ? "error" : "queued",
          output: null,
          outputSize: null,
        };
        if (info.mediaType === "unknown") job.error = t("job.unknownError");
        setJobs((prev) => [...prev, job]);
      } catch (err) {
        setError(t("err.read", { error: String(err) }));
      }
    }
  }

  async function pickFiles() {
    const selected = await open({ multiple: true, title: t("opt.selectFiles") });
    if (selected && !Array.isArray(selected)) {
      dropHandlerRef.current?.([selected]);
    } else if (Array.isArray(selected)) {
      dropHandlerRef.current?.(selected);
    }
  }

  async function chooseOutput() {
    const d = await open({ directory: true, title: t("sidebar.changeOutput") });
    if (d && !Array.isArray(d)) {
      setSettings((s) => ({ ...s, outputDir: d }));
    }
  }

  async function startOne(uiId: string) {
    const job = jobsRef.current.find((j) => j.uiId === uiId);
    if (!job || job.phase !== "queued") return;
    setError(null);
      try {
        const res = await startJob({
          toolId: job.toolId,
          inputs: [job.info.path],
          params: job.params,
          outputDir: settingsRef.current.outputDir ?? undefined,
          outputSuffix: settingsRef.current.outputSuffix || "_mediapress",
          gpu: settingsRef.current.gpu || "",
          overwritePolicy: settingsRef.current.overwritePolicy,
        });
      // Output already existed and policy = "skip": nothing was encoded.
      if (res.skipped) {
        setJobs((prev) =>
          prev.map((j) =>
            j.uiId === uiId
              ? { ...j, rustId: res.id, phase: "skipped" }
              : j
          )
        );
        optsToast("info", t("job.skipped"));
        return;
      }
      runningCount.current += 1;
      setJobs((prev) =>
        prev.map((j) =>
          j.uiId === uiId
            ? {
                ...j,
                rustId: res.id,
                percent: 0,
                phase: "running",
                startedAt: Date.now(),
              }
            : j
        )
      );
    } catch (err) {
      setError(t("err.start", { error: String(err) }));
    }
  }

  async function startAll(toolId?: string) {
    const queued = jobsRef.current.filter(
      (j) => j.phase === "queued" && (toolId == null || j.toolId === toolId)
    );
    pendingQueue.current = queued.map((j) => j.uiId);
    while (
      runningCount.current < maxConcurrentRef.current &&
      pendingQueue.current.length > 0
    ) {
      const next = pendingQueue.current.shift()!;
      await startOne(next);
    }
  }

  function cancelOne(uiId: string) {
    const job = jobsRef.current.find((j) => j.uiId === uiId);
    if (job?.rustId) cancelJob(job.rustId);
    setJobs((prev) =>
      prev.map((j) =>
        j.uiId === uiId ? { ...j, phase: "cancelled" } : j
      )
    );
  }

  function removeOne(uiId: string) {
    setJobs((prev) => prev.filter((j) => j.uiId !== uiId));
  }

  function retryOne(uiId: string) {
    setJobs((prev) =>
      prev.map((j) =>
        j.uiId === uiId && j.phase === "error"
          ? { ...j, phase: "queued", error: null, outputSize: null, startedAt: null }
          : j
      )
    );
    scheduleEstimate(uiId);
  }

  function retryAllFailed() {
    setJobs((prev) =>
      prev.map((j) =>
        j.phase === "error"
          ? { ...j, phase: "queued", error: null, outputSize: null, startedAt: null }
          : j
      )
    );
  }

  async function runEstimate(uiId: string) {
    const job = jobsRef.current.find((j) => j.uiId === uiId);
    if (!job || job.phase !== "queued" || job.toolId !== "compress") return;
    const token = (estimateTokens.current[uiId] ?? 0) + 1;
    estimateTokens.current[uiId] = token;
    setJobs((prev) =>
      prev.map((j) => (j.uiId === uiId ? { ...j, estimating: true } : j))
    );
    try {
      const res = await estimateSize({
        info: job.info,
        params: job.params,
        mediaType: job.info.mediaType,
        sampleSecs: 8,
      });
      if (estimateTokens.current[uiId] !== token) return;
      setJobs((prev) =>
        prev.map((j) =>
          j.uiId === uiId
            ? { ...j, estimating: false, sizeEstimate: { bytes: res.bytes, exact: res.exact } }
            : j
        )
      );
    } catch {
      if (estimateTokens.current[uiId] !== token) return;
      setJobs((prev) =>
        prev.map((j) => (j.uiId === uiId ? { ...j, estimating: false } : j))
      );
    }
  }

  function scheduleEstimate(uiId: string) {
    const existing = estimateTimers.current[uiId];
    if (existing) clearTimeout(existing);
    estimateTimers.current[uiId] = setTimeout(() => {
      void runEstimate(uiId);
    }, 700);
  }

  function changeParams(uiId: string, params: JobParams) {
    setJobs((prev) =>
      prev.map((j) => (j.uiId === uiId ? { ...j, params } : j))
    );
    scheduleEstimate(uiId);
  }

  function syncParamsToAll(uiId: string) {
    const source = jobsRef.current.find((j) => j.uiId === uiId);
    if (!source || source.phase !== "queued") return;
    const targets: string[] = [];
    setJobs((prev) =>
      prev.map((j) => {
        if (j.phase === "queued" && j.info.mediaType === source.info.mediaType && j.toolId === source.toolId) {
          targets.push(j.uiId);
          return { ...j, params: source.params };
        }
        return j;
      })
    );
    targets.forEach((id) => scheduleEstimate(id));
  }

  function clearFinished() {
    setJobs((prev) =>
      prev.filter(
        (j) =>
          j.phase !== "done" &&
          j.phase !== "error" &&
          j.phase !== "cancelled" &&
          j.phase !== "skipped"
      )
    );
  }

  function clearAll() {
    pendingQueue.current = [];
    runningCount.current = 0;
    setJobs([]);
  }

  function reorderStart(uiId: string) {
    dragId.current = uiId;
  }
  function reorderOver(uiId: string) {
    dragOverId.current = uiId;
  }
  function reorderDrop(uiId: string) {
    const from = dragId.current;
    dragId.current = null;
    dragOverId.current = null;
    if (!from || from === uiId) return;
    setJobs((prev) => {
      const arr = [...prev];
      const fi = arr.findIndex((j) => j.uiId === from);
      const ti = arr.findIndex((j) => j.uiId === uiId);
      if (fi < 0 || ti < 0) return prev;
      const [moved] = arr.splice(fi, 1);
      arr.splice(ti, 0, moved);
      return arr;
    });
  }

  const stats = useMemo<TaskStats>(() => {
    return {
      queuedCount: jobs.filter((j) => j.phase === "queued").length,
      doneCount: jobs.filter((j) => j.phase === "done").length,
      failedCount: jobs.filter((j) => j.phase === "error").length,
      runningCount: jobs.filter((j) => j.phase === "running").length,
    };
  }, [jobs]);

  const doneJobs = useMemo(
    () => jobs.filter((j) => j.phase === "done" && j.outputSize != null),
    [jobs]
  );

  const totalIn = useMemo(
    () => doneJobs.reduce((a, j) => a + (j.info.sizeBytes || 0), 0),
    [doneJobs]
  );
  const totalOut = useMemo(
    () => doneJobs.reduce((a, j) => a + (j.outputSize || 0), 0),
    [doneJobs]
  );
  const overall = useMemo(
    () => (totalIn > 0 ? 1 - totalOut / totalIn : 0),
    [totalIn, totalOut]
  );
  const allDone = useMemo(
    () => jobs.length > 0 && jobs.every((j) => j.phase === "done"),
    [jobs]
  );

  const value: TaskCenterValue = {
    jobs,
    loading,
    error,
    settings,
    gpuInfo,
    stats,
    allDone,
    overall,
    totalIn,
    totalOut,
    registerDropHandler,
    addCompressFiles,
    pickFiles,
    chooseOutput,
    setOutputDir: (dir) => setSettings((s) => ({ ...s, outputDir: dir })),
    setOutputSuffix: (suffix) => setSettings((s) => ({ ...s, outputSuffix: suffix })),
    setMaxConcurrent: (n) => setSettings((s) => ({ ...s, maxConcurrent: n })),
    setGpu: (gpu) => setSettings((s) => ({ ...s, gpu })),
    setOverwritePolicy: (v) => setSettings((s) => ({ ...s, overwritePolicy: v })),
    startOne,
    startAll,
    cancelOne,
    removeOne,
    retryOne,
    retryAllFailed,
    changeParams,
    syncParamsToAll,
    clearFinished,
    clearAll,
    reorderStart,
    reorderOver,
    reorderDrop,
    addTasks,
  };

  return <TaskCenterContext.Provider value={value}>{children}</TaskCenterContext.Provider>;
}
