import { useI18n } from "../i18n";
import { useTasks } from "../contexts/TaskCenter";
import { FolderIcon, XIcon } from "./icons";

interface OutputSettingsProps {
  compact?: boolean;
}

export default function OutputSettings({ compact = false }: OutputSettingsProps) {
  const { t } = useI18n();
  const tasks = useTasks();

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-800">
          <button
            onClick={() => void tasks.chooseOutput()}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-neutral-700 transition hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-700"
            title={tasks.settings.outputDir ?? t("sidebar.sameDirFull")}
          >
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-brand-500" />
            <span className="truncate max-w-[120px]">
              {tasks.settings.outputDir ?? t("sidebar.sameDir")}
            </span>
          </button>
          {tasks.settings.outputDir && (
            <>
              <div className="h-3 w-px bg-neutral-200 dark:bg-neutral-600" />
              <button
                onClick={() => tasks.setOutputDir(null)}
                className="flex items-center justify-center px-1.5 py-1 text-neutral-400 transition hover:bg-error-50 hover:text-error-500 dark:text-neutral-500 dark:hover:bg-error-950/30 dark:hover:text-error-400"
                title={t("sidebar.sameDirFull")}
              >
                <XIcon className="h-3 w-3" />
              </button>
            </>
          )}
        </div>
        <input
          value={tasks.settings.outputSuffix}
          onChange={(e) => tasks.setOutputSuffix(e.target.value)}
          placeholder="_mediatool"
          className="w-24 rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 focus:border-brand-400 focus:ring-1 focus:ring-brand-100"
          title={t("sidebar.suffix")}
        />
        <select
          value={tasks.settings.overwritePolicy}
          onChange={(e) =>
            tasks.setOverwritePolicy(e.target.value as "overwrite" | "rename" | "skip")
          }
          className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 focus:border-brand-400 focus:ring-1 focus:ring-brand-100"
          title={t("sidebar.overwritePolicy")}
        >
          <option value="rename">{t("sidebar.ov.rename")}</option>
          <option value="skip">{t("sidebar.ov.skip")}</option>
          <option value="overwrite">{t("sidebar.ov.overwrite")}</option>
        </select>
        <select
          value={tasks.settings.maxConcurrent}
          onChange={(e) => tasks.setMaxConcurrent(Number(e.target.value))}
          className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 focus:border-brand-400 focus:ring-1 focus:ring-brand-100"
          title={t("sidebar.parallel")}
        >
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={4}>4</option>
        </select>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-neutral-50/50 dark:bg-neutral-900/50 ring-1 ring-neutral-200/50 dark:ring-neutral-800/50 p-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
            {t("sidebar.output")}
          </div>
          <div className="mt-1 flex items-center rounded-lg border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-800">
            <button
              onClick={() => void tasks.chooseOutput()}
              className="flex flex-1 min-w-0 items-center gap-1.5 px-2 py-1.5 text-left text-xs text-neutral-700 transition hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-700"
              title={tasks.settings.outputDir ?? t("sidebar.sameDirFull")}
            >
              <FolderIcon className="h-3.5 w-3.5 shrink-0 text-brand-500" />
              <span className="truncate">
                {tasks.settings.outputDir ?? t("sidebar.sameDir")}
              </span>
            </button>
            {tasks.settings.outputDir && (
              <>
                <div className="h-3 w-px bg-neutral-200 dark:bg-neutral-600" />
                <button
                  onClick={() => tasks.setOutputDir(null)}
                  className="flex items-center justify-center px-1.5 py-1.5 text-neutral-400 transition hover:bg-error-50 hover:text-error-500 dark:text-neutral-500 dark:hover:bg-error-950/30 dark:hover:text-error-400"
                  title={t("sidebar.sameDirFull")}
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </>
            )}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
            {t("sidebar.suffix")}
          </div>
          <input
            value={tasks.settings.outputSuffix}
            onChange={(e) => tasks.setOutputSuffix(e.target.value)}
            placeholder="_mediatool"
            className="mt-1 w-full rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 focus:border-brand-400 focus:ring-1 focus:ring-brand-100"
          />
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
            {t("sidebar.overwritePolicy")}
          </div>
          <select
            value={tasks.settings.overwritePolicy}
            onChange={(e) =>
              tasks.setOverwritePolicy(e.target.value as "overwrite" | "rename" | "skip")
            }
            className="mt-1 w-full rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 focus:border-brand-400 focus:ring-1 focus:ring-brand-100"
          >
            <option value="rename">{t("sidebar.ov.rename")}</option>
            <option value="skip">{t("sidebar.ov.skip")}</option>
            <option value="overwrite">{t("sidebar.ov.overwrite")}</option>
          </select>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
            {t("sidebar.parallel")}
          </div>
          <select
            value={tasks.settings.maxConcurrent}
            onChange={(e) => tasks.setMaxConcurrent(Number(e.target.value))}
            className="mt-1 w-full rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 focus:border-brand-400 focus:ring-1 focus:ring-brand-100"
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={4}>4</option>
          </select>
        </div>
      </div>
    </div>
  );
}
