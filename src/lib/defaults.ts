import type {
  AudioParams,
  JobParams,
  ToolId,
  VideoParams,
} from "../types";
import { blankToolParams } from "../tools/defaults";
import type { WorkbenchId } from "../tools/registry";
import { CRF } from "./quality";

function videoDefaults(format: string, crf: number, audioKbps: number): VideoParams {
  return {
    videoCodec: "libx264",
    qualityMode: "crf",
    crf,
    resolution: "original",
    audioCodec: "aac",
    audioBitrateKbps: audioKbps,
    format,
    preset: "medium",
    fps: undefined,
  };
}

/** Transcode defaults: keep the source container, balanced quality/size. */
export function blankParams(mediaType: "video" | "audio"): JobParams {
  switch (mediaType) {
    case "video":
      return videoDefaults("source", CRF.balanced, 128) satisfies VideoParams;
    case "audio":
      return { format: "source", bitrateKbps: 128 } satisfies AudioParams;
    default:
      return { format: "source", bitrateKbps: 128 } as JobParams;
  }
}

export function defaultParamsFor(toolId: ToolId): JobParams {
  switch (toolId) {
    case "video-compress":
      return blankParams("video");
    case "audio-compress":
      return blankParams("audio");
    default: {
      const single = blankToolParams(toolId as WorkbenchId);
      if (single) return single;
      return blankParams("video");
    }
  }
}
