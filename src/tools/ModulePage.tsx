import type { ComponentType } from "react";
import { useI18n } from "../i18n";
import { useTasks } from "../contexts/TaskCenter";
import {
  cardsOfModule,
  type ModuleId,
  type ToolMeta,
  type WorkbenchId,
} from "./registry";
import {
  CameraIcon,
  ExtractAudioIcon,
  MergeIcon,
  MuteIcon,
  ScissorsIcon,
  SearchIcon,
  SlidersIcon,
  SpeedIcon,
  SubtitleIcon,
  VolumeIcon,
  WatermarkIcon,
  FrameStripIcon,
  GridIcon,
  WaveDetectIcon,
} from "../components/icons";

const TOOL_ICONS: Record<WorkbenchId, ComponentType<{ className?: string }>> = {
  "video-compress": SlidersIcon,
  trim: ScissorsIcon,
  mute: MuteIcon,
  screenshot: CameraIcon,
  speed: SpeedIcon,
  watermark: WatermarkIcon,
  "video-subtitle": SubtitleIcon,
  "video-merge": MergeIcon,
  "video-frames": FrameStripIcon,
  "video-contact": GridIcon,
  "video-silence": WaveDetectIcon,
  "audio-compress": SlidersIcon,
  "extract-audio": ExtractAudioIcon,
  "audio-volume": VolumeIcon,
  "audio-merge": MergeIcon,
  inspect: SearchIcon,
};

const MODULE_TITLE: Record<ModuleId, string> = {
  download: "nav.module.download",
  record: "nav.module.record",
  video: "module.video.title",
  audio: "module.audio.title",
  tasks: "module.tasks.title",
  presets: "module.presets.title",
  workflow: "module.workflow.title",
  settings: "settings.title",
  about: "module.about.title",
};

function ToolCard({ tool, onOpen, pending }: { tool: ToolMeta; onOpen: (id: WorkbenchId) => void; pending: number }) {
  const { t } = useI18n();
  const Icon = TOOL_ICONS[tool.id];
  return (
    <button
      type="button"
      onClick={() => onOpen(tool.id)}
      className="group relative flex items-center gap-3 rounded-2xl bg-white p-4 text-left shadow-card ring-1 ring-neutral-200 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card-hover hover:ring-brand-200 dark:bg-neutral-900 dark:ring-neutral-800 dark:hover:ring-brand-800"
    >
      {pending > 0 && (
        <span className="absolute right-3 top-3 z-10 flex min-w-[20px] items-center justify-center rounded-full bg-brand-500 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white shadow-sm dark:bg-brand-600">
          {pending}
        </span>
      )}
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
  const tasks = useTasks();
  const cards = cardsOfModule(module);

  const pendingByTool = cards.reduce<Record<string, number>>((acc, tool) => {
    acc[tool.id] = tasks.jobs.filter(
      (j) => j.toolId === tool.id && (j.phase === "queued" || j.phase === "running")
    ).length;
    return acc;
  }, {});

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">
          {t(MODULE_TITLE[module])}
        </h2>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-3">
        {cards.map((tool) => (
          <ToolCard key={tool.id} tool={tool} onOpen={onOpenTool} pending={pendingByTool[tool.id] ?? 0} />
        ))}
      </div>
    </div>
  );
}
