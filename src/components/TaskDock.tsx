import { useState } from "react";
import { openOutputFolder } from "../lib/tauri";
import { useI18n } from "../i18n";
import { useTasks } from "../contexts/TaskCenter";
import JobCard from "./JobCard";
import {
  CheckIcon,
  ChevronUpIcon,
  FolderIcon,
  PlayIcon,
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
    <div className="border-t border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      {/* Expanded task area */}
      {expanded && (
        <div className="max-h-[45vh] overflow-y-auto px-4 py-3">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {tasks.stats.queuedCount > 0 && (
              <button
                onClick={() => void tasks.startAll()}
                className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-600 dark:bg-brand-600 dark:hover:bg-brand-700"
              >
                <PlayIcon className="h-3 w-3" />
                {t("app.startAllBtn", { n: tasks.stats.queuedCount })}
              </button>
            )}
            {tasks.stats.failedCount > 0 && (
              <button
                onClick={tasks.retryAllFailed}
                className="rounded-lg border border-error-200 bg-error-50 px-3 py-1.5 text-xs font-medium text-error-600 transition hover:bg-error-100 dark:border-error-800 dark:bg-error-950/30 dark:text-error-400"
              >
                {t("app.retryFailedBtn", { n: tasks.stats.failedCount })}
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={tasks.clearFinished}
                className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
              >
                {t("app.clearFinishedBtn")}
              </button>
              <button
                onClick={tasks.clearAll}
                className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
              >
                {t("app.clearAllBtn")}
              </button>
            </div>
          </div>

          <div className="space-y-2">
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
          <div className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-neutral-50 p-3 ring-1 ring-neutral-200 dark:bg-neutral-800/60 dark:ring-neutral-700 lg:grid-cols-4">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                {t("sidebar.output")}
              </div>
              <button
                onClick={() => void tasks.chooseOutput()}
                className="mt-0.5 flex w-full min-w-0 items-center gap-1 text-left text-xs text-neutral-700 transition hover:text-brand-600 dark:text-neutral-200"
                title={tasks.settings.outputDir ?? t("sidebar.sameDirFull")}
              >
                <FolderIcon className="h-3.5 w-3.5 shrink-0 text-brand-500" />
                <span className="truncate">
                  {tasks.settings.outputDir ?? t("sidebar.sameDir")}
                </span>
              </button>
            </div>
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                {t("sidebar.suffix")}
              </div>
              <input
                value={tasks.settings.outputSuffix}
                onChange={(e) => tasks.setOutputSuffix(e.target.value)}
                placeholder="_mediapress"
                className="mt-0.5 w-full rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
              />
            </div>
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                {t("sidebar.overwritePolicy")}
              </div>
              <select
                value={tasks.settings.overwritePolicy}
                onChange={(e) =>
                  tasks.setOverwritePolicy(e.target.value as "overwrite" | "rename" | "skip")
                }
                className="mt-0.5 w-full rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
              >
                <option value="rename">{t("sidebar.ov.rename")}</option>
                <option value="skip">{t("sidebar.ov.skip")}</option>
                <option value="overwrite">{t("sidebar.ov.overwrite")}</option>
              </select>
            </div>
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                {t("sidebar.parallel")}
              </div>
              <select
                value={tasks.settings.maxConcurrent}
                onChange={(e) => tasks.setMaxConcurrent(Number(e.target.value))}
                className="mt-0.5 w-full rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={4}>4</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Summary bar */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-2 text-left transition hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-600 dark:bg-brand-950 dark:text-brand-300">
          {tasks.allDone ? (
            <CheckIcon className="h-3 w-3" />
          ) : (
            <span className="h-2 w-2 animate-pulse rounded-full bg-brand-500" />
          )}
        </span>
        <span className="shrink-0 text-xs font-medium text-neutral-700 dark:text-neutral-200">
          {t("dock.summary", {
            done: terminal,
            total,
          })}
        </span>
        {running.length > 0 && (
          <span className="shrink-0 text-xs text-brand-600 dark:text-brand-400">
            {t("dock.running", { n: running.length })}
          </span>
        )}
        <div className="mx-2 h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
          <div
            className="h-full rounded-full brand-progress transition-all duration-300"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        <ChevronUpIcon
          className={`h-4 w-4 shrink-0 text-neutral-400 transition-transform ${expanded ? "" : "rotate-180"}`}
        />
      </button>
    </div>
  );
}
