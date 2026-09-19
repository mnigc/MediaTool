import { open } from "@tauri-apps/plugin-dialog";
import { openOutputFolder } from "../lib/tauri";
import { useI18n } from "../i18n";
import { useDownloads } from "../contexts/DownloadCenter";
import { FolderIcon } from "../components/icons";
import { Button } from "../components/ui";

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

  return (
    <div className="px-4 py-3.5">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-neutral-600 dark:text-neutral-300">
        <FolderIcon className="h-3.5 w-3.5" />
        {t("dl.saveLocation")}
      </p>
      <p
        className="truncate text-xs text-neutral-700 dark:text-neutral-200"
        title={dir ?? undefined}
      >
        {dir ?? t("dl.noOutputDir")}
      </p>
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" onClick={() => void choose()}>
          {t("dl.changeDir")}
        </Button>
        {dir && (
          <Button size="sm" onClick={() => void openOutputFolder(dir)}>
            {t("dl.openDir")}
          </Button>
        )}
      </div>
    </div>
  );
}
