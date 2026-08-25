import type { JobParams } from "../types";
import OptionsPanel from "../components/OptionsPanel";
import PresetsBar from "../components/PresetsBar";
import { isBatchEditable } from "./kinds";

/** Tool panels that expose a scenario/builtin preset bar on top of their own
 *  params editor (compress/convert tools use OptionsPanel which already renders
 *  PresetsBar). */
const SCENARIO_TOOLS = new Set<string>([
  "image-crop",
  "image-resize",
  "video-crop",
  "gif",
  "image-adjust",
  "image-watermark",
  "watermark",
  "extract-audio",
]);
import GifPanel from "./panels/GifPanel";
import ScreenshotPanel from "./panels/ScreenshotPanel";
import SpeedPanel from "./panels/SpeedPanel";
import WatermarkPanel from "./panels/WatermarkPanel";
import TrimPanel from "./panels/TrimPanel";
import RotatePanel from "./panels/RotatePanel";
import ExtractAudioPanel from "./panels/ExtractAudioPanel";
import type {
  AddAudioParams,
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
  ImageResizeParams,
  ImageRotateParams,
  ImageWatermarkParams,
  PitchParams,
  RotateParams,
  ScreenshotParams,
  SilenceParams,
  SpeedParams,
  SubtitleParams,
  TrimParams,
  VideoSilenceParams,
  VideoVolumeParams,
  WatermarkParams,
} from "../types";
import AudioFadePanel from "./panels/AudioFadePanel";
import AudioPitchPanel from "./panels/AudioPitchPanel";
import AudioSilencePanel from "./panels/AudioSilencePanel";
import AudioTrimPanel from "./panels/AudioTrimPanel";
import AudioVolumePanel from "./panels/AudioVolumePanel";
import ImageAdjustPanel from "./panels/ImageAdjustPanel";
import ImageCropPanel from "./panels/ImageCropPanel";
import ImagePdfPanel from "./panels/ImagePdfPanel";
import ImageResizePanel from "./panels/ImageResizePanel";
import ImageRotatePanel from "./panels/ImageRotatePanel";
import ImageWatermarkPanel from "./panels/ImageWatermarkPanel";
import VideoAddAudioPanel from "./panels/VideoAddAudioPanel";
import VideoCropPanel from "./panels/VideoCropPanel";
import VideoReversePanel from "./panels/VideoReversePanel";
import VideoSubtitlePanel from "./panels/VideoSubtitlePanel";
import VideoVolumePanel from "./panels/VideoVolumePanel";
import VideoFramesPanel from "./panels/VideoFramesPanel";
import VideoContactPanel from "./panels/VideoContactPanel";
import VideoSilencePanel from "./panels/VideoSilencePanel";

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

  const editor = (() => {
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
    /* ── New video tools ── */
    case "video-crop":
      return <VideoCropPanel params={params as CropParams} onChange={(p) => onChange(p)} />;
    case "video-volume":
      return <VideoVolumePanel params={params as VideoVolumeParams} onChange={(p) => onChange(p)} />;
    case "video-reverse":
      return <VideoReversePanel />;
    case "video-subtitle":
      return <VideoSubtitlePanel params={params as SubtitleParams} onChange={(p) => onChange(p)} />;
    case "video-addaudio":
      return <VideoAddAudioPanel params={params as AddAudioParams} onChange={(p) => onChange(p)} />;
    case "video-frames":
      return <VideoFramesPanel params={params as FrameSampleParams} onChange={(p) => onChange(p)} />;
    case "video-contact":
      return <VideoContactPanel params={params as ContactSheetParams} onChange={(p) => onChange(p)} />;
    case "video-silence":
      return <VideoSilencePanel params={params as VideoSilenceParams} onChange={(p) => onChange(p)} />;
    /* ── New audio tools ── */
    case "audio-trim":
      return <AudioTrimPanel params={params as AudioTrimParams} onChange={(p) => onChange(p)} />;
    case "audio-fade":
      return <AudioFadePanel params={params as FadeParams} onChange={(p) => onChange(p)} />;
    case "audio-volume":
      return <AudioVolumePanel params={params as AudioVolumeParams} onChange={(p) => onChange(p)} />;
    case "audio-pitch":
      return <AudioPitchPanel params={params as PitchParams} onChange={(p) => onChange(p)} />;
    case "audio-silence":
      return <AudioSilencePanel params={params as SilenceParams} onChange={(p) => onChange(p)} />;
    /* ── New image tools ── */
    case "image-resize":
      return <ImageResizePanel params={params as ImageResizeParams} onChange={(p) => onChange(p)} />;
    case "image-rotate":
      return <ImageRotatePanel params={params as ImageRotateParams} onChange={(p) => onChange(p)} />;
    case "image-crop":
      return <ImageCropPanel params={params as ImageCropParams} onChange={(p) => onChange(p)} />;
    case "image-watermark":
      return <ImageWatermarkPanel params={params as ImageWatermarkParams} onChange={(p) => onChange(p)} />;
    case "image-pdf":
      return <ImagePdfPanel />;
    case "image-adjust":
      return <ImageAdjustPanel params={params as ImageAdjustParams} onChange={(p) => onChange(p)} />;
    default:
      return null;
    }
  })();

  if (SCENARIO_TOOLS.has(toolId)) {
    return (
      <div className="flex flex-col gap-3">
        <PresetsBar toolId={toolId} params={params} onChange={onChange} />
        {editor}
      </div>
    );
  }

  return editor;
}
