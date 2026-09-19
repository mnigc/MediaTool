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
import { defaultParamsFor } from "../lib/defaults";
import { readStorage, writeStorage } from "../lib/storage";
import { useI18n } from "../i18n";
import { isBatchEditable } from "../tools/kinds";
import { extOk } from "../tools/FilePicker";
import { getTool, type WorkbenchId } from "../tools/registry";
import { useUploads } from "./UploadCenter";
import { runSteps } from "../workflow/runner";
import { stepsForPipelineIds } from "../workflow/pipelines";
import type { GpuInfo, WorkflowStepInput } from "../types";
import type { PipelineRun } from "../workflow/types";
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

const SETTINGS_KEY = "mediatool.settings";
const JOBS_KEY = "mediatool.jobs";

/** Drop transient runtime fields and reset in-flight jobs so a resumed
 *  session treats them as queued (the child processes are gone). */
function sanitizePersisted(j: Job): Job | null {
  if (!j || typeof j.uiId !== "string" || !j.toolId || !j.info) return null;
  return {
    uiId: j.uiId,
    toolId: j.toolId,
    info: j.info,
    params: j.params,
    percent: 0,
    phase: j.phase === "running" ? "queued" : j.phase,
    output: j.output ?? null,
    error: j.error ?? null,
    outputSize: j.outputSize ?? null,
    startedAt: j.startedAt ?? null,
    createdAt: j.createdAt ?? null,
    logs: j.logs ?? null,
    resultFiles: j.resultFiles ?? undefined,
    pipelineSteps: Array.isArray(j.pipelineSteps) ? j.pipelineSteps : [],
    // transient fields are intentionally dropped:
    // rustId, speed, sizeEstimate, estimating, pipeline (runtime state)
  };
}

function restoreJobs(): Job[] {
  try {
    const raw = readStorage(JOBS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const jobs = arr
      .map(sanitizePersisted)
      .filter((j): j is Job => j != null);
    const n = jobs.reduce((max, j) => {
      const m = /^ui-(\d+)$/.exec(j.uiId);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    if (n > 0) uiCounter = n;
    return jobs;
  } catch {
    return [];
  }
}

function loadSettings(): TaskSettings {
  const fallback: TaskSettings = {
    outputDir: null,
    outputSuffix: "_mediatool",
    maxConcurrent: 2,
    gpu: "",
    overwritePolicy: "rename",
  };
  try {
    const raw = readStorage(SETTINGS_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<TaskSettings>;
    const settings: TaskSettings = {
      ...fallback,
      ...saved,
      overwritePolicy:
        saved.overwritePolicy === "overwrite" || saved.overwritePolicy === "skip"
          ? saved.overwritePolicy
          : "rename",
    };
    // Migrate the old default output suffix so resumed sessions don't keep
    // naming outputs "_mediapress" after the rename.
    if (settings.outputSuffix === "_mediapress") settings.outputSuffix = "_mediatool";
    return settings;
  } catch {
    return fallback;
  }
}

function saveSettings(s: TaskSettings) {
  writeStorage(SETTINGS_KEY, JSON.stringify(s));
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
  addCompressFiles: (
    paths: string[],
    toolId: ToolId,
    multiFile?: boolean,
    opts?: { pipelineIds?: string[]; uploadTo?: string[] }
  ) => Promise<void>;
  mergeAndStart: (toolId: WorkbenchId, paths: string[]) => void;
  pickFiles: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<void>;
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
  addTasks: (
    toolId: ToolId,
    paths: string[],
    params: ToolParams,
    opts?: { pipelineIds?: string[]; uploadTo?: string[] }
  ) => Promise<void>;
  /** Run a pipeline over a finished job's output (card-level manual action). */
  runJobPipeline: (uiId: string, pipelineId: string) => void;
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
  const [jobs, setJobs] = useState<Job[]>(() => restoreJobs());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<TaskSettings>(loadSettings);
  const [gpuInfo, setGpuInfo] = useState<GpuInfo>({ available: false, backends: [] });

  // Auto-upload hook: resolved once, used inside the mount-only done listener.
  const { uploadOnce } = useUploads();
  const uploadOnceRef = useRef(uploadOnce);
  uploadOnceRef.current = uploadOnce;

  const jobsRef = useRef<Job[]>(jobs);
  jobsRef.current = jobs;

  // The done/progress listeners below live in a mount-only effect; they must
  // read the *current* translation function, not the one from first render.
  const tRef = useRef(t);
  tRef.current = t;
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;

  // Persist the task queue to localStorage (debounced) so history survives restarts.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        writeStorage(JOBS_KEY, JSON.stringify(jobs.map(sanitizePersisted)));
      } catch {
        // ignore quota / serialization errors
      }
    }, 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [jobs]);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const maxConcurrentRef = useRef(settings.maxConcurrent);
  maxConcurrentRef.current = settings.maxConcurrent;

  const pendingQueue = useRef<string[]>([]);
  const runningCount = useRef(0);
  // Jobs with an in-flight startJob call (double-click guard).
  const startingRef = useRef<Set<string>>(new Set());
  // In-flight bound-pipeline runs keyed by job uiId.
  const pipelineHandles = useRef(new Map<string, () => void>());

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
      const finished = jobsRef.current.find((j) => j.rustId === e.id);
      // Only running jobs hold a concurrency slot; stale events (job already
      // removed/cleared) must not decrement.
      if (finished && finished.phase === "running") {
        runningCount.current = Math.max(0, runningCount.current - 1);
      }
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
                logs: e.error ?? null,
                resultFiles: e.output ? [e.output] : undefined,
              }
            : j
        )
      );

      if (e.ok) {
        onToastRef.current?.("success", tRef.current("toast.done"));
        // Completion hooks (only for jobs this center owns — pipeline step
        // events from the download center have no matching card and are
        // ignored above). With a bound pipeline the encode output is only an
        // intermediate: run the pipeline after it; the pipeline's final
        // output is what gets pushed to the auto-upload targets.
        if (e.output && finished && finished.phase === "running") {
          if (finished.pipelineSteps && finished.pipelineSteps.length > 0) {
            runJobPipelineInternal(finished.uiId, e.output, finished.pipelineSteps);
          } else {
            // Without a bound pipeline the encode output IS the product.
            uploadOnceRef.current(finished.uploadTo ?? [], [e.output], `job-${e.id}`);
          }
        }
      } else if (!e.cancelled) {
        onToastRef.current?.(
          "error",
          tRef.current("toast.fail", { error: e.error ?? tRef.current("job.unknownError") })
        );
      }

      // Drain the pending queue, skipping stale entries (jobs removed or no
      // longer queued) so a terminal event never stalls the auto-start chain.
      while (
        pendingQueue.current.length > 0 &&
        runningCount.current < maxConcurrentRef.current
      ) {
        const next = pendingQueue.current.shift()!;
        const pendingJob = jobsRef.current.find((j) => j.uiId === next);
        if (pendingJob && pendingJob.phase === "queued") {
          void startOne(next);
          break;
        }
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

  async function addCompressFiles(
    paths: string[],
    toolId: ToolId,
    multiFile = true,
    opts?: { pipelineIds?: string[]; uploadTo?: string[] }
  ) {
    setError(null);
    const pipelineSteps = stepsForPipelineIds(opts?.pipelineIds ?? []);
    const uploadTo = opts?.uploadTo ?? [];
    const list = multiFile ? paths : paths.slice(0, 1);
    for (const p of list) {
      try {
        const info = await probeFile(p);
        const params = defaultParamsFor(toolId);
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
          createdAt: Date.now(),
          pipelineSteps,
          uploadTo,
          pipeline: null,
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
  async function addTasks(
    toolId: ToolId,
    paths: string[],
    params: ToolParams,
    opts?: { pipelineIds?: string[]; uploadTo?: string[] }
  ) {
    setError(null);
    const pipelineSteps = stepsForPipelineIds(opts?.pipelineIds ?? []);
    const uploadTo = opts?.uploadTo ?? [];
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
          createdAt: Date.now(),
          pipelineSteps,
          uploadTo,
          pipeline: null,
        };
        if (info.mediaType === "unknown") job.error = t("job.unknownError");
        setJobs((prev) => [...prev, job]);
      } catch (err) {
        setError(t("err.read", { error: String(err) }));
      }
    }
  }

  async function pickFiles(filters?: Array<{ name: string; extensions: string[] }>) {
    const selected = await open({ multiple: true, title: t("opt.selectFiles"), filters });
    if (selected && !Array.isArray(selected)) {
      dropHandlerRef.current?.([selected]);
    } else if (Array.isArray(selected)) {
      dropHandlerRef.current?.(selected);
    }
  }

  /** Create a single merge job from multiple input files and start it. */
  async function mergeAndStart(toolId: WorkbenchId, paths: string[]) {
    setError(null);
    const valid = paths.filter((p) => extOk(p, getTool(toolId)?.accepts ?? []));
    if (valid.length < 2) {
      setError(t("err.mergeMin"));
      return;
    }
    try {
      const info = await probeFile(valid[0]);
      uiCounter += 1;
      const params = defaultParamsFor(toolId as ToolId) as Record<string, unknown> & { mergeInputs?: string[] };
      params.mergeInputs = valid;
      const job: Job = {
        uiId: `ui-${uiCounter}`,
        toolId,
        info,
        params: params as JobParams,
        percent: 0,
        phase: "queued",
        output: null,
        outputSize: null,
        createdAt: Date.now(),
      };
      setJobs((prev) => [...prev, job]);
      await startOne(job.uiId);
    } catch (err) {
      setError(t("err.read", { error: String(err) }));
    }
  }

  async function chooseOutput() {
    const d = await open({ directory: true, title: t("sidebar.changeOutput") });
    if (d && !Array.isArray(d)) {
      setSettings((s) => ({ ...s, outputDir: d }));
    }
  }

  /** Run the post-processing steps bound to a finished job. Progress is
   *  written onto the job itself so its card shows an inline sub-progress
   *  instead of spawning a separate workflow entry. */
  function runJobPipelineInternal(uiId: string, input: string, steps: WorkflowStepInput[]) {
    if (steps.length === 0) return;
    const job = jobsRef.current.find((j) => j.uiId === uiId);
    const uploadTo = job?.uploadTo ?? [];
    setJobs((prev) =>
      prev.map((j) =>
        j.uiId === uiId
          ? {
              ...j,
              pipeline: {
                phase: "running",
                stepIndex: 0,
                percent: 0,
                output: null,
                error: null,
                note: null,
              } satisfies PipelineRun,
            }
          : j
      )
    );
    const handle = runSteps({
      input,
      steps,
      settings: {
        outputDir: settingsRef.current.outputDir ?? undefined,
        outputSuffix: settingsRef.current.outputSuffix || "_mediatool",
        gpu: settingsRef.current.gpu || "",
        overwritePolicy: settingsRef.current.overwritePolicy,
      },
      // Bound pipelines auto-fallback: a lossless-remux step whose source
      // codecs don't fit MP4 is swapped for the transcode recipe; the run
      // finishes with a note explaining it.
      allowCopyFallback: true,
      onProgress: (percent, stepIndex) => {
        setJobs((prev) =>
          prev.map((j) =>
            j.uiId === uiId && j.pipeline
              ? { ...j, pipeline: { ...j.pipeline, stepIndex, percent } }
              : j
          )
        );
      },
      onFinish: (ok, error, output, note) => {
        setJobs((prev) =>
          prev.map((j) =>
            j.uiId === uiId && j.pipeline
              ? {
                  ...j,
                  pipeline: {
                    ...j.pipeline,
                    phase: ok
                      ? "done"
                      : error === tRef.current("job.cancelled")
                        ? "cancelled"
                        : "error",
                    percent: ok ? 100 : j.pipeline.percent,
                    output,
                    error,
                    note,
                  },
                }
              : j
          )
        );
        // The pipeline's final output is the product — push IT to the bound
        // upload targets instead of the raw encode output.
        if (ok && output) {
          uploadOnceRef.current(uploadTo, [output], `jobpipe-${uiId}-${output}`);
        }
        pipelineHandles.current.delete(uiId);
      },
      t: (key, vars) => tRef.current(key, vars),
    });
    pipelineHandles.current.set(uiId, handle.cancel);
  }

  /** Manual card action: run a chosen pipeline over a finished job's output. */
  function runJobPipeline(uiId: string, pipelineId: string) {
    const job = jobsRef.current.find((j) => j.uiId === uiId);
    if (!job || job.phase !== "done" || !job.output) return;
    if (job.pipeline?.phase === "running") return;
    const steps = stepsForPipelineIds([pipelineId]);
    if (steps.length === 0) return;
    runJobPipelineInternal(uiId, job.output, steps);
  }

  async function startOne(uiId: string) {
    const job = jobsRef.current.find((j) => j.uiId === uiId);
    if (!job || job.phase !== "queued") return;
    // Guard against double-clicks: the job's phase stays "queued" in state
    // until the IPC call resolves, so a fast second click would pass the
    // check above and spawn a duplicate process.
    if (startingRef.current.has(uiId)) return;
    startingRef.current.add(uiId);
    setError(null);
    try {
      const extra = (job.params as unknown as { mergeInputs?: string[] }).mergeInputs;
      const inputs = extra && extra.length > 0 ? extra : [job.info.path];
      const res = await startJob({
        toolId: job.toolId,
        inputs,
        params: job.params,
        outputDir: settingsRef.current.outputDir ?? undefined,
        outputSuffix: settingsRef.current.outputSuffix || "_mediatool",
        gpu: settingsRef.current.gpu || "",
        overwritePolicy: settingsRef.current.overwritePolicy,
      });
      // Output already existed and policy = "skip": nothing was encoded.
      if (res.skipped) {
        setJobs((prev) =>
          prev.map((j) =>
            j.uiId === uiId
              ? { ...j, rustId: res.id, phase: "skipped", output: res.output ?? j.output }
              : j
          )
        );
        optsToast("info", t("job.skipped"));
        return;
      }
      // Take the concurrency slot synchronously: incrementing only after the
      // IPC round-trip would let rapid terminal events over-subscribe.
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
    } finally {
      startingRef.current.delete(uiId);
    }
  }

  async function startAll(toolId?: string) {
    const queued = jobsRef.current
      .filter(
        (j) => j.phase === "queued" && (toolId == null || j.toolId === toolId)
      )
      .map((j) => j.uiId);
    while (
      runningCount.current < maxConcurrentRef.current &&
      queued.length > 0
    ) {
      await startOne(queued.shift()!);
    }
    // Keep a unified drain queue. Do NOT replace it wholesale: overwriting
    // would drop jobs from other tools that were already waiting to auto-start.
    pendingQueue.current = Array.from(
      new Set([...pendingQueue.current, ...queued])
    );
  }

  function cancelOne(uiId: string) {
    const job = jobsRef.current.find((j) => j.uiId === uiId);
    if (job?.rustId) cancelJob(job.rustId);
    // A finished job may still be running its bound pipeline.
    pipelineHandles.current.get(uiId)?.();
    // Release the concurrency slot now; the backend's done event for this
    // (already "cancelled") job won't decrement again.
    if (job?.phase === "running") {
      runningCount.current = Math.max(0, runningCount.current - 1);
    }
    setJobs((prev) =>
      prev.map((j) =>
        j.uiId === uiId
          ? {
              ...j,
              phase: j.phase === "running" ? ("cancelled" as const) : j.phase,
              pipeline:
                j.pipeline?.phase === "running"
                  ? { ...j.pipeline, phase: "cancelled" as const }
                  : j.pipeline,
            }
          : j
      )
    );
  }

  function removeOne(uiId: string) {
    // Removing a running card must also stop the process — otherwise ffmpeg
    // keeps encoding with no UI left to cancel it. Same for its pipeline.
    const job = jobsRef.current.find((j) => j.uiId === uiId);
    if (job?.phase === "running" && job.rustId) {
      cancelJob(job.rustId);
      runningCount.current = Math.max(0, runningCount.current - 1);
    }
    pipelineHandles.current.get(uiId)?.();
    pipelineHandles.current.delete(uiId);
    setJobs((prev) => prev.filter((j) => j.uiId !== uiId));
  }

  function retryOne(uiId: string) {
    setJobs((prev) =>
      prev.map((j) =>
        j.uiId === uiId && (j.phase === "error" || j.phase === "cancelled")
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
    if (!job || job.phase !== "queued" || !isBatchEditable(job.toolId)) return;
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
    // Keep finished jobs whose bound pipeline is still running — clearing
    // them would orphan an in-flight post-processing run.
    setJobs((prev) =>
      prev.filter(
        (j) =>
          (j.phase !== "done" &&
            j.phase !== "error" &&
            j.phase !== "cancelled" &&
            j.phase !== "skipped") ||
          j.pipeline?.phase === "running"
      )
    );
  }

  function clearAll() {
    pendingQueue.current = [];
    // Stop live encodes: their done events would otherwise arrive with no job
    // to attach to, and the processes would keep running uncontrolled.
    for (const j of jobsRef.current) {
      if (j.phase === "running" && j.rustId) cancelJob(j.rustId);
    }
    for (const [uiId, cancel] of pipelineHandles.current) {
      cancel();
      pipelineHandles.current.delete(uiId);
    }
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
    mergeAndStart,
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
    runJobPipeline,
  };

  return <TaskCenterContext.Provider value={value}>{children}</TaskCenterContext.Provider>;
}
