import type { ComponentType } from "react";
import { useI18n } from "../i18n";
import {
  cardsOfModule,
  type ModuleId,
  type ToolMeta,
  type WorkbenchId,
} from "./registry";
import {
  AdjustIcon,
  CameraIcon,
  ConvertIcon,
  CropIcon,
  ExtractAudioIcon,
  FadeIcon,
  GifIcon,
  MergeIcon,
  MuteIcon,
  PdfIcon,
  PitchIcon,
  ResizeIcon,
  ReverseIcon,
  RotateIcon,
  ScissorsIcon,
  SearchIcon,
  SilenceIcon,
  SlidersIcon,
  SpeedIcon,
  StripMetadataIcon,
  SubtitleIcon,
  AddAudioIcon,
  VolumeIcon,
  WatermarkIcon,
  WorkflowIcon,
  FrameStripIcon,
  GridIcon,
  WaveDetectIcon,
} from "../components/icons";

const TOOL_ICONS: Record<WorkbenchId, ComponentType<{ className?: string }>> = {
  "video-compress": SlidersIcon,
  "video-convert": ConvertIcon,
  trim: ScissorsIcon,
  mute: MuteIcon,
  rotate: RotateIcon,
  gif: GifIcon,
  screenshot: CameraIcon,
  speed: SpeedIcon,
  watermark: WatermarkIcon,
  "video-crop": CropIcon,
  "video-volume": VolumeIcon,
  "video-reverse": ReverseIcon,
  "video-subtitle": SubtitleIcon,
  "video-addaudio": AddAudioIcon,
  "video-merge": MergeIcon,
  "video-frames": FrameStripIcon,
  "video-contact": GridIcon,
  "video-silence": WaveDetectIcon,
  "audio-compress": SlidersIcon,
  "audio-convert": ConvertIcon,
  "extract-audio": ExtractAudioIcon,
  "audio-trim": ScissorsIcon,
  "audio-fade": FadeIcon,
  "audio-volume": VolumeIcon,
  "audio-pitch": PitchIcon,
  "audio-silence": SilenceIcon,
  "audio-merge": MergeIcon,
  "image-compress": SlidersIcon,
  "image-convert": ConvertIcon,
  "image-resize": ResizeIcon,
  "image-rotate": RotateIcon,
  "image-crop": CropIcon,
  "image-watermark": WatermarkIcon,
  "image-pdf": PdfIcon,
  "image-adjust": AdjustIcon,
  "strip-metadata": StripMetadataIcon,
  inspect: SearchIcon,
  workflow: WorkflowIcon,
};

const MODULE_TITLE: Record<ModuleId, string> = {
  video: "module.video.title",
  audio: "module.audio.title",
  image: "module.image.title",
  tools: "module.tools.title",
  tasks: "module.tasks.title",
  presets: "module.presets.title",
  workflow: "module.workflow.title",
};

const MODULE_DESC: Record<ModuleId, string> = {
  video: "module.video.desc",
  audio: "module.audio.desc",
  image: "module.image.desc",
  tools: "module.tools.desc",
  tasks: "module.tasks.desc",
  presets: "module.presets.desc",
  workflow: "module.workflow.desc",
};

function ToolCard({ tool, onOpen }: { tool: ToolMeta; onOpen: (id: WorkbenchId) => void }) {
  const { t } = useI18n();
  const Icon = TOOL_ICONS[tool.id];
  return (
    <button
      type="button"
      onClick={() => onOpen(tool.id)}
      className="group flex items-center gap-3 rounded-2xl bg-white p-4 text-left shadow-card ring-1 ring-neutral-200 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card-hover hover:ring-brand-200 dark:bg-neutral-900 dark:ring-neutral-800 dark:hover:ring-brand-800"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 transition-colors group-hover:bg-brand-100 dark:bg-brand-950/40 dark:text-brand-400 dark:group-hover:bg-brand-900/50">
        {Icon ? <Icon className="h-5 w-5" /> : <SearchIcon className="h-5 w-5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {t(`tool.${tool.id}.name`)}
        </span>
        <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
          {t(`tool.${tool.id}.desc`)}
        </span>
      </span>
    </button>
  );
}

export default function ModulePage({
  module,
  onOpenTool,
}: {
  module: ModuleId;
  onOpenTool: (id: WorkbenchId) => void;
}) {
  const { t } = useI18n();
  const cards = cardsOfModule(module);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-neutral-800 dark:text-neutral-100">
          {t(MODULE_TITLE[module])}
        </h2>
        <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
          {t(MODULE_DESC[module])}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-3">
        {cards.map((tool) => (
          <ToolCard key={tool.id} tool={tool} onOpen={onOpenTool} />
        ))}
      </div>
    </div>
  );
}
