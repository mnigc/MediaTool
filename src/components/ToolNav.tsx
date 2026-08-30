import type { ComponentType } from "react";
import { useI18n } from "../i18n";
import { useTasks } from "../contexts/TaskCenter";
import { MODULES, toolToModule, type ModuleId, type Route } from "../tools/registry";
import {
  ChartIcon,
  FilmIcon,
  ImageIcon,
  InfoIcon,
  MusicIcon,
  SettingsIcon,
  SlidersIcon,
  WorkflowIcon,
} from "./icons";

const MODULE_ICONS: Record<ModuleId, ComponentType<{ className?: string }>> = {
  video: FilmIcon,
  audio: MusicIcon,
  image: ImageIcon,
  workflow: WorkflowIcon,
  tools: SettingsIcon,
  tasks: ChartIcon,
  presets: SlidersIcon,
  about: InfoIcon,
};

const MODULE_LABEL: Record<ModuleId, string> = {
  video: "nav.module.video",
  audio: "nav.module.audio",
  image: "nav.module.image",
  workflow: "nav.module.workflow",
  tools: "nav.module.tools",
  tasks: "nav.module.tasks",
  presets: "nav.module.presets",
  about: "nav.module.about",
};

interface Props {
  route: Route;
  onNavigate: (route: Route) => void;
}

export default function ToolNav({ route, onNavigate }: Props) {
  const { t } = useI18n();
  const tasks = useTasks();
  const activeModule = route.kind === "module" ? route.id : toolToModule(route.tool);

  // Aggregate task progress shown as a slim bar + count badge on the 任务 item.
  const taskJobs = tasks.jobs;
  const taskTotal = taskJobs.length;
  const taskTerminal = taskJobs.filter(
    (j) =>
      j.phase === "done" ||
      j.phase === "error" ||
      j.phase === "cancelled" ||
      j.phase === "skipped"
  ).length;
  const taskRunning = taskJobs.filter((j) => j.phase === "running");
  const taskRunningPct = taskRunning.reduce((a, j) => a + j.percent, 0) / 100;
  const taskProgress =
    taskTotal > 0 ? (taskTerminal + taskRunningPct) / taskTotal : 0;

  return (
    <nav
      data-od-id="tool-nav"
      className="flex w-52 shrink-0 flex-col overflow-y-auto bg-neutral-50/50 dark:bg-neutral-950/50 border-r border-neutral-200/60 dark:border-neutral-800/60 px-2 py-3 scrollbar-thin glass"
    >
      <div className="space-y-1">
        {MODULES.map((id) => {
          const isActive = activeModule === id;
          const Icon = MODULE_ICONS[id];
          return (
            <button
              key={id}
              onClick={() => onNavigate({ kind: "module", id })}
              className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-all duration-200 ${
                isActive
                  ? "bg-brand-100/70 text-brand-700 dark:bg-brand-900/70 dark:text-brand-200"
                  : "text-neutral-600 hover:bg-neutral-100/80 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/50 dark:hover:text-neutral-100"
              }`}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                <Icon
                  className={`h-4.5 w-4.5 transition-colors ${
                    isActive
                      ? "text-current"
                      : "text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-300"
                  }`}
                />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{t(MODULE_LABEL[id])}</span>
                {id === "tasks" && taskTotal > 0 && (
                  <span className="mt-1 flex items-center gap-1.5">
                    <span className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-neutral-200/80 dark:bg-neutral-700/60">
                      <span
                        className={`block h-full rounded-full transition-all duration-300 ${
                          taskProgress >= 1 ? "bg-success-500" : "bg-brand-500"
                        }`}
                        style={{ width: `${Math.round(taskProgress * 100)}%` }}
                      />
                    </span>
                    <span className="text-[9px] leading-none text-neutral-400 dark:text-neutral-500">
                      {taskTerminal}/{taskTotal}
                    </span>
                  </span>
                )}
              </span>
              {isActive && (
                <span className="ml-auto flex h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
