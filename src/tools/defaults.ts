import type {
  ExtractAudioParams,
  GifParams,
  MuteParams,
  RotateParams,
  ScreenshotParams,
  SpeedParams,
  StripMetadataParams,
  ToolParams,
  TrimParams,
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
    default:
      return null;
  }
}
