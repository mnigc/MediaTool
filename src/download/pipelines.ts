import type { WorkflowStepInput } from "../types";

/** A named post-processing pipeline that can be bound to downloads and
 *  recordings. When the acquisition finishes, the produced file is fed
 *  through the steps in order (reusing the workflow engine). */
export interface PipelinePreset {
  id: string;
  /** i18n key for the display name */
  labelKey: string;
  steps: WorkflowStepInput[];
}

export const PIPELINE_PRESETS: PipelinePreset[] = [
  {
    id: "transcode",
    labelKey: "dl.pipeline.transcode",
    steps: [
      {
        toolId: "video-compress",
        params: {
          videoCodec: "libx264",
          qualityMode: "crf",
          crf: 23,
          resolution: "original",
          audioCodec: "aac",
          audioBitrateKbps: 192,
          format: "mp4",
          preset: "medium",
        },
      },
    ],
  },
  {
    id: "compress",
    labelKey: "dl.pipeline.compress",
    steps: [
      {
        toolId: "video-compress",
        params: {
          videoCodec: "libx264",
          qualityMode: "crf",
          crf: 28,
          resolution: "original",
          audioCodec: "aac",
          audioBitrateKbps: 128,
          format: "source",
          preset: "medium",
        },
      },
    ],
  },
  {
    id: "sprite",
    labelKey: "dl.pipeline.sprite",
    steps: [
      {
        toolId: "video-contact",
        params: {
          mode: "count",
          interval: 5,
          count: 100,
          countCols: 10,
          cols: 10,
          rows: 10,
          thumbW: 160,
        },
      },
    ],
  },
  {
    id: "audio",
    labelKey: "dl.pipeline.audio",
    steps: [
      {
        toolId: "extract-audio",
        params: { format: "mp3", bitrateKbps: 192 },
      },
    ],
  },
];

export function presetById(id: string): PipelinePreset | undefined {
  return PIPELINE_PRESETS.find((p) => p.id === id);
}

/** Merge the selected preset ids (in selection order) into a step list. */
export function stepsForPresets(ids: string[]): WorkflowStepInput[] {
  return ids.flatMap((id) => presetById(id)?.steps ?? []);
}
