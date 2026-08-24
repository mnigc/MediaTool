import { useI18n } from "../i18n";
import { toolsByCategory, type ToolCategory, type WorkbenchId } from "../tools/registry";
import {
  FilmIcon,
  ImageIcon,
  MusicIcon,
  SettingsIcon,
  SlidersIcon,
  GifIcon,
  CameraIcon,
  SpeedIcon,
  WatermarkIcon,
  SearchIcon,
} from "./icons";

const CATEGORY_KEY: Record<ToolCategory, string> = {
  video: "nav.category.video",
  audio: "nav.category.audio",
  image: "nav.category.image",
  general: "nav.category.general",
};

const CATEGORY_ICONS: Record<ToolCategory, React.ComponentType<{ className?: string }>> = {
  video: FilmIcon,
  audio: MusicIcon,
  image: ImageIcon,
  general: SettingsIcon,
};

const TOOL_ICONS: Record<WorkbenchId, React.ComponentType<{ className?: string }>> = {
  "video-compress": SlidersIcon,
  "audio-compress": SlidersIcon,
  "image-compress": SlidersIcon,
  gif: GifIcon,
  screenshot: CameraIcon,
  speed: SpeedIcon,
  watermark: WatermarkIcon,
  inspect: SearchIcon,
};

interface Props {
  active: WorkbenchId;
  onChange: (id: WorkbenchId) => void;
}

export default function ToolNav({ active, onChange }: Props) {
  const { t } = useI18n();
  const groups = toolsByCategory();

  return (
    <nav
      data-od-id="tool-nav"
      className="flex w-52 shrink-0 flex-col overflow-y-auto bg-neutral-50/50 dark:bg-neutral-950/50 border-r border-neutral-200/60 dark:border-neutral-800/60 px-2 py-3 scrollbar-thin glass"
    >
      {groups.map((g, idx) => {
        const CategoryIcon = CATEGORY_ICONS[g.category];
        return (
          <div
            key={g.category}
            className={idx > 0 ? "mt-3 border-t border-neutral-200/60 pt-3 dark:border-neutral-800/60" : ""}
          >
            <div className="flex items-center gap-2 mb-2 px-2">
              <CategoryIcon className="h-4 w-4 text-neutral-400 dark:text-neutral-500" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                {t(CATEGORY_KEY[g.category])}
              </span>
            </div>
            <div className="space-y-1">
              {g.tools.map((tool) => {
                const isActive = active === tool.id;
                const ToolIcon = TOOL_ICONS[tool.id];
                return (
                  <button
                    key={tool.id}
                    onClick={() => onChange(tool.id)}
                    className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-all duration-200 ${
                      isActive
                        ? "bg-white text-brand-600 shadow-card dark:bg-neutral-800 dark:text-brand-400"
                        : "text-neutral-600 hover:bg-neutral-100/80 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/50 dark:hover:text-neutral-100"
                    }`}
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                      <ToolIcon className={`h-4.5 w-4.5 transition-colors ${isActive ? "text-current" : "text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-300"}`} />
                    </span>
                    <span className="truncate">{t(`tool.${tool.id}.name`)}</span>
                    {isActive && (
                      <span className="ml-auto flex h-1.5 w-1.5 rounded-full bg-brand-500 shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}