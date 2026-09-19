import type { JobParams } from "../types";

/** One ordered processing step: an existing tool + its params. Reuses the same
 *  param types and FFmpeg builders as single tasks. */
export interface WorkflowStep {
  id: string;
  toolId: string;
  params: JobParams;
}

/** A saved multi-step pipeline definition (params only, no input file). */
export interface Workflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
  createdAt: number;
}

/** Tools offered when adding a workflow step (video in → chain). */
export const WORKFLOW_STEP_TOOLS: string[] = [
  "video-compress",
  "video-convert",
  "trim",
  "speed",
  "mute",
  "watermark",
  "screenshot",
  "extract-audio",
  "strip-metadata",
];

/** Terminal steps produce a non-video artifact (images / audio) —
 *  nothing can be chained after them, so they must stay the LAST step. */
export const TERMINAL_STEP_TOOLS: string[] = ["screenshot", "extract-audio"];

export type StepStatus = "idle" | "running" | "done" | "error";

/** Live state published by the runner for each step. */
export interface StepRun {
  index: number;
  status: StepStatus;
  percent: number;
  input?: string | null;
  output?: string | null;
  error?: string | null;
}

export interface RunSettings {
  outputDir?: string;
  outputSuffix?: string;
  gpu?: string;
  overwritePolicy?: "overwrite" | "rename" | "skip";
}

/* ── Bound pipeline runs ─────────────────────────────────────── */

export type PipelinePhase = "running" | "done" | "error" | "cancelled";

/** Inline post-processing progress rendered on the owning task's card
 *  (download cards and task-center job cards alike). */
export interface PipelineRun {
  phase: PipelinePhase;
  /** index of the running step + its percent */
  stepIndex: number;
  percent: number;
  output?: string | null;
  error?: string | null;
  /** Non-fatal adjustment (remux auto-fallback), shown on completion. */
  note?: string | null;
}

/* ── Pipeline-center runs ────────────────────────────────────── */

export type PipelineFileStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "skipped";

/** One input file inside a pipeline-center run. */
export interface PipelineRunFile {
  input: string;
  status: PipelineFileStatus;
  percent: number;
  /** Index of the step currently executing (for live labels). */
  stepIndex: number;
  output?: string | null;
  error?: string | null;
  note?: string | null;
}

/** A batch pipeline run owned by the pipeline center (workflow page). The
 *  run survives page navigation; terminal runs persist as history. */
export interface PipelineRunTask {
  id: string;
  /** Display name snapshot (pipeline name or the step chain). */
  name: string;
  steps: WorkflowStep[];
  files: PipelineRunFile[];
  /** Upload targets the run's products are pushed to on completion. */
  uploadTo: string[];
  phase: "running" | "done" | "error" | "cancelled";
  createdAt: number;
}

export interface WorkflowRunHandle {
  cancel: () => void;
  promise: Promise<void>;
}
