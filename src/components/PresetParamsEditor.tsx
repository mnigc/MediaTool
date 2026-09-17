import type {
  AudioParams,
  ExtractAudioParams,
  JobParams,
  VideoParams,
  WatermarkParams,
} from "../types";
import {
  AudioCompressOptions,
  VideoCompressOptions,
} from "./OptionsPanel";
import ExtractAudioPanel from "../tools/panels/ExtractAudioPanel";
import WatermarkPanel from "../tools/panels/WatermarkPanel";

/** Renders the correct param editor for a preset by its tool id. Used by the
 *  preset manager so builtin/default params can be modified in place. */
export default function PresetParamsEditor({
  toolId,
  params,
  onChange,
}: {
  toolId: string;
  params: JobParams;
  onChange: (p: JobParams) => void;
}) {
  switch (toolId) {
    case "video-compress":
      return <VideoCompressOptions params={params as VideoParams} onChange={onChange} />;
    case "audio-compress":
      return <AudioCompressOptions params={params as AudioParams} onChange={onChange} />;
    case "extract-audio":
      return <ExtractAudioPanel params={params as ExtractAudioParams} onChange={onChange} />;
    case "watermark":
      return <WatermarkPanel params={params as WatermarkParams} onChange={onChange} />;
    default:
      return null;
  }
}
