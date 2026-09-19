import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FilterTabs, { type FilterStatus } from "../components/FilterTabs";
import JobList from "../components/JobList";
import SkeletonJobCard from "../components/SkeletonJobCard";
import PresetManager from "../components/PresetManager";
import Select from "../components/Select";
import { Button } from "../components/ui";
import DropZone from "../components/DropZone";
import UploadTargetChips from "../components/UploadTargetChips";
import { useConfirm } from "../components/ConfirmDialog";
import { formatBytes, openOutputFolder } from "../lib/tauri";
import { estimateOutputSize } from "../lib/estimate";
import { useI18n } from "../i18n";
import { useTasks } from "../contexts/TaskCenter";
import { useUploads } from "../contexts/UploadCenter";
import { pipelineById, pipelineDisplayName, usePipelines } from "../workflow/pipelines";
import { ConfigSidebar, Field, SidebarSection } from "../download/Sidebar";
import { extOk } from "./FilePicker";
import { isBatchEditable } from "./kinds";
import { getTool, type WorkbenchId } from "./registry";

type QueuableToolId = Exclude<WorkbenchId, "inspect" | "workflow">;

/** Below this many jobs the status tabs duplicate the count line — the tabs
 *  only earn their space once the list is big enough to filter. */
const FILTER_TABS_MIN = 6;

/** The suffix is concatenated into output filenames — strip path separators
 *  and characters Windows filenames forbid. */
const sanitizeSuffix = (raw: string) =>
  raw.replace(/[/\\:*?"<>|]/g, "").replace(/[\x00-\x1f]/g, "");

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
  const pipelines = usePipelines();
  const [filter, setFilter] = useState<FilterStatus>("all");
  const [presetManagerOpen, setPresetManagerOpen] = useState(false);
  /** Pipeline bound to newly added jobs ("run when finished"). Mirrored into
   *  a ref so the drop handler below can read it without re-registering. */
  const [afterPipeline, setAfterPipeline] = useState("");
  const afterPipelineRef = useRef(afterPipeline);
  afterPipelineRef.current = afterPipeline;
  /** Upload targets bound to newly added jobs; ref mirrors the same way. */
  const [uploadTo, setUploadTo] = useState<string[]>([]);
  const uploadToRef = useRef(uploadTo);
  uploadToRef.current = uploadTo;

  const meta = getTool(toolId)!;
  const accepts = meta.accepts;
  const multiFile = meta.multiFile;
  const uploads = useUploads();
  // Toolbar chrome: GPU only used by the video-compress tool; presets only by
  // the compress tools.
  const showGpu = toolId === "video-compress";
  const showPresets = toolId.endsWith("-compress");

  // Only real media types ("video" | "audio") drive the localized
  // support/filter hints.
  const displayMediaType = meta.mediaType ?? meta.category;

  useEffect(() => {
    tasks.registerDropHandler((paths) => {
      const valid = paths.filter((p) => extOk(p, accepts));
      if (valid.length === 0) return;
      const toAdd = multiFile ? valid : valid.slice(0, 1);
      tasks.addCompressFiles(toAdd, toolId, multiFile, {
        pipelineIds: afterPipelineRef.current ? [afterPipelineRef.current] : [],
        uploadTo: uploadToRef.current,
      });
    });
    return () => tasks.registerDropHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolId]);

  const jobs = tasks.jobs.filter((j) => j.toolId === toolId);
  const hasJobs = jobs.length > 0;
  const showFilterTabs = jobs.length >= FILTER_TABS_MIN;
  // A stale filter below the tab threshold would strand the list on an
  // invisible "done/cancelled" view.
  useEffect(() => {
    if (!showFilterTabs && filter !== "all") setFilter("all");
  }, [showFilterTabs, filter]);
  // Sync-params only makes sense for batch tools (compress/convert) where you
  // import several files intending uniform settings, and only when there are
  // multiple queued jobs to copy across.
  const queuedCount = jobs.filter((j) => j.phase === "queued").length;
  const syncParamsEditable = isBatchEditable(toolId) && queuedCount > 1;

  // Sidebar roll-up: input size vs. expected output (actual for finished
  // jobs, estimate otherwise). Gives the 全部开始 decision a total to look at.
  const batchSummary = useMemo(() => {
    if (!isBatchEditable(toolId) || jobs.length === 0) return null;
    let inBytes = 0;
    let outBytes = 0;
    let hasOut = false;
    for (const j of jobs) {
      inBytes += j.info.sizeBytes ?? 0;
      if (j.phase === "done" && j.outputSize != null) {
        outBytes += j.outputSize;
        hasOut = true;
        continue;
      }
      const est =
        j.sizeEstimate?.bytes ?? estimateOutputSize(j.info, j.params)?.bytes ?? null;
      if (est != null) {
        outBytes += est;
        hasOut = true;
      }
    }
    if (inBytes === 0 || !hasOut) return null;
    return { inBytes, outBytes, saved: 1 - outBytes / inBytes };
  }, [jobs, toolId]);

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

  const filterName = displayMediaType ? t(`dz.filter.${displayMediaType}`) : t("dz.filter.any");

  const dir = tasks.settings.outputDir;
  const boundPipeline = pipelineById(afterPipeline);
  const pipelineSummary = afterPipeline
    ? (boundPipeline ? pipelineDisplayName(boundPipeline, t) : afterPipeline)
    : t("workbench.afterPipeline.none");
  const uploadSummary = uploadTo
    .map((id) => uploads.targets.find((x) => x.id === id)?.name ?? id)
    .join("、");

  return (
    <div className="mx-auto max-w-5xl">
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

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-5">
        <div className="min-w-0 flex-1">
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
            {showFilterTabs && (
              <FilterTabs
                jobs={jobs}
                active={filter}
                onChange={setFilter}
              />
            )}

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
                <span className="font-semibold text-neutral-800 dark:text-neutral-200">
                  {t("app.jobsCount", { n: jobs.length })}
                </span>
                {/* With the tabs visible these badges only repeat their
                    counts; they stay for the short-list case. */}
                {!showFilterTabs && tasks.stats.doneCount > 0 && (
                  <span className="rounded-full bg-success-50 px-2.5 py-0.5 text-xs font-medium text-success-600 dark:bg-success-950/30 dark:text-success-400">
                    {tasks.stats.doneCount} {t("app.doneBadge")}
                  </span>
                )}
                {!showFilterTabs && tasks.stats.runningCount > 0 && (
                  <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-600 dark:bg-brand-950/30 dark:text-brand-400">
                    {tasks.stats.runningCount} {t("app.runningBadge")}
                  </span>
                )}
                {!showFilterTabs && tasks.stats.failedCount > 0 && (
                  <span className="rounded-full bg-error-50 px-2.5 py-0.5 text-xs font-medium text-error-600 dark:bg-error-950/30 dark:text-error-400">
                    {tasks.stats.failedCount} {t("app.failedBadge")}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {tasks.stats.queuedCount > 0 && (
                  <Button variant="primary" onClick={handleStartAll}>
                    {t("app.startAllBtn", { n: tasks.stats.queuedCount })}
                  </Button>
                )}
                {jobs.some(
                  (j) =>
                    j.phase === "done" ||
                    j.phase === "error" ||
                    j.phase === "cancelled" ||
                    j.phase === "skipped"
                ) && (
                  <Button size="sm" onClick={handleClearFinished} title={t("app.clearFinished.title")}>
                    {t("app.clearFinishedBtn")}
                  </Button>
                )}
                <Button size="sm" onClick={handleClearAll} title={t("app.clearAll.title")}>
                  {t("app.clearAllBtn")}
                </Button>
                {tasks.stats.failedCount > 0 && (
                  <Button size="sm" variant="danger" onClick={handleRetryAllFailed} title={t("app.retryFailed.title")}>
                    {t("app.retryFailedBtn", { n: tasks.stats.failedCount })}
                  </Button>
                )}
              </div>
            </div>

            <DropZone
              compact
              dragOver={false}
              jobCount={jobs.length}
              onClick={() => tasks.pickFiles([{ name: filterName, extensions: accepts }])}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => {}}
              onDrop={(e) => e.preventDefault()}
            />
          </div>

          <JobList
            jobs={filteredJobs}
            onJobStart={tasks.startOne}
            onJobCancel={tasks.cancelOne}
            onJobRemove={tasks.removeOne}
            onJobOpenFolder={openOutputFolder}
            onJobChangeParams={tasks.changeParams}
            onJobSyncParams={syncParamsEditable ? tasks.syncParamsToAll : undefined}
            onJobRetry={tasks.retryOne}
            onJobRunPipeline={tasks.runJobPipeline}
            onReorderStart={tasks.reorderStart}
            onReorderOver={tasks.reorderOver}
            onReorderDrop={tasks.reorderDrop}
          />
        </>
      )}

        </div>

        <ConfigSidebar>
          {batchSummary && (
            <SidebarSection title={t("sidebar.batch.title")}>
              <p className="text-xs text-neutral-700 dark:text-neutral-200">
                {t("sidebar.batch.flow", {
                  input: formatBytes(batchSummary.inBytes),
                  output: formatBytes(batchSummary.outBytes),
                })}
              </p>
              {batchSummary.saved > 0.005 && (
                <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
                  {t("sidebar.batch.saved", { pct: Math.round(batchSummary.saved * 100) })}
                </p>
              )}
            </SidebarSection>
          )}

          <SidebarSection title={t("dl.saveLocation")}>
            <p
              className="truncate text-xs text-neutral-700 dark:text-neutral-200"
              title={dir ?? t("sidebar.sameDirFull")}
            >
              {dir ?? t("sidebar.sameDirFull")}
            </p>
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => void tasks.chooseOutput()}>
                {t("dl.changeDir")}
              </Button>
              {dir && (
                <Button size="sm" onClick={() => void openOutputFolder(dir)}>
                  {t("dl.openDir")}
                </Button>
              )}
              {dir && (
                <Button size="sm" onClick={() => tasks.setOutputDir(null)}>
                  {t("sidebar.sameDir")}
                </Button>
              )}
            </div>
          </SidebarSection>

          <SidebarSection
            title={t("sidebar.output")}
            collapsible
            defaultOpen={false}
            summary={`${t(`sidebar.ov.${tasks.settings.overwritePolicy}`)} · ${t("sidebar.parallel")} ${tasks.settings.maxConcurrent}`}
          >
            <Field label={t("sidebar.suffix")}>
              <input
                value={tasks.settings.outputSuffix}
                onChange={(e) => tasks.setOutputSuffix(sanitizeSuffix(e.target.value))}
                placeholder="_mediatool"
                className="w-28 min-w-0 rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 focus:border-brand-400 focus:ring-1 focus:ring-brand-100"
              />
            </Field>
            <Field label={t("sidebar.overwritePolicy")}>
              <Select
                value={tasks.settings.overwritePolicy}
                onChange={(v) => tasks.setOverwritePolicy(v as "overwrite" | "rename" | "skip")}
                className="w-32"
              >
                <option value="rename">{t("sidebar.ov.rename")}</option>
                <option value="skip">{t("sidebar.ov.skip")}</option>
                <option value="overwrite">{t("sidebar.ov.overwrite")}</option>
              </Select>
            </Field>
            <Field label={t("sidebar.parallel")}>
              <Select
                value={String(tasks.settings.maxConcurrent)}
                onChange={(v) => tasks.setMaxConcurrent(Number(v))}
                className="w-20"
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={4}>4</option>
              </Select>
            </Field>
          </SidebarSection>

          {showGpu && (
            <SidebarSection title={t("sidebar.gpu")} collapsible defaultOpen={false} summary={tasks.settings.gpu ? t(`gpu.${tasks.settings.gpu}`) : t("gpu.cpu")}>
              <Select
                value={tasks.settings.gpu}
                onChange={(v) => tasks.setGpu(v)}
                disabled={!tasks.gpuInfo.available}
                className="w-full"
                title={t("sidebar.gpu")}
              >
                <option value="">{t("gpu.cpu")}</option>
                {tasks.gpuInfo.backends.map((b) => (
                  <option key={b.id} value={b.id}>
                    {t(`gpu.${b.id}`)}
                  </option>
                ))}
              </Select>
              <p className="text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                {tasks.gpuInfo.available
                  ? t("sidebar.gpuAvailable", { n: tasks.gpuInfo.backends.length })
                  : t("sidebar.gpuNone")}
              </p>
            </SidebarSection>
          )}

          {showPresets && (
            <SidebarSection title={t("sidebar.presets")}>
              <Button size="sm" className="w-full" onClick={() => setPresetManagerOpen(true)}>
                {t("workbench.managePresets")}
              </Button>
            </SidebarSection>
          )}

          <SidebarSection
            title={t("workbench.afterPipeline")}
            collapsible
            defaultOpen={false}
            summary={pipelineSummary}
          >
            <Select
              value={afterPipeline}
              onChange={setAfterPipeline}
              className="w-full"
              title={t("workbench.afterPipeline.hint")}
            >
              <option value="">{t("workbench.afterPipeline.none")}</option>
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {pipelineDisplayName(p, t)}
                </option>
              ))}
            </Select>
          </SidebarSection>

          <SidebarSection
            title={t("upload.pick.title")}
            collapsible
            defaultOpen={false}
            summary={uploadSummary || t("upload.pick.none")}
          >
            <div className="space-y-1.5">
              <UploadTargetChips selected={uploadTo} onChange={setUploadTo} />
              {uploadTo.length > 0 && (
                <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
                  {t("upload.pick.hint")}
                </p>
              )}
            </div>
          </SidebarSection>
        </ConfigSidebar>
      </div>

      {confirmDialog}
      {showPresets && (
        <PresetManager open={presetManagerOpen} onClose={() => setPresetManagerOpen(false)} />
      )}
    </div>
  );
}
