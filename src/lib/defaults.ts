import type {
  AudioParams,
  ImageParams,
  JobParams,
  MediaInfo,
  MediaType,
  ToolId,
  VideoParams,
} from "../types";
import { blankToolParams } from "../tools/defaults";
import type { WorkbenchId } from "../tools/registry";

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

/** Compress-tool defaults: keep the source container, focus on size. */
export function blankParams(mediaType: MediaType): JobParams {
  switch (mediaType) {
    case "video":
      return videoDefaults("source", 28, 128) satisfies VideoParams;
    case "image":
      return { format: "source", quality: 80, maxDimension: undefined } satisfies ImageParams;
    case "audio":
      return { format: "source", bitrateKbps: 128 } satisfies AudioParams;
    default:
      return { format: "source", quality: 80 } as JobParams;
  }
}

/** Convert-tool defaults: balanced tier of the auto-derivation tables. */
function convertParams(toolId: ToolId): JobParams | null {
  switch (toolId) {
    case "video-convert":
      return videoDefaults("mp4", 22, 192);
    case "audio-convert":
      return { format: "mp3", bitrateKbps: 192 } satisfies AudioParams;
    case "image-convert":
      return { format: "webp", quality: 80, maxDimension: undefined } satisfies ImageParams;
    default:
      return null;
  }
}

export function defaultParamsFor(toolId: ToolId): JobParams {
  switch (toolId) {
    case "video-compress":
      return blankParams("video");
    case "audio-compress":
      return blankParams("audio");
    case "image-compress":
      return blankParams("image");
    default: {
      const p = convertParams(toolId);
      if (p) return p;
      const single = blankToolParams(toolId as WorkbenchId);
      if (single) return single;
      return blankParams("video");
    }
  }
}

export function defaultParams(info: MediaInfo): JobParams {
  return blankParams(info.mediaType);
}
