import { useCallback, useState } from "react";
import { openOutputFolder } from "./lib/tauri";
import Header from "./components/Header";
import Sidebar from "./components/Sidebar";
import DropZone from "./components/DropZone";
import FilterTabs, { type FilterStatus } from "./components/FilterTabs";
import JobList from "./components/JobList";
import SkeletonJobCard from "./components/SkeletonJobCard";
import ToastContainer from "./components/ToastContainer";
import PresetManager from "./components/PresetManager";
import { useConfirm } from "./components/ConfirmDialog";
import { useTheme } from "./hooks/useTheme";
import { useToasts } from "./hooks/useToasts";
import { useJobs } from "./hooks/useJobs";
import { useI18n } from "./i18n";

export default function App() {
  const { themeMode, setThemeMode } = useTheme();
  const { t } = useI18n();
  const { toasts, pushToast, dismissAll } = useToasts();
  const {
    jobs,
    loading,
    error,
    settings,
    gpuInfo,
    stats,
    allDone,
    overall,
    totalIn,
    totalOut,
    pickFiles,
    chooseOutput,
    setOutputDir,
    setOutputSuffix,
    setMaxConcurrent,
    setGpu,
    startAll,
    clearFinished,
    clearAll,
    startOne,
    cancelOne,
    removeOne,
    retryOne,
    retryAllFailed,
    changeParams,
    syncParamsToAll,
    reorderStart,
    reorderOver,
    reorderDrop,
  } = useJobs({ onToast: pushToast });

  const [dragOver, setDragOver] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [filter, setFilter] = useState<FilterStatus>("all");
  const [presetManagerOpen, setPresetManagerOpen] = useState(false);

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
    if (ok) startAll();
  }, [jobs, startAll, confirm, t]);

  const handleClearFinished = useCallback(async () => {
    const removable = jobs.filter(
      (j) => j.phase === "done" || j.phase === "error" || j.phase === "cancelled"
    ).length;
    if (removable === 0) return;
    const ok = await confirm({
      title: t("app.clearFinished.title"),
      message: t("app.clearFinished.msg", { n: removable }),
      confirmLabel: t("app.clearFinished.confirm"),
      cancelLabel: t("confirm.cancel"),
      danger: true,
    });
    if (ok) clearFinished();
  }, [jobs, clearFinished, confirm, t]);

  const handleRetryAllFailed = useCallback(async () => {
    const failed = jobs.filter((j) => j.phase === "error").length;
    if (failed === 0) return;
    const ok = await confirm({
      title: t("app.retryFailed.title"),
      message: t("app.retryFailed.msg", { n: failed }),
      confirmLabel: t("app.retryFailed.confirm"),
      cancelLabel: t("confirm.cancel"),
    });
    if (ok) retryAllFailed();
  }, [jobs, retryAllFailed, confirm, t]);

  const handleClearAll = useCallback(async () => {
    if (jobs.length === 0) return;
    const ok = await confirm({
      title: t("app.clearAll.title"),
      message: t("app.clearAll.msg", { n: jobs.length }),
      confirmLabel: t("app.clearAll.confirm"),
      cancelLabel: t("confirm.cancel"),
      danger: true,
    });
    if (ok) clearAll();
  }, [jobs, clearAll, confirm, t]);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
  }

  return (
    <div className="flex h-screen flex-col">
      <Header themeMode={themeMode} onThemeChange={setThemeMode} />

      <div className="app-layout">
        <Sidebar
          hasJobs={hasJobs}
          jobCount={jobs.length}
          loading={loading}
          onClickAdd={pickFiles}
          outputDir={settings.outputDir}
          outputSuffix={settings.outputSuffix}
          maxConcurrent={settings.maxConcurrent}
          onChooseOutput={chooseOutput}
          onSetOutputSuffix={setOutputSuffix}
          onClearOutputDir={() => setOutputDir(null)}
          onMaxConcurrentChange={setMaxConcurrent}
          gpuInfo={gpuInfo}
          gpu={settings.gpu}
          onGpuChange={setGpu}
          stats={stats}
          allDone={allDone}
          overall={overall}
          totalIn={totalIn}
          totalOut={totalOut}
          onManagePresets={() => setPresetManagerOpen(true)}
        />

        <div className="app-main">
          {error && (
            <div
              className="mb-4 rounded-xl border border-error-100 bg-error-50 px-4 py-2.5 text-sm text-error-700 dark:border-error-900/50 dark:bg-error-950/30 dark:text-error-400"
              role="alert"
            >
              {error}
            </div>
          )}

          {loading && jobs.length === 0 ? (
            <div aria-label="加载中" className="space-y-4">
              <SkeletonJobCard mediaType="video" />
              <SkeletonJobCard mediaType="image" />
              <SkeletonJobCard mediaType="audio" />
            </div>
          ) : !hasJobs ? (
            <DropZone
              dragOver={dragOver}
              onClick={pickFiles}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
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
                    {stats.doneCount > 0 && (
                      <span className="rounded-full bg-success-50 px-2.5 py-0.5 text-xs font-medium text-success-600 dark:bg-success-950/30 dark:text-success-400">
                        {stats.doneCount} {t("app.doneBadge")}
                      </span>
                    )}
                    {stats.runningCount > 0 && (
                      <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-600 dark:bg-brand-950/30 dark:text-brand-400">
                        {stats.runningCount} {t("app.runningBadge")}
                      </span>
                    )}
                    {stats.failedCount > 0 && (
                      <span className="rounded-full bg-error-50 px-2.5 py-0.5 text-xs font-medium text-error-600 dark:bg-error-950/30 dark:text-error-400">
                        {stats.failedCount} {t("app.failedBadge")}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {stats.queuedCount > 0 && (
                      <button
                        onClick={handleStartAll}
                        className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 dark:bg-brand-600 dark:hover:bg-brand-700"
                      >
                        {t("app.startAllBtn", { n: stats.queuedCount })}
                      </button>
                    )}
                    {jobs.some(
                      (j) =>
                        j.phase === "done" ||
                        j.phase === "error" ||
                        j.phase === "cancelled"
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
                    {stats.failedCount > 0 && (
                      <button
                        onClick={handleRetryAllFailed}
                        className="rounded-lg border border-error-200 bg-error-50 px-3 py-1.5 text-xs font-medium text-error-600 transition hover:bg-error-100 dark:border-error-800 dark:bg-error-950/30 dark:text-error-400 dark:hover:bg-error-900/50"
                        title={t("app.retryFailed.title")}
                      >
                        {t("app.retryFailedBtn", { n: stats.failedCount })}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <JobList
                jobs={filteredJobs}
                maxConcurrent={settings.maxConcurrent}
                onMaxConcurrentChange={setMaxConcurrent}
                onJobStart={startOne}
                onJobCancel={cancelOne}
                onJobRemove={removeOne}
                onJobOpenFolder={openOutputFolder}
                onJobChangeParams={changeParams}
                onJobSyncParams={syncParamsToAll}
                onJobRetry={retryOne}
                onReorderStart={reorderStart}
                onReorderOver={reorderOver}
                onReorderDrop={reorderDrop}
              />
            </>
          )}
        </div>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissAll} />
      {confirmDialog}
      <PresetManager open={presetManagerOpen} onClose={() => setPresetManagerOpen(false)} />
    </div>
  );
}
