import { startWorkflow } from "./engine";
import type { RunSettings, WorkflowStep } from "./types";
import type { WorkflowStepInput } from "../types";

export type TranslateFn = (
  key: string,
  vars?: Record<string, string | number>
) => string;

/** Shared "run these steps on this finished file" wiring used by both bound
 *  post-processing consumers: the download center (runs after a download or
 *  recording completes) and the task center (runs after a job completes).
 *  Progress is flattened to one percent across all steps so the owning card
 *  can render a single sub-progress bar. Returns a cancel handle. */
export function runSteps(opts: {
  input: string;
  steps: WorkflowStepInput[];
  /** Defaults: next to the input file, "_mediatool" suffix, CPU, rename. */
  settings?: Partial<RunSettings>;
  /** Bound pipelines auto-fallback: a lossless-remux step whose source codecs
   *  don't fit MP4 is swapped for the transcode recipe; the run finishes with
   *  a note explaining it. */
  allowCopyFallback?: boolean;
  onProgress: (percent: number, stepIndex: number) => void;
  onFinish: (
    ok: boolean,
    error: string | null,
    output: string | null,
    note: string | null
  ) => void;
  t: TranslateFn;
}): { cancel: () => void } {
  const steps: WorkflowStep[] = opts.steps.map((s, i) => ({
    id: `${i}`,
    toolId: s.toolId,
    params: s.params,
  }));
  const handle = startWorkflow({
    input: opts.input,
    steps,
    settings: {
      outputSuffix: "_mediatool",
      gpu: "",
      overwritePolicy: "rename",
      ...opts.settings,
    },
    allowCopyFallback: opts.allowCopyFallback === true,
    onUpdate: (r) => {
      const percent =
        r.status === "done"
          ? 100
          : ((r.index + r.percent / 100) / steps.length) * 100;
      opts.onProgress(percent, r.index);
    },
    onFinish: (ok, error, output, note) => {
      opts.onFinish(ok, error ?? null, output ?? null, note ?? null);
    },
    t: opts.t,
  });
  return { cancel: handle.cancel };
}
