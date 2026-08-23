import { useI18n } from "../i18n";
import { toolsByCategory, type ToolCategory, type WorkbenchId } from "../tools/registry";

const CATEGORY_KEY: Record<ToolCategory, string> = {
  common: "nav.category.common",
  video: "nav.category.video",
  audio: "nav.category.audio",
  image: "nav.category.image",
  general: "nav.category.general",
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
      className="flex w-44 shrink-0 flex-col overflow-y-auto bg-neutral-50 dark:bg-neutral-900 border-r border-neutral-200 dark:border-neutral-800 px-2 py-3 scrollbar-thin"
    >
      {groups.map((g) => (
        <div key={g.category} className="mb-3">
          <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
            {t(CATEGORY_KEY[g.category])}
          </div>
          <div className="space-y-0.5">
            {g.tools.map((tool) => {
              const isActive = active === tool.id;
              return (
                <button
                  key={tool.id}
                  onClick={() => onChange(tool.id)}
                  className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition ${
                    isActive
                      ? "bg-brand-500 text-white shadow-sm dark:bg-brand-600"
                      : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  }`}
                >
                  <span className="truncate">{t(`tool.${tool.id}.name`)}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
