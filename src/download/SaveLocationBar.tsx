import { open } from "@tauri-apps/plugin-dialog";
import { openOutputFolder } from "../lib/tauri";
import { useI18n } from "../i18n";
import { useDownloads } from "../contexts/DownloadCenter";
import { FolderIcon } from "../components/icons";

/** Save-location card shown at the top of the config sidebar on the
 *  download & record pages. */
export default function SaveLocationBar() {
  const { t } = useI18n();
  const dl = useDownloads();
  const dir = dl.settings.outputDir;

  const choose = async () => {
    const d = await open({ directory: true, title: t("dl.outputDir") });
    if (d && !Array.isArray(d)) dl.updateSettings({ outputDir: d });
  };

  const btn =
    "rounded-lg border border-neutral-200 px-2.5 py-1 text-[11px] font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800";

  return (
    <div className="px-4 py-3.5">
      <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        <FolderIcon className="h-3.5 w-3.5" />
        {t("dl.saveLocation")}
      </p>
      <p
        className="truncate text-xs text-neutral-600 dark:text-neutral-300"
        title={dir ?? undefined}
      >
        {dir ?? t("dl.noOutputDir")}
      </p>
      <div className="mt-2 flex gap-1.5">
        <button onClick={() => void choose()} className={btn}>
          {t("dl.changeDir")}
        </button>
        {dir && (
          <button onClick={() => void openOutputFolder(dir)} className={btn}>
            {t("dl.openDir")}
          </button>
        )}
      </div>
    </div>
  );
}
