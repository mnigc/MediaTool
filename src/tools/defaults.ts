import type {
  AudioMergeParams,
  AudioVolumeParams,
  ContactSheetParams,
  ExtractAudioParams,
  FrameSampleParams,
  MuteParams,
  RoughCutParams,
  ScreenshotParams,
  SpeedParams,
  SubtitleParams,
  ToolId,
  ToolParams,
  TrimParams,
  VideoSilenceParams,
  WatermarkParams,
} from "../types";

export function blankToolParams(tool: ToolId): ToolParams | null {
  switch (tool) {
    case "screenshot":
      return {
        mode: "single",
        atSec: 0,
        everySec: 5,
        count: 4,
        startSec: 0,
        endSec: undefined,
        format: "png",
      } satisfies ScreenshotParams;
    case "speed":
      return { rate: 1, muteAudio: false } satisfies SpeedParams;
    case "watermark":
      return {
        imagePath: "",
        position: "br",
        scalePercent: 20,
        opacity: 1,
        marginPercent: 3,
      } satisfies WatermarkParams;
    case "trim":
      return { startTime: 0, duration: undefined, mode: "copy", segments: [] } satisfies TrimParams;
    case "mute":
      return {} satisfies MuteParams;
    case "extract-audio":
      return { format: "mp3", bitrateKbps: 128 } satisfies ExtractAudioParams;
    /* ── New video tools ── */
    case "video-subtitle":
      return { path: "", burn: true } satisfies SubtitleParams;
    /* The rough-cut editor manages its own params (timeline → clips) and
     * submits through TaskCenter directly, so the queue default is inert. */
    case "roughcut":
      return {
        mode: "copy",
        clips: [],
        container: "mp4",
      } satisfies RoughCutParams;
    case "video-frames":
      return { interval: 2, fps: 12, width: 480 } satisfies FrameSampleParams;
    case "video-contact":
      return { mode: "interval", interval: 5, count: 20, cols: 4, rows: 4, thumbW: 160 } satisfies ContactSheetParams;
    case "video-silence":
      return { threshold: -35, minLen: 2 } satisfies VideoSilenceParams;
    /* ── New audio tools ── */
    case "audio-volume":
      return { mode: "normalize" } satisfies AudioVolumeParams;
    case "audio-merge":
      return { mode: "concat" } satisfies AudioMergeParams;
    default:
      return null;
  }
}
