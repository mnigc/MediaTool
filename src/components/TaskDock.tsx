import { useState } from "react";
import { openOutputFolder } from "../lib/tauri";
import { useI18n } from "../i18n";
import { useTasks } from "../contexts/TaskCenter";
import JobCard from "./JobCard";
import OutputSettings from "./OutputSettings";
import {
  CheckIcon,
  ChevronUpIcon,
  PlayIcon,
  RotateCcwIcon,
} from "./icons";

export default function TaskDock() {
  const { t } = useI18n();
  const tasks = useTasks();
  const [expanded, setExpanded] = useState(false);

  const jobs = tasks.jobs;
  const total = jobs.length;
  const terminal = jobs.filter(
    (j) => j.phase === "done" || j.phase === "error" || j.phase === "cancelled" || j.phase === "skipped"
  ).length;
  const running = jobs.filter((j) => j.phase === "running");
  const avgRunning =
    running.length > 0
      ? running.reduce((a, j) => a + j.percent, 0) / running.length / 100
      : 0;
  const progress = total > 0 ? (terminal + avgRunning * running.length) / total : 0;

  if (total === 0) return null;

  return (
    <>
      {/* Full-screen backdrop overlay when expanded */}
      {expanded && (
        <div
          className="fixed inset-0 z-30 bg-black/30 backdrop-blur-sm fade-in"
          onClick={() => setExpanded(false)}
        />
      )}

      <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-40 w-full max-w-5xl px-4 animate-slide-up">
        {/* Summary bar - always visible */}
        <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="relative z-40 w-full flex items-center gap-2.5 rounded-xl bg-white/80 dark:bg-neutral-950/80 backdrop-blur-md shadow-dock border border-neutral-200/50 dark:border-neutral-800/50 px-3 py-2 transition-all duration-200 hover:shadow-xl"
        aria-expanded={expanded}
        aria-controls="task-dock-expanded"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-950/40 dark:text-brand-400">
          {tasks.allDone ? (
            <CheckIcon className="h-4 w-4" />
          ) : running.length > 0 ? (
            <span className="h-2 w-2 animate-pulse rounded-full bg-brand-500" />
          ) : (
            <PlayIcon className="h-4 w-4" />
          )}
        </span>
        <span className="shrink-0 text-xs font-medium text-neutral-900 dark:text-neutral-100">
          {t("dock.summary", {
            done: terminal,
            total,
          })}
        </span>
        {running.length > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-600 dark:bg-brand-950/40 dark:text-brand-400">
            <span className="h-1 w-1 rounded-full bg-brand-500 animate-pulse" />
            {t("dock.running", { n: running.length })}
          </span>
        )}
        <div className="mx-1.5 h-1 min-w-12 flex-1 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
          <div
            className="h-full rounded-full brand-progress transition-all duration-500 ease-out"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        <ChevronUpIcon
          className={`h-4 w-4 shrink-0 text-neutral-400 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {/* Expanded task area */}
      {expanded && (
        <div
          id="task-dock-expanded"
          className="relative z-40 mt-2 rounded-2xl bg-white/80 dark:bg-neutral-950/80 backdrop-blur-md shadow-dock border border-neutral-200/50 dark:border-neutral-800/50 overflow-hidden animate-slide-up"
        >
          <div className="border-b border-neutral-200/50 dark:border-neutral-800/50 px-3 py-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {tasks.stats.queuedCount > 0 && (
                <button
                  onClick={() => void tasks.startAll()}
                  className="flex items-center gap-1.5 rounded-xl bg-brand-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-brand-600 dark:bg-brand-600 dark:hover:bg-brand-700"
                >
                  <PlayIcon className="h-3.5 w-3.5" />
                  {t("app.startAllBtn", { n: tasks.stats.queuedCount })}
                </button>
              )}
              {tasks.stats.failedCount > 0 && (
                <button
                  onClick={tasks.retryAllFailed}
                  className="flex items-center gap-1.5 rounded-xl border border-error-200 bg-error-50 px-3 py-1.5 text-xs font-medium text-error-600 transition hover:bg-error-100 dark:border-error-800 dark:bg-error-950/30 dark:text-error-400"
                >
                  <RotateCcwIcon className="h-3.5 w-3.5" />
                  {t("app.retryFailedBtn", { n: tasks.stats.failedCount })}
                </button>
              )}
              <div className="flex-1" />
              <div className="flex items-center gap-1.5">
                <button
                  onClick={tasks.clearFinished}
                  className="rounded-xl border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                  title={t("app.clearFinished.title")}
                >
                  {t("app.clearFinishedBtn")}
                </button>
                <button
                  onClick={tasks.clearAll}
                  className="rounded-xl border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                  title={t("app.clearAll.title")}
                >
                  {t("app.clearAllBtn")}
                </button>
              </div>
            </div>
          </div>

          <div className="max-h-[40vh] overflow-y-auto px-3 py-2">
            <div className="space-y-1.5">
              {jobs.map((job, i) => (
                <JobCard
                  key={job.uiId}
                  job={job}
                  startIndex={i}
                  onStart={(id) => void tasks.startOne(id)}
                  onCancel={tasks.cancelOne}
                  onRemove={tasks.removeOne}
                  onOpenFolder={openOutputFolder}
                  onRetry={tasks.retryOne}
                />
              ))}
            </div>

            {/* Global output settings */}
            <div className="mt-3">
              <OutputSettings />
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}