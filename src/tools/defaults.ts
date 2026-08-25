import type {
  AddAudioParams,
  AudioMergeParams,
  AudioTrimParams,
  AudioVolumeParams,
  ContactSheetParams,
  CropParams,
  ExtractAudioParams,
  FadeParams,
  FrameSampleParams,
  GifParams,
  ImageAdjustParams,
  ImageCropParams,
  ImagePdfParams,
  ImageResizeParams,
  ImageRotateParams,
  ImageWatermarkParams,
  MuteParams,
  PitchParams,
  RotateParams,
  SilenceParams,
  ScreenshotParams,
  SpeedParams,
  StripMetadataParams,
  SubtitleParams,
  ToolParams,
  TrimParams,
  VideoMergeParams,
  VideoReverseParams,
  VideoSilenceParams,
  VideoVolumeParams,
  WatermarkParams,
} from "../types";
import type { WorkbenchId } from "./registry";

export function blankToolParams(tool: WorkbenchId): ToolParams | null {
  switch (tool) {
    case "gif":
      return {
        startTime: undefined,
        duration: undefined,
        fps: 12,
        width: 480,
      } satisfies GifParams;
    case "screenshot":
      return {
        mode: "single",
        atSec: 0,
        everySec: 5,
        startSec: 0,
        endSec: undefined,
        format: "png",
      } satisfies ScreenshotParams;
    case "speed":
      return { rate: 2, muteAudio: false } satisfies SpeedParams;
    case "watermark":
      return {
        imagePath: "",
        position: "br",
        scalePercent: 20,
        opacity: 1,
        marginPercent: 3,
      } satisfies WatermarkParams;
    case "trim":
      return { startTime: 0, duration: undefined, mode: "copy" } satisfies TrimParams;
    case "rotate":
      return { transform: "90c" } satisfies RotateParams;
    case "mute":
      return {} satisfies MuteParams;
    case "extract-audio":
      return { format: "mp3", bitrateKbps: 128 } satisfies ExtractAudioParams;
    case "strip-metadata":
      return {} satisfies StripMetadataParams;
    /* ── New video tools ── */
    case "video-crop":
      return { mode: "center", aspect: "16:9" } satisfies CropParams;
    case "video-volume":
      return { mode: "normalize" } satisfies VideoVolumeParams;
    case "video-reverse":
      return {} satisfies VideoReverseParams;
    case "video-subtitle":
      return { path: "", burn: true } satisfies SubtitleParams;
    case "video-addaudio":
      return { audioPath: "", mode: "replace", volume: 1 } satisfies AddAudioParams;
    case "video-merge":
      return { mode: "concat" } satisfies VideoMergeParams;
    case "video-frames":
      return { interval: 2, fps: 12, width: 480 } satisfies FrameSampleParams;
    case "video-contact":
      return { interval: 5, cols: 4, rows: 4, thumbW: 160 } satisfies ContactSheetParams;
    case "video-silence":
      return { threshold: -35, minLen: 2 } satisfies VideoSilenceParams;
    /* ── New audio tools ── */
    case "audio-trim":
      return { startTime: 0, duration: undefined } satisfies AudioTrimParams;
    case "audio-fade":
      return { inSec: 1, outSec: 1 } satisfies FadeParams;
    case "audio-volume":
      return { mode: "normalize" } satisfies AudioVolumeParams;
    case "audio-pitch":
      return { speed: 1, pitch: 0 } satisfies PitchParams;
    case "audio-silence":
      return { mode: "remove", thresholdDb: -35, minLen: 0.5 } satisfies SilenceParams;
    case "audio-merge":
      return { mode: "concat" } satisfies AudioMergeParams;
    /* ── New image tools ── */
    case "image-resize":
      return { mode: "longest", width: 1280 } satisfies ImageResizeParams;
    case "image-rotate":
      return { transform: "90c" } satisfies ImageRotateParams;
    case "image-crop":
      return { mode: "center", aspect: "1:1" } satisfies ImageCropParams;
    case "image-watermark":
      return {
        mode: "text",
        text: "MediPress",
        imagePath: undefined,
        position: "br",
        scalePercent: 25,
        opacity: 1,
        marginPercent: 3,
        fontSize: 36,
        color: "white",
      } satisfies ImageWatermarkParams;
    case "image-pdf":
      return {} satisfies ImagePdfParams;
    case "image-adjust":
      return { brightness: 0, contrast: 1, saturation: 1 } satisfies ImageAdjustParams;
    default:
      return null;
  }
}
