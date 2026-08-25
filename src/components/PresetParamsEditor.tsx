import type {
  AudioParams,
  CropParams,
  ExtractAudioParams,
  GifParams,
  ImageAdjustParams,
  ImageCropParams,
  ImageParams,
  ImageResizeParams,
  ImageWatermarkParams,
  JobParams,
  VideoParams,
  WatermarkParams,
} from "../types";
import {
  AudioCompressOptions,
  ImageCompressOptions,
  VideoCompressOptions,
} from "./OptionsPanel";
import ExtractAudioPanel from "../tools/panels/ExtractAudioPanel";
import ImageCropPanel from "../tools/panels/ImageCropPanel";
import ImageResizePanel from "../tools/panels/ImageResizePanel";
import VideoCropPanel from "../tools/panels/VideoCropPanel";
import GifPanel from "../tools/panels/GifPanel";
import ImageAdjustPanel from "../tools/panels/ImageAdjustPanel";
import ImageWatermarkPanel from "../tools/panels/ImageWatermarkPanel";
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
    case "image-compress":
      return <ImageCompressOptions params={params as ImageParams} onChange={onChange} />;
    case "audio-compress":
      return <AudioCompressOptions params={params as AudioParams} onChange={onChange} />;
    case "extract-audio":
      return <ExtractAudioPanel params={params as ExtractAudioParams} onChange={onChange} />;
    case "image-crop":
      return <ImageCropPanel params={params as ImageCropParams} onChange={onChange} />;
    case "image-resize":
      return <ImageResizePanel params={params as ImageResizeParams} onChange={onChange} />;
    case "video-crop":
      return <VideoCropPanel params={params as CropParams} onChange={onChange} />;
    case "gif":
      return <GifPanel params={params as GifParams} onChange={onChange} />;
    case "image-adjust":
      return <ImageAdjustPanel params={params as ImageAdjustParams} onChange={onChange} />;
    case "image-watermark":
      return <ImageWatermarkPanel params={params as ImageWatermarkParams} onChange={onChange} />;
    case "watermark":
      return <WatermarkPanel params={params as WatermarkParams} onChange={onChange} />;
    default:
      return null;
  }
}
