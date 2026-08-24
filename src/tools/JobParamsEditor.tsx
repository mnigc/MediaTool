import type { JobParams } from "../types";
import OptionsPanel from "../components/OptionsPanel";
import { isBatchEditable } from "./kinds";
import GifPanel from "./panels/GifPanel";
import ScreenshotPanel from "./panels/ScreenshotPanel";
import SpeedPanel from "./panels/SpeedPanel";
import WatermarkPanel from "./panels/WatermarkPanel";
import TrimPanel from "./panels/TrimPanel";
import RotatePanel from "./panels/RotatePanel";
import ExtractAudioPanel from "./panels/ExtractAudioPanel";
import type {
  ExtractAudioParams,
  GifParams,
  RotateParams,
  ScreenshotParams,
  SpeedParams,
  TrimParams,
  WatermarkParams,
} from "../types";

/** Single editor that dispatches to the right params panel for any tool.
 *  Compress/convert tools use OptionsPanel; toolbox tools use their own
 *  panel. Tools with no params render nothing. */
export default function JobParamsEditor({
  toolId,
  params,
  onChange,
}: {
  toolId: string;
  params: JobParams;
  onChange: (p: JobParams) => void;
}) {
  if (isBatchEditable(toolId)) {
    return <OptionsPanel toolId={toolId} params={params} onChange={onChange} />;
  }

  switch (toolId) {
    case "gif":
      return <GifPanel params={params as GifParams} onChange={(p) => onChange(p)} />;
    case "screenshot":
      return <ScreenshotPanel params={params as ScreenshotParams} onChange={(p) => onChange(p)} />;
    case "speed":
      return <SpeedPanel params={params as SpeedParams} onChange={(p) => onChange(p)} />;
    case "watermark":
      return <WatermarkPanel params={params as WatermarkParams} onChange={(p) => onChange(p)} />;
    case "trim":
      return <TrimPanel params={params as TrimParams} onChange={(p) => onChange(p)} />;
    case "rotate":
      return <RotatePanel params={params as RotateParams} onChange={(p) => onChange(p)} />;
    case "extract-audio":
      return <ExtractAudioPanel params={params as ExtractAudioParams} onChange={(p) => onChange(p)} />;
    default:
      return null;
  }
}
