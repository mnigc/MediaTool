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
  "rotate",
  "speed",
  "mute",
  "watermark",
  "gif",
  "screenshot",
  "extract-audio",
  "strip-metadata",
];

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

export interface WorkflowRunHandle {
  cancel: () => void;
  promise: Promise<void>;
}
