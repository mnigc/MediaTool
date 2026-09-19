import type { WorkflowStepInput } from "../types";
import { CRF } from "../lib/quality";
import {
  PLAYER_PREVIEW_CONTACT_PARAMS,
  VLOSSLESS_VIDEO_PARAMS,
} from "../lib/presets";

/** A named post-processing pipeline that can be bound to downloads and
 *  recordings. When the acquisition finishes, the produced file is fed
 *  through the steps in order (reusing the workflow engine, which chains
 *  each step's output into the next). */
export interface PipelinePreset {
  id: string;
  /** i18n key for the display name */
  labelKey: string;
  /** i18n key for a one-line explanation (chip tooltip / summary detail) */
  descKey: string;
  /** Treatments are mutually exclusive video operations and always run
   *  first; add-ons chain after the treatment. */
  role: "treatment" | "addon";
  steps: WorkflowStepInput[];
}

export const PIPELINE_PRESETS: PipelinePreset[] = [
  {
    id: "remux",
    labelKey: "dl.pipeline.remux",
    descKey: "dl.pipeline.remux.desc",
    role: "treatment",
    // Stream-copy into MP4: zero quality loss and near-instant. Requires the
    // source to already carry mp4-compatible codecs (H.264 + AAC).
    steps: [
      {
        toolId: "video-compress",
        params: {
          videoCodec: "copy",
          qualityMode: "crf",
          resolution: "original",
          audioCodec: "copy",
          format: "mp4",
          preset: "medium",
        },
      },
    ],
  },
  {
    id: "vlossless",
    labelKey: "dl.pipeline.vlossless",
    descKey: "dl.pipeline.vlossless.desc",
    role: "treatment",
    // Same recipe as the "视觉无损" builtin preset — shared constant, so the
    // two cannot drift apart.
    steps: [
      {
        toolId: "video-compress",
        params: { ...VLOSSLESS_VIDEO_PARAMS },
      },
    ],
  },
  {
    id: "transcode",
    labelKey: "dl.pipeline.transcode",
    descKey: "dl.pipeline.transcode.desc",
    role: "treatment",
    steps: [
      {
        toolId: "video-compress",
        params: {
          videoCodec: "libx264",
          qualityMode: "crf",
          crf: CRF.balanced,
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
    descKey: "dl.pipeline.compress.desc",
    role: "treatment",
    steps: [
      {
        toolId: "video-compress",
        params: {
          videoCodec: "libx264",
          qualityMode: "crf",
          crf: CRF.compact,
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
    descKey: "dl.pipeline.sprite.desc",
    role: "addon",
    // Same recipe as the "播放器预览" builtin preset — shared constant.
    steps: [
      {
        toolId: "video-contact",
        params: { ...PLAYER_PREVIEW_CONTACT_PARAMS },
      },
    ],
  },
  {
    id: "audio",
    labelKey: "dl.pipeline.audio",
    descKey: "dl.pipeline.audio.desc",
    role: "addon",
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
