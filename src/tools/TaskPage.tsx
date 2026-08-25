import { useCallback } from "react";
import JobCard from "../components/JobCard";
import EmptyState from "../components/EmptyState";
import { useConfirm } from "../components/ConfirmDialog";
import { openOutputFolder } from "../lib/tauri";
import { useI18n } from "../i18n";
import { useTasks } from "../contexts/TaskCenter";

/** Task-center page: a compact overview of every queued job. Parameters are
 *  configured in each module, so the per-job editor lives there, not here. */
export default function TaskPage() {
  const { t } = useI18n();
  const tasks = useTasks();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const jobs = tasks.jobs;

  const handleStartAll = useCallback(async () => {
    if (tasks.stats.queuedCount === 0) return;
    const ok = await confirm({
      title: t("app.startAll.title"),
      message: t("app.startAll.msg", { n: tasks.stats.queuedCount }),
      confirmLabel: t("app.startAll.confirm"),
      cancelLabel: t("confirm.cancel"),
    });
    if (ok) tasks.startAll();
  }, [tasks, confirm, t]);

  const handleClearFinished = useCallback(async () => {
    const removable = jobs.filter(
      (j) =>
        j.phase === "done" ||
        j.phase === "error" ||
        j.phase === "cancelled" ||
        j.phase === "skipped"
    ).length;
    if (removable === 0) return;
    const ok = await confirm({
      title: t("app.clearFinished.title"),
      message: t("app.clearFinished.msg", { n: removable }),
      confirmLabel: t("app.clearFinished.confirm"),
      cancelLabel: t("confirm.cancel"),
      danger: true,
    });
    if (ok) tasks.clearFinished();
  }, [jobs, tasks, confirm, t]);

  const handleRetryAllFailed = useCallback(async () => {
    const failed = tasks.stats.failedCount;
    if (failed === 0) return;
    const ok = await confirm({
      title: t("app.retryFailed.title"),
      message: t("app.retryFailed.msg", { n: failed }),
      confirmLabel: t("app.retryFailed.confirm"),
      cancelLabel: t("confirm.cancel"),
    });
    if (ok) tasks.retryAllFailed();
  }, [tasks, confirm, t]);

  const handleClearAll = useCallback(async () => {
    if (jobs.length === 0) return;
    const ok = await confirm({
      title: t("app.clearAll.title"),
      message: t("app.clearAll.msg", { n: jobs.length }),
      confirmLabel: t("app.clearAll.confirm"),
      cancelLabel: t("confirm.cancel"),
      danger: true,
    });
    if (ok) tasks.clearAll();
  }, [jobs, tasks, confirm, t]);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-neutral-800 dark:text-neutral-100">
          {t("module.tasks.title")}
        </h2>
        <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
          {t("module.tasks.desc")}
        </p>
      </div>

      {jobs.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
              <span className="font-semibold text-neutral-800 dark:text-neutral-200">
                {t("app.jobsCount", { n: jobs.length })}
              </span>
              {tasks.stats.doneCount > 0 && (
                <span className="rounded-full bg-success-50 px-2.5 py-0.5 text-xs font-medium text-success-600 dark:bg-success-950/30 dark:text-success-400">
                  {tasks.stats.doneCount} {t("app.doneBadge")}
                </span>
              )}
              {tasks.stats.runningCount > 0 && (
                <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-600 dark:bg-brand-950/30 dark:text-brand-400">
                  {tasks.stats.runningCount} {t("app.runningBadge")}
                </span>
              )}
              {tasks.stats.failedCount > 0 && (
                <span className="rounded-full bg-error-50 px-2.5 py-0.5 text-xs font-medium text-error-600 dark:bg-error-950/30 dark:text-error-400">
                  {tasks.stats.failedCount} {t("app.failedBadge")}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {tasks.stats.queuedCount > 0 && (
                <button
                  onClick={handleStartAll}
                  className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 dark:bg-brand-600 dark:hover:bg-brand-700"
                >
                  {t("app.startAllBtn", { n: tasks.stats.queuedCount })}
                </button>
              )}
              {jobs.some(
                (j) =>
                  j.phase === "done" ||
                  j.phase === "error" ||
                  j.phase === "cancelled" ||
                  j.phase === "skipped"
              ) && (
                <button
                  onClick={handleClearFinished}
                  className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                  title={t("app.clearFinished.title")}
                >
                  {t("app.clearFinishedBtn")}
                </button>
              )}
              <button
                onClick={handleClearAll}
                className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                title={t("app.clearAll.title")}
              >
                {t("app.clearAllBtn")}
              </button>
              {tasks.stats.failedCount > 0 && (
                <button
                  onClick={handleRetryAllFailed}
                  className="rounded-lg border border-error-200 bg-error-50 px-3 py-1.5 text-xs font-medium text-error-600 transition hover:bg-error-100 dark:border-error-800 dark:bg-error-950/30 dark:text-error-400 dark:hover:bg-error-900/50"
                  title={t("app.retryFailed.title")}
                >
                  {t("app.retryFailedBtn", { n: tasks.stats.failedCount })}
                </button>
              )}
            </div>
          </div>

          <div className="space-y-3" role="list" aria-label={t("a11y.taskList")}>
            {jobs.map((job, i) => (
              <JobCard
                key={job.uiId}
                job={job}
                startIndex={i}
                onStart={tasks.startOne}
                onCancel={tasks.cancelOne}
                onRemove={tasks.removeOne}
                onOpenFolder={openOutputFolder}
                onRetry={tasks.retryOne}
              />
            ))}
          </div>
        </>
      )}

      {confirmDialog}
    </div>
  );
}
