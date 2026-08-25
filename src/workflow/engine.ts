import {
  cancelJob,
  onDone,
  onProgress,
  startJob,
  startWorkflow as startWorkflowRust,
} from "../lib/tauri";
import type { JobRequest } from "../types";
import type {
  RunSettings,
  StepRun,
  WorkflowRunHandle,
  WorkflowStep,
} from "./types";

function buildRequest(
  step: WorkflowStep,
  input: string,
  settings: RunSettings
): JobRequest {
  return {
    toolId: step.toolId,
    inputs: [input],
    params: step.params,
        outputDir: settings.outputDir,
        outputSuffix: settings.outputSuffix || "_mediatool",
        gpu: settings.gpu || "",
    overwritePolicy: settings.overwritePolicy || "rename",
  };
}

interface StepResult {
  ok: boolean;
  output: string | null;
  skipped: boolean;
  cancelled: boolean;
  error: string | null;
}

/** Run a single step against `input`, wiring progress/done listeners, and
 *  resolve with the produced output path (or failure). */
function runOne(
  step: WorkflowStep,
  input: string,
  settings: RunSettings,
  onPercent: (p: number) => void,
  setId: (id: string) => void
): Promise<StepResult> {
  return new Promise<StepResult>((resolve) => {
    let rustId: string | null = null;
    let settled = false;
    let progressUn: (() => void) | null = null;
    let doneUn: (() => void) | null = null;

    const fin = (v: StepResult) => {
      if (settled) return;
      settled = true;
      if (progressUn) progressUn();
      if (doneUn) doneUn();
      resolve(v);
    };

    (async () => {
      try {
        progressUn = await onProgress((e) => {
          if (rustId && e.id === rustId) onPercent(e.percent);
        });
        doneUn = await onDone((e) => {
          if (rustId && e.id === rustId) {
            fin({
              ok: e.ok,
              output: e.output ?? null,
              skipped: false,
              cancelled: e.cancelled === true,
              error: e.error ?? null,
            });
          }
        });
      } catch (e) {
        fin({ ok: false, output: null, skipped: false, cancelled: false, error: String(e) });
        return;
      }

      let res;
      try {
        res = await startJob(buildRequest(step, input, settings));
      } catch (e) {
        fin({ ok: false, output: null, skipped: false, cancelled: false, error: String(e) });
        return;
      }

      if (res.skipped) {
        fin({ ok: true, output: null, skipped: true, cancelled: false, error: null });
        return;
      }

      rustId = res.id;
      setId(res.id);
    })();
  });
}

/** Watch the merged single-command run identified by `id`, broadcasting the
 *  overall percent onto the ordered steps (all earlier steps shown done, the
 *  in-flight one shown running) and resolving with the backend outcome. */
function runMerged(
  id: string,
  steps: WorkflowStep[],
  onUpdate: (r: StepRun) => void,
  onFinish: (ok: boolean, error?: string | null, output?: string | null) => void,
  t: (key: string, vars?: Record<string, string | number>) => string
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let progressUn: (() => void) | null = null;
    let doneUn: (() => void) | null = null;
    let lastCur = -1;

    const fin = (v: { ok: boolean; error?: string | null; output?: string | null }) => {
      if (settled) return;
      settled = true;
      if (progressUn) progressUn();
      if (doneUn) doneUn();
      onFinish(v.ok, v.error, v.output);
      resolve();
    };

    (async () => {
      try {
        progressUn = await onProgress((e) => {
          if (e.id !== id) return;
          const n = steps.length;
          const cur = Math.min(Math.floor((e.percent / 100) * n), n - 1);
          if (cur !== lastCur) {
            lastCur = cur;
            for (let i = 0; i < n; i++) {
              if (i < cur) {
                onUpdate({ index: i, status: "done", percent: 100 });
              } else if (i === cur) {
                onUpdate({ index: i, status: "running", percent: e.percent });
              }
            }
          }
        });
        doneUn = await onDone((e) => {
          if (e.id !== id) return;
          if (e.ok) {
            for (let i = 0; i < steps.length; i++) {
              onUpdate({ index: i, status: "done", percent: 100, output: e.output ?? undefined });
            }
            fin({ ok: true, output: e.output });
          } else {
            const idx = Math.max(lastCur, 0);
            onUpdate({ index: idx, status: "error", percent: 0, error: e.error ?? t("err.friendly.empty") });
            fin({ ok: false, error: e.error ?? t("err.friendly.empty") });
          }
        });
      } catch (err) {
        fin({ ok: false, error: String(err) });
      }
    })();
  });
}

/** Execute an ordered list of steps, feeding each step's output into the next.
 *  When every step is composable the whole chain is merged into one FFmpeg
 *  command; otherwise the steps are run one by one (with intermediate files).
 *  Returns a handle carrying `cancel()` and a completion `promise`. */
export function startWorkflow(opts: {
  input: string;
  steps: WorkflowStep[];
  settings: RunSettings;
  onUpdate: (r: StepRun) => void;
  onFinish?: (ok: boolean, error?: string | null, output?: string | null) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}): WorkflowRunHandle {
  const { input, steps, settings, onUpdate, onFinish, t } = opts;
  let cancelled = false;
  let mergedId: string | null = null;
  let activeId: string | null = null;

  const cancel = () => {
    cancelled = true;
    if (mergedId) void cancelJob(mergedId);
    if (activeId) void cancelJob(activeId);
  };

  const promise = (async () => {
    // 1) Try the merged single-command path (preferred when steps are composable).
    let usedMerged = false;
    try {
      const res = await startWorkflowRust({
        input,
        outputDir: settings.outputDir,
    outputSuffix: settings.outputSuffix || "_mediatool",
        gpu: settings.gpu || "",
        overwritePolicy: settings.overwritePolicy || "rename",
        steps: steps.map((s) => ({ toolId: s.toolId, params: s.params })),
      });
      if (res.merged) {
        usedMerged = true;
        if (res.skipped) {
          // Output already existed + policy = "skip": the backend started no
          // process and emits no done event, so finish here immediately
          // (otherwise the merge runner would hang waiting for an event).
          for (let i = 0; i < steps.length; i++) {
            onUpdate({ index: i, status: "done", percent: 100 });
          }
          onFinish?.(true, null, null);
        } else {
          mergedId = res.id;
          await runMerged(res.id, steps, onUpdate, (ok2, error, output) => {
            if (cancelled) onFinish?.(false, t("job.cancelled"), null);
            else onFinish?.(ok2, error, output);
          }, t);
        }
      }
    } catch {
      usedMerged = false;
    }

    if (usedMerged || cancelled) return;

    // 2) Fall back: run each step in sequence, feeding the previous output in.
    let working = input;
    for (let i = 0; i < steps.length; i++) {
      if (cancelled) break;
      const step = steps[i];
      const prev = working;
      onUpdate({ index: i, status: "running", percent: 0, input: prev });

      const result = await runOne(
        step,
        prev,
        settings,
        (p) => onUpdate({ index: i, status: "running", percent: p, input: prev }),
        (id) => {
          activeId = id;
        }
      );
      activeId = null;

      if (cancelled) {
        onUpdate({ index: i, status: "error", percent: 0, error: t("job.cancelled"), input: prev });
        onFinish?.(false, t("job.cancelled"), null);
        return;
      }

      if (!result.ok) {
        onUpdate({ index: i, status: "error", percent: 0, error: result.error ?? t("err.friendly.empty"), input: prev });
        onFinish?.(false, result.error ?? t("err.friendly.empty"), null);
        return;
      }

      const output = result.output ?? prev;
      onUpdate({ index: i, status: "done", percent: 100, input: prev, output });
      working = output;
    }

    if (!cancelled) {
      onFinish?.(true, null, working);
    }
  })();

  return { cancel, promise };
}
