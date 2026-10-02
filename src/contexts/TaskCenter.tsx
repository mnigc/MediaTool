import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { onFileDrop, pickPaths } from "../lib/shell";
import {
  cancelJob,
  detectGpu,
  estimateSize,
  onDone,
  onProgress,
  probeFile,
  startJob,
} from "../lib/engine";
import { defaultParamsFor } from "../lib/defaults";
import { readStorage, writeStorage } from "../lib/storage";
import { useI18n } from "../i18n";
import { isBatchEditable } from "../tools/kinds";
import { extOk } from "../tools/FilePicker";
import { getTool, type WorkbenchId } from "../tools/registry";
import { useUploadActions } from "./UploadCenter";
import { runSteps } from "../workflow/runner";
import { stepsForPipelineIds } from "../workflow/pipelines";
import type { GpuInfo, RoughCutParams, WorkflowStepInput } from "../types";
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
    // uploadTo is persisted configuration (like pipelineSteps), not runtime
    // state — dropping it meant a restored job finished without ever pushing
    // its product to the auto-upload targets it was created with.
    uploadTo: j.uploadTo ?? [],
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

/** High-frequency state: the jobs array is replaced on every progress event,
 *  so this value changes often. Components that only trigger actions should
 *  subscribe to TaskActionsContext instead. */
export interface TaskDataValue {
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
}

/** Stable action callbacks. Every action reads refs / setState only (t and
 *  onToast go through their refs), so the identities never change. */
export interface TaskActionsValue {
  registerDropHandler: (fn: ((paths: string[]) => void) | null) => void;
  addCompressFiles: (
    paths: string[],
    toolId: ToolId,
    multiFile?: boolean,
    opts?: { pipelineIds?: string[]; uploadTo?: string[] }
  ) => Promise<void>;
  mergeAndStart: (toolId: WorkbenchId, paths: string[]) => void;
  /** Queue the rough-cut timeline as one export job and start it. */
  startRoughCut: (params: RoughCutParams) => Promise<void>;
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

const TaskCenterContext = createContext<TaskDataValue | null>(null);
const TaskActionsContext = createContext<TaskActionsValue | null>(null);

/** Data half only. Re-renders the caller on every progress event — pair it
 *  with useTaskActions() when actions are needed too. */
export function useTasks(): TaskDataValue {
  const v = useContext(TaskCenterContext);
  if (!v) throw new Error("useTasks must be used within TaskCenterProvider");
  return v;
}

/** Actions half only. Identity-stable, so callers that only trigger actions
 *  never re-render on progress events. */
export function useTaskActions(): TaskActionsValue {
  const v = useContext(TaskActionsContext);
  if (!v) throw new Error("useTaskActions must be used within TaskCenterProvider");
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
  const { uploadOnce } = useUploadActions();
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
  // Jobs that currently hold a concurrency slot. Claim/release is paired
  // through this set so releases are exactly-once no matter the ordering of
  // cancel/remove/done events (previously cancelOne decremented immediately
  // and the trailing done event decremented again, drifting the count).
  const slotHolders = useRef<Set<string>>(new Set());
  // Jobs with an in-flight startJob call (double-click guard).
  const startingRef = useRef<Set<string>>(new Set());
  // In-flight bound-pipeline runs keyed by job uiId.
  const pipelineHandles = useRef(new Map<string, () => void>());

  const dragId = useRef<string | null>(null);
  const dragOverId = useRef<string | null>(null);

  // Refined size-estimate (real sample encode) state.
  const estimateTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const estimateTokens = useRef<Record<string, number>>({});

  // Single release path for concurrency slots, paired with startOne's claim.
  // Only a job that still holds its slot can decrement, so a cancel's earlier
  // release or a duplicated terminal event can never double-count.
  function releaseSlot(uiId: string) {
    if (slotHolders.current.delete(uiId)) {
      runningCount.current = Math.max(0, runningCount.current - 1);
    }
  }

  // Drop a job's pending size-estimate bookkeeping (timer + generation token)
  // so nothing fires for a job that is gone.
  function clearEstimate(uiId: string) {
    const timer = estimateTimers.current[uiId];
    if (timer) clearTimeout(timer);
    delete estimateTimers.current[uiId];
    delete estimateTokens.current[uiId];
  }

  // Nothing may outlive the provider: pending estimate timers would fire
  // into unmounted state after it is torn down.
  useEffect(() => {
    return () => {
      for (const timer of Object.values(estimateTimers.current)) clearTimeout(timer);
      estimateTimers.current = {};
      estimateTokens.current = {};
    };
  }, []);

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
          // Only queued/running cards follow progress: a cancelled job's
          // engine lingers a few seconds and its stray events must not
          // resurrect the card into "running".
          j.rustId === e.id && (j.phase === "queued" || j.phase === "running")
            ? { ...j, percent: e.percent, phase: "running", speed: e.speed ?? null }
            : j
        )
      );
    });

    const doneUn = onDone((e) => {
      const finished = jobsRef.current.find((j) => j.rustId === e.id);
      // Exactly-once slot release, paired with startOne's claim: only a job
      // that still holds its slot decrements here, so a cancel's earlier
      // release (or a duplicated terminal event) can't decrement twice.
      if (finished) releaseSlot(finished.uiId);
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
                resultFiles: e.outputs ?? (e.output ? [e.output] : undefined),
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
            // Without a bound pipeline the encode output IS the product — the
            // whole set of it, so a multi-segment job delivers every part.
            uploadOnceRef.current(
              e.outputs ?? [e.output],
              finished.uploadTo ?? [],
              `job-${e.id}`
            );
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

    void onFileDrop((paths) => dropHandlerRef.current?.(paths)).then((fn) => {
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
    // Through the ref so the actions bundle below can stay referentially
    // stable even when the onToast prop identity changes.
    onToastRef.current?.(type, msg);
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
        if (info.mediaType === "unknown") job.error = tRef.current("job.unknownError");
        setJobs((prev) => [...prev, job]);
        if (info.mediaType !== "unknown") scheduleEstimate(job.uiId);
      } catch (err) {
        setError(tRef.current("err.read", { error: String(err) }));
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
        if (info.mediaType === "unknown") job.error = tRef.current("job.unknownError");
        setJobs((prev) => [...prev, job]);
      } catch (err) {
        setError(tRef.current("err.read", { error: String(err) }));
      }
    }
  }

  async function pickFiles(filters?: Array<{ name: string; extensions: string[] }>) {
    const selected = await pickPaths({
      multiple: true,
      title: tRef.current("opt.selectFiles"),
      filterName: filters?.[0]?.name,
      extensions: filters?.[0]?.extensions,
    });
    if (selected.length) dropHandlerRef.current?.(selected);
  }

  /** Create a single merge job from multiple input files and start it. */
  async function mergeAndStart(toolId: WorkbenchId, paths: string[]) {
    setError(null);
    const valid = paths.filter((p) => extOk(p, getTool(toolId)?.accepts ?? []));
    if (valid.length < 2) {
      setError(tRef.current("err.mergeMin"));
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
      // Mirror the job into the ref synchronously: `startOne` looks the job
      // up in `jobsRef` before React re-renders with the new state, and a
      // stale ref made the lookup silently fail (the merge never started).
      const next = [...jobsRef.current, job];
      jobsRef.current = next;
      setJobs(next);
      await startOne(job.uiId);
    } catch (err) {
      setError(tRef.current("err.read", { error: String(err) }));
    }
  }

  async function chooseOutput() {
    const [dir] = await pickPaths({ directory: true, title: tRef.current("sidebar.changeOutput") });
    if (dir) setSettings((s) => ({ ...s, outputDir: dir }));
  }

  /** Create a single rough-cut export job from the timeline and start it.
   *  The backend names the deliverable after the first clip; inputs[0] is
   *  that first clip's path, and the clips themselves travel in params. */
  async function startRoughCut(params: RoughCutParams) {
    setError(null);
    const first = params.clips[0]?.path;
    if (!first) {
      setError(tRef.current("rc.errEmpty"));
      return;
    }
    try {
      const info = await probeFile(first);
      uiCounter += 1;
      const job: Job = {
        uiId: `ui-${uiCounter}`,
        toolId: "roughcut",
        info,
        params,
        percent: 0,
        phase: "queued",
        output: null,
        outputSize: null,
        createdAt: Date.now(),
      };
      // Mirror the job into the ref synchronously: `startOne` looks the job
      // up in `jobsRef` before React re-renders with the new state.
      const next = [...jobsRef.current, job];
      jobsRef.current = next;
      setJobs(next);
      await startOne(job.uiId);
    } catch (err) {
      setError(tRef.current("err.read", { error: String(err) }));
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
          uploadOnceRef.current([output], uploadTo, `jobpipe-${uiId}-${output}`);
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
        optsToast("info", tRef.current("job.skipped"));
        return;
      }
      // Claim the concurrency slot synchronously (before the state flip) and
      // record the holder so the matching release stays exactly-once.
      slotHolders.current.add(uiId);
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
      // Surface the failure on the job itself: leaving it "queued" would
      // create a phantom entry that never runs and can't be retried.
      setError(tRef.current("err.start", { error: String(err) }));
      setJobs((prev) =>
        prev.map((j) =>
          j.uiId === uiId ? { ...j, phase: "error", error: String(err) } : j
        )
      );
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
    // Release the slot through the paired path; the backend's trailing done
    // event for this job releases nothing (the slot is already given back),
    // so the count can no longer drift downwards on cancel.
    releaseSlot(uiId);
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
    if (job?.phase === "running" && job.rustId) cancelJob(job.rustId);
    releaseSlot(uiId);
    pipelineHandles.current.get(uiId)?.();
    pipelineHandles.current.delete(uiId);
    // The card is gone: a pending size-estimate must not fire for it.
    clearEstimate(uiId);
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
    // Compute the affected ids from the mirrored ref BEFORE the updater:
    // side effects inside a setState updater run twice under StrictMode
    // (double-invoked updaters), which duplicated the estimate scheduling.
    const targetIds = jobsRef.current
      .filter(
        (j) =>
          j.phase === "queued" &&
          j.info.mediaType === source.info.mediaType &&
          j.toolId === source.toolId
      )
      .map((j) => j.uiId);
    setJobs((prev) =>
      prev.map((j) =>
        targetIds.includes(j.uiId) ? { ...j, params: source.params } : j
      )
    );
    targetIds.forEach((id) => scheduleEstimate(id));
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
    for (const uiId of Object.keys(estimateTimers.current)) clearEstimate(uiId);
    slotHolders.current.clear();
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
  // "Skipped" is a terminal state too: a list holding skipped jobs (overwrite
  // policy = skip) is finished and must still show the all-done banner.
  const allDone = useMemo(
    () =>
      jobs.length > 0 &&
      jobs.every((j) => j.phase === "done" || j.phase === "skipped"),
    [jobs]
  );

  // The data value is rebuilt only when the state it exposes changes; the
  // action functions live in their own context below so a progress tick never
  // reaches consumers that only trigger actions.
  const value = useMemo<TaskDataValue>(
    () => ({
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
    }),
    [jobs, loading, error, settings, gpuInfo, stats, allDone, overall, totalIn, totalOut]
  );

  // Every action reads refs / setState only (t and onToast go through their
  // refs), so capturing the first render's instances is safe and the memo
  // never needs to recompute: the identities are stable for the provider's
  // whole lifetime, which is what lets memo'd cards keep their callbacks.
  const actions = useMemo<TaskActionsValue>(
    () => ({
      registerDropHandler,
      addCompressFiles,
      mergeAndStart,
      startRoughCut,
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
    }),
    // The action functions are intentionally not listed: they never change
    // identity (see the comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return (
    <TaskCenterContext.Provider value={value}>
      <TaskActionsContext.Provider value={actions}>{children}</TaskActionsContext.Provider>
    </TaskCenterContext.Provider>
  );
}
