import { useCallback, useEffect, useState } from "react";
import FilterTabs, { type FilterStatus } from "../components/FilterTabs";
import JobList from "../components/JobList";
import SkeletonJobCard from "../components/SkeletonJobCard";
import PresetManager from "../components/PresetManager";
import OutputSettings from "../components/OutputSettings";
import DropZone from "../components/DropZone";
import { useConfirm } from "../components/ConfirmDialog";
import { openOutputFolder } from "../lib/tauri";
import { useI18n } from "../i18n";
import { useTasks } from "../contexts/TaskCenter";
import { extOk } from "./FilePicker";
import { getTool, type WorkbenchId } from "./registry";

type QueuableToolId = Exclude<WorkbenchId, "inspect" | "workflow">;

interface TaskWorkbenchProps {
  toolId: QueuableToolId;
  onBack?: () => void;
}

/** Unified task-center workbench used by every queued tool. Adds files to the
 *  shared queue, then shows an editable job list with batch actions. */
export default function TaskWorkbench({ toolId, onBack }: TaskWorkbenchProps) {
  const { t } = useI18n();
  const tasks = useTasks();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [filter, setFilter] = useState<FilterStatus>("all");
  const [presetManagerOpen, setPresetManagerOpen] = useState(false);

  const meta = getTool(toolId)!;
  const accepts = meta.accepts;
  const multiFile = meta.multiFile;
  // Toolbar chrome: GPU only used by the video-compress tool; presets only by
  // the compress tools.
  const showGpu = toolId === "video-compress";
  const showPresets = toolId.endsWith("-compress");

  const displayMediaType = meta.mediaType ?? 
    (meta.category === "audio" ? "audio" : meta.category === "image" ? "image" : undefined);

  useEffect(() => {
    tasks.registerDropHandler((paths) => {
      const valid = paths.filter((p) => extOk(p, accepts));
      if (valid.length === 0) return;
      const toAdd = multiFile ? valid : valid.slice(0, 1);
      tasks.addCompressFiles(toAdd, toolId, multiFile);
    });
    return () => tasks.registerDropHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolId]);

  const jobs = tasks.jobs.filter((j) => j.toolId === toolId);
  const hasJobs = jobs.length > 0;

  const filteredJobs =
    filter === "all" ? jobs : jobs.filter((j) => j.phase === filter);

  const handleStartAll = useCallback(async () => {
    const queued = jobs.filter((j) => j.phase === "queued").length;
    if (queued === 0) return;
    const ok = await confirm({
      title: t("app.startAll.title"),
      message: t("app.startAll.msg", { n: queued }),
      confirmLabel: t("app.startAll.confirm"),
      cancelLabel: t("confirm.cancel"),
    });
    if (ok) tasks.startAll(toolId);
  }, [jobs, tasks, confirm, t, toolId]);

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
    const failed = jobs.filter((j) => j.phase === "error").length;
    if (failed === 0) return;
    const ok = await confirm({
      title: t("app.retryFailed.title"),
      message: t("app.retryFailed.msg", { n: failed }),
      confirmLabel: t("app.retryFailed.confirm"),
      cancelLabel: t("confirm.cancel"),
    });
    if (ok) tasks.retryAllFailed();
  }, [jobs, tasks, confirm, t]);

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

  const supportHint = displayMediaType
    ? t(`dz.support.${displayMediaType}`, { exts: accepts.map((e) => `.${e}`).join(", ") })
    : t("dz.support");

  const filterName = displayMediaType ? t(`dz.filter.${displayMediaType}`) : t("dz.support");

  return (
    <div>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">
            {t(`tool.${toolId}.name`)}
          </h2>
          <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
            {t(`tool.${toolId}.desc`)}
          </p>
        </div>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            <span className="h-3 w-3" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </span>
            {t("module.back")}
          </button>
        )}
      </div>

      {/* Toolbar: GPU + output settings + presets */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {showGpu && (
          <>
            <select
              value={tasks.settings.gpu}
              onChange={(e) => tasks.setGpu(e.target.value)}
              disabled={!tasks.gpuInfo.available}
              className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-700 transition focus:border-brand-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-50"
              title={t("sidebar.gpu")}
            >
              <option value="">{t("gpu.cpu")}</option>
              {tasks.gpuInfo.backends.map((b) => (
                <option key={b.id} value={b.id}>
                  {t(`gpu.${b.id}`)}
                </option>
              ))}
            </select>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                tasks.gpuInfo.available
                  ? "bg-success-50 text-success-700 dark:bg-success-950/30 dark:text-success-400"
                  : "bg-neutral-100 text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500"
              }`}
            >
              {tasks.gpuInfo.available
                ? t("sidebar.gpuAvailable", { n: tasks.gpuInfo.backends.length })
                : t("sidebar.gpuNone")}
            </span>
          </>
        )}
        <OutputSettings compact />
        {showPresets && (
          <button
            onClick={() => setPresetManagerOpen(true)}
            className="ml-auto rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            {t("sidebar.presets")}
          </button>
        )}
      </div>

      {tasks.error && (
        <div
          className="mb-4 rounded-xl border border-error-100 bg-error-50 px-4 py-2.5 text-sm text-error-700 dark:border-error-900/50 dark:bg-error-950/30 dark:text-error-400"
          role="alert"
        >
          {tasks.error}
        </div>
      )}

      {tasks.loading && jobs.length === 0 ? (
        <div aria-label={t("a11y.loading")} className="space-y-4">
          <SkeletonJobCard mediaType={meta.mediaType ?? "video"} />
        </div>
      ) : !hasJobs ? (
        <DropZone
          dragOver={false}
          supportHint={supportHint}
          onClick={() => tasks.pickFiles([{ name: filterName, extensions: accepts }])}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => {}}
          onDrop={(e) => e.preventDefault()}
        />
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-3">
            <FilterTabs
              jobs={jobs}
              active={filter}
              onChange={setFilter}
            />

            <div className="flex items-center justify-between">
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
          </div>

          <JobList
            jobs={filteredJobs}
            onJobStart={tasks.startOne}
            onJobCancel={tasks.cancelOne}
            onJobRemove={tasks.removeOne}
            onJobOpenFolder={openOutputFolder}
            onJobChangeParams={tasks.changeParams}
            onJobSyncParams={tasks.syncParamsToAll}
            onJobRetry={tasks.retryOne}
            onReorderStart={tasks.reorderStart}
            onReorderOver={tasks.reorderOver}
            onReorderDrop={tasks.reorderDrop}
          />
        </>
      )}

      {confirmDialog}
      {showPresets && (
        <PresetManager open={presetManagerOpen} onClose={() => setPresetManagerOpen(false)} />
      )}
    </div>
  );
}
