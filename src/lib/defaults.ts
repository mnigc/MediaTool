import type {
  AudioParams,
  ImageParams,
  JobParams,
  MediaInfo,
  MediaType,
  VideoParams,
} from "../types";

export function blankParams(mediaType: MediaType): JobParams {
  switch (mediaType) {
    case "video":
      return {
        videoCodec: "libx264",
        qualityMode: "crf",
        crf: 28,
        resolution: "original",
        audioCodec: "aac",
        audioBitrateKbps: 128,
        format: "mp4",
        preset: "medium",
        startTime: undefined,
        duration: undefined,
        fps: undefined,
        stripMetadata: false,
        extractAudio: false,
        extractFormat: "mp3",
      } satisfies VideoParams;
    case "image":
      return { format: "webp", quality: 80, stripMetadata: false } satisfies ImageParams;
    case "audio":
      return { format: "mp3", bitrateKbps: 128, stripMetadata: false } satisfies AudioParams;
    default:
      return { format: "mp4", quality: 80 } as JobParams;
  }
}

export function defaultParams(info: MediaInfo): JobParams {
  return blankParams(info.mediaType);
}
