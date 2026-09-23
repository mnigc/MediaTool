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
import { readStorage, writeStorage } from "../lib/storage";
import { useI18n } from "../i18n";
import { useTasks } from "./TaskCenter";
import { useUploads } from "./UploadCenter";
import { runSteps } from "../workflow/runner";
import type {
  PipelineFileStatus,
  PipelineRunFile,
  PipelineRunTask,
  WorkflowStep,
} from "../workflow/types";

/* ── Persistence ────────────────────────────────────────────────── */

const RUNS_KEY = "mediatool.pipeline.runs";

/** Only terminal runs survive a restart; in-flight ones died with the app. */
function loadRuns(): PipelineRunTask[] {
  try {
    const raw = readStorage(RUNS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return (arr as PipelineRunTask[])
      .filter((r) => r && typeof r.id === "string" && r.phase !== "running")
      .map((r) => ({ ...r, uploadTo: Array.isArray(r.uploadTo) ? r.uploadTo : [] }));
  } catch {
    return [];
  }
}

/* ── Context ────────────────────────────────────────────────────── */

interface PipelineCenterValue {
  runs: PipelineRunTask[];
  /** Queue a batch run of `steps` over `files` (processed one by one); the
   *  products are uploaded to `uploadTo` when set. Returns the run id. Runs
   *  use the shared task settings (output dir, suffix, GPU, overwrite). */
  startRun: (opts: {
    name: string;
    steps: WorkflowStep[];
    files: string[];
    uploadTo: string[];
  }) => string;
  cancelRun: (id: string) => void;
  /** Re-run the files that did not produce an output. */
  retryRun: (id: string) => void;
  removeRun: (id: string) => void;
  clearFinishedRuns: () => void;
}

const PipelineCenterContext = createContext<PipelineCenterValue | null>(null);

export function usePipelineRuns(): PipelineCenterValue {
  const v = useContext(PipelineCenterContext);
  if (!v) throw new Error("usePipelineRuns must be used within PipelineCenterProvider");
  return v;
}

let runCounter = 0;

export function PipelineCenterProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const tasks = useTasks();
  const { uploadOnce } = useUploads();

  const [runs, setRuns] = useState<PipelineRunTask[]>(loadRuns);

  const runsRef = useRef(runs);
  runsRef.current = runs;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const uploadOnceRef = useRef(uploadOnce);
  uploadOnceRef.current = uploadOnce;
  const tRef = useRef(t);
  tRef.current = t;

  /** Cancel handles for the in-flight file of each run. */
  const handles = useRef(new Map<string, () => void>());

  useEffect(() => {
    try {
      writeStorage(RUNS_KEY, JSON.stringify(runs.filter((r) => r.phase !== "running").slice(-30)));
    } catch {
      /* ignore quota errors */
    }
  }, [runs]);

  const patchFile = useCallback(
    (runId: string, index: number, patch: Partial<PipelineRunFile>) => {
      setRuns((prev) =>
        prev.map((r) =>
          r.id === runId
            ? {
                ...r,
                files: r.files.map((f, i) => (i === index ? { ...f, ...patch } : f)),
              }
            : r
        )
      );
    },
    []
  );

  const patchRun = useCallback((runId: string, patch: Partial<PipelineRunTask>) => {
    setRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, ...patch } : r)));
  }, []);

  /** Settle the run phase from its files' terminal states. */
  const settle = useCallback(
    (runId: string) => {
      const run = runsRef.current.find((r) => r.id === runId);
      if (!run || run.phase !== "running") return;
      if (run.files.some((f) => f.status === "pending")) return;
      handles.current.delete(runId);
      const failed = run.files.some((f) => f.status === "error");
      patchRun(runId, { phase: failed ? "error" : "done" });
    },
    [patchRun]
  );

  /** Start the next pending file of a run (one encode at a time — pipeline
   *  steps are full re-encodes, so parallel files would thrash the disk). */
  const advance = useCallback(
    (runId: string) => {
      const run = runsRef.current.find((r) => r.id === runId);
      if (!run || run.phase !== "running") return;
      const index = run.files.findIndex((f) => f.status === "pending");
      if (index < 0) {
        settle(runId);
        return;
      }
      const file = run.files[index];
      patchFile(runId, index, { status: "running", percent: 0, stepIndex: 0 });
      const handle = runSteps({
        input: file.input,
        steps: run.steps,
        settings: {
          outputDir: tasksRef.current.settings.outputDir ?? undefined,
          outputSuffix: tasksRef.current.settings.outputSuffix,
          gpu: tasksRef.current.settings.gpu,
          overwritePolicy: tasksRef.current.settings.overwritePolicy,
        },
        // Same graceful remux fallback the download pipelines get; the note
        // lands on the file row.
        allowCopyFallback: true,
        onProgress: (percent, stepIndex) => {
          patchFile(runId, index, { percent, stepIndex });
        },
        onFinish: (ok, error, output, note) => {
          handles.current.delete(runId);
          const status: PipelineFileStatus = ok ? "done" : error === tRef.current("job.cancelled") ? "cancelled" : "error";
          patchFile(runId, index, {
            status,
            percent: ok ? 100 : 0,
            output,
            error,
            note,
          });
          // The run's final output is the product — push it to the bound
          // upload targets like every other producer.
          if (ok && output) {
            uploadOnceRef.current([output], run.uploadTo, `run-${runId}-${index}`);
          }
          settle(runId);
          advance(runId);
        },
        t: (key, vars) => tRef.current(key, vars),
      });
      handles.current.set(runId, handle.cancel);
    },
    [patchFile, patchRun, settle]
  );

  const startRun = useCallback(
    (opts: { name: string; steps: WorkflowStep[]; files: string[]; uploadTo: string[] }) => {
      runCounter += 1;
      const id = `wfrun-${Date.now()}-${runCounter}`;
      const run: PipelineRunTask = {
        id,
        name: opts.name,
        steps: opts.steps,
        files: opts.files.map<PipelineRunFile>((input) => ({
          input,
          status: "pending",
          percent: 0,
          stepIndex: 0,
          output: null,
        })),
        uploadTo: [...opts.uploadTo],
        phase: "running",
        createdAt: Date.now(),
      };
      setRuns((prev) => [run, ...prev]);
      // Let the state commit before the first file kicks off.
      setTimeout(() => advance(id), 0);
      return id;
    },
    [advance]
  );

  const cancelRun = useCallback(
    (id: string) => {
      handles.current.get(id)?.();
      handles.current.delete(id);
      setRuns((prev) =>
        prev.map((r) => {
          if (r.id !== id || r.phase !== "running") return r;
          return {
            ...r,
            phase: "cancelled",
            files: r.files.map((f) =>
              f.status === "running" || f.status === "pending"
                ? { ...f, status: "cancelled" as const, percent: 0 }
                : f
            ),
          };
        })
      );
    },
    []
  );

  const retryRun = useCallback(
    (id: string) => {
      const run = runsRef.current.find((r) => r.id === id);
      if (!run || run.phase === "running") return;
      const retryable = run.files.some(
        (f) => f.status === "error" || f.status === "cancelled"
      );
      if (!retryable) return;
      patchRun(id, {
        phase: "running",
        files: run.files.map((f) =>
          f.status === "error" || f.status === "cancelled"
            ? { ...f, status: "pending" as const, percent: 0, error: null, output: null }
            : f
        ),
      });
      setTimeout(() => advance(id), 0);
    },
    [advance, patchRun]
  );

  const removeRun = useCallback((id: string) => {
    handles.current.get(id)?.();
    handles.current.delete(id);
    setRuns((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const clearFinishedRuns = useCallback(() => {
    setRuns((prev) => prev.filter((r) => r.phase === "running"));
  }, []);

  const value = useMemo<PipelineCenterValue>(
    () => ({
      runs,
      startRun,
      cancelRun,
      retryRun,
      removeRun,
      clearFinishedRuns,
    }),
    [runs, startRun, cancelRun, retryRun, removeRun, clearFinishedRuns]
  );

  return <PipelineCenterContext.Provider value={value}>{children}</PipelineCenterContext.Provider>;
}
