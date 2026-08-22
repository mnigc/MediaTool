import { CheckIcon, XIcon, FolderIcon, EditIcon } from "./icons";
import { ChartIcon, SlidersIcon } from "./icons";
import { UploadIcon } from "./icons";
import { formatBytes } from "../lib/tauri";
import { useI18n } from "../i18n";

interface SidebarProps {
  hasJobs: boolean;
  jobCount: number;
  loading: boolean;
  onClickAdd: () => void;
  outputDir: string | null;
  outputSuffix: string;
  maxConcurrent: number;
  onChooseOutput: () => void;
  onSetOutputSuffix: (v: string) => void;
  onClearOutputDir: () => void;
  onMaxConcurrentChange: (n: number) => void;
  gpuInfo: { available: boolean; backends: { id: string; name: string }[] };
  gpu: string;
  onGpuChange: (id: string) => void;
  stats: {
    queuedCount: number;
    doneCount: number;
    failedCount: number;
    runningCount: number;
  };
  allDone: boolean;
  overall: number;
  totalIn: number;
  totalOut: number;
  onManagePresets: () => void;
}

export default function Sidebar({
  hasJobs,
  jobCount,
  loading,
  onClickAdd,
  outputDir,
  outputSuffix,
  maxConcurrent,
  onChooseOutput,
  onSetOutputSuffix,
  onClearOutputDir,
  onMaxConcurrentChange,
  gpuInfo,
  gpu,
  onGpuChange,
  stats,
  allDone,
  overall,
  totalIn,
  totalOut,
  onManagePresets,
}: SidebarProps) {
  const { t } = useI18n();
  return (
    <aside
      data-od-id="app-sidebar"
      className="app-sidebar flex flex-col bg-neutral-50 dark:bg-neutral-900 border-r border-neutral-200 dark:border-neutral-800"
    >
      {/* Add files */}
      <div className="sidebar-section px-3 py-3">
        <button
          onClick={onClickAdd}
          className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand-300 bg-brand-50/50 px-3 py-3 text-sm font-medium text-brand-700 transition hover:border-brand-400 hover:bg-brand-100 dark:border-brand-700 dark:bg-brand-950/30 dark:text-brand-300 dark:hover:border-brand-500 dark:hover:bg-brand-900/50"
          aria-label="添加文件"
        >
          <UploadIcon className="h-4 w-4" />
          <span>
            {loading
              ? t("sidebar.add.loading")
              : hasJobs
                ? t("sidebar.add.many", { n: jobCount })
                : t("sidebar.add.one")}
          </span>
        </button>
      </div>

      {/* Settings */}
      <div className="sidebar-section px-3 py-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
          <FolderIcon className="h-3.5 w-3.5" />
          <span>{t("sidebar.settings")}</span>
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <label className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
              {t("sidebar.output")}
            </label>
            <span
              className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-700 dark:text-neutral-300"
              title={outputDir ?? t("sidebar.sameDirFull")}
            >
              {outputDir ?? t("sidebar.sameDir")}
            </span>
            <button
              onClick={onChooseOutput}
              className="shrink-0 rounded-lg p-1 text-brand-600 transition hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-950/50"
              title={t("sidebar.changeOutput")}
              aria-label={t("sidebar.changeOutput")}
            >
              <EditIcon className="h-3.5 w-3.5" />
            </button>
            {outputDir && (
              <button
                onClick={onClearOutputDir}
                className="shrink-0 p-0.5 text-neutral-400 transition hover:text-neutral-600 dark:hover:text-neutral-300"
                title={t("sidebar.reset")}
              >
                <XIcon className="h-3 w-3" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <label className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
              {t("sidebar.suffix")}
            </label>
            <input
              value={outputSuffix}
              onChange={(e) => onSetOutputSuffix(e.target.value)}
              placeholder="_mediapress"
              className="flex-1 min-w-0 rounded-lg border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700 transition focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-200 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:focus:border-brand-500"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
              {t("sidebar.parallel")}
            </label>
            <select
              value={maxConcurrent}
              onChange={(e) => onMaxConcurrentChange(Number(e.target.value))}
              className="flex-1 min-w-0 rounded-lg border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700 transition focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-200 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:focus:border-brand-500"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={4}>4</option>
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
              {t("sidebar.gpu")}
            </label>
            <select
              value={gpu}
              onChange={(e) => onGpuChange(e.target.value)}
              disabled={!gpuInfo.available}
              className="flex-1 min-w-0 rounded-lg border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700 transition focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-200 disabled:opacity-50 disabled:cursor-not-allowed dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:focus:border-brand-500"
            >
              <option value="">{t("gpu.cpu")}</option>
              {gpuInfo.backends.map((b) => (
                <option key={b.id} value={b.id}>
                  {t(`gpu.${b.id}`)}
                </option>
              ))}
            </select>
          </div>
          <div
            className={`rounded-lg px-2 py-1 text-[10px] font-medium ${
              gpuInfo.available
                ? "bg-success-50 text-success-700 dark:bg-success-950/30 dark:text-success-400"
                : "bg-neutral-100 text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500"
            }`}
          >
            {gpuInfo.available
              ? t("sidebar.gpuAvailable", { n: gpuInfo.backends.length })
              : t("sidebar.gpuNone")}
          </div>
          <button
            onClick={onManagePresets}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            <SlidersIcon className="h-3.5 w-3.5" />
            {t("sidebar.presets")}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="sidebar-section px-3 py-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
          <ChartIcon className="h-3.5 w-3.5" />
          <span>{t("sidebar.stats")}</span>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-500 dark:text-neutral-400">{t("sidebar.total")}</span>
            <span className="font-semibold text-neutral-800 dark:text-neutral-200">
              {jobCount}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-500 dark:text-neutral-400">{t("sidebar.done")}</span>
            <span className="font-semibold text-success-600 dark:text-success-400">
              {stats.doneCount}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-500 dark:text-neutral-400">{t("sidebar.failed")}</span>
            <span className="font-semibold text-error-600 dark:text-error-400">
              {stats.failedCount}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-500 dark:text-neutral-400">{t("sidebar.running")}</span>
            <span className="font-semibold text-brand-600 dark:text-brand-400">
              {stats.runningCount}
            </span>
          </div>
          {allDone && (
            <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-success-50 px-2 py-1.5 text-xs font-medium text-success-700 dark:bg-success-950/30 dark:text-success-400">
              <CheckIcon className="h-3 w-3" />
              <span>{t("sidebar.allDone")}</span>
            </div>
          )}
          {(stats.doneCount > 0 || totalIn > 0) && (
            <div className="mt-2 rounded-lg bg-brand-50 px-2 py-1.5 dark:bg-brand-950/30">
              <div className="text-xs text-brand-700 dark:text-brand-300">
                {t("sidebar.saved", {
                  n: overall > 0 ? (overall * 100).toFixed(0) : "—",
                })}
              </div>
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
                {totalIn > 0 ? (
                  `${formatBytes(totalIn - totalOut)}（${formatBytes(totalOut)} / ${formatBytes(totalIn)}）`
                ) : (
                  <span>{t("sidebar.noData")}</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Spacer */}
      <div className="flex-1" />
    </aside>
  );
}
