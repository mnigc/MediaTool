import { SpinnerIcon, XIcon } from "./icons";
import { useI18n } from "../i18n";
import type { UpdaterPhase } from "../hooks/useUpdater";
import type { Update } from "@tauri-apps/plugin-updater";

interface UpdateDialogProps {
  open: boolean;
  currentVersion: string;
  update: Update | null;
  phase: UpdaterPhase;
  progress: number;
  onDownload: () => void;
  onClose: () => void;
}

export default function UpdateDialog({
  open,
  currentVersion,
  update,
  phase,
  progress,
  onDownload,
  onClose,
}: UpdateDialogProps) {
  const { t } = useI18n();
  if (!open || !update) return null;

  const busy = phase === "downloading" || phase === "installing";
  const notes = update.body?.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={busy ? undefined : onClose}
      />
      <div className="relative z-10 w-full max-w-md rounded-2xl bg-white p-6 shadow-popover ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-700 animate-pop">
        <button
          onClick={onClose}
          disabled={busy}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-neutral-300 transition hover:bg-neutral-100 hover:text-neutral-600 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          aria-label="Close"
        >
          <XIcon className="h-4 w-4" />
        </button>
        <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          {t("updater.available.title")}
        </h3>
        <div className="mt-3 flex items-center gap-2">
          <span className="rounded-lg bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            {t("updater.current")} v{currentVersion}
          </span>
          <span className="text-neutral-300 dark:text-neutral-600">→</span>
          <span className="rounded-lg bg-brand-100 px-2.5 py-1 text-xs font-semibold text-brand-700 dark:bg-brand-950/70 dark:text-brand-300">
            v{update.version}
          </span>
        </div>
        {notes ? (
          <div className="mt-4 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl bg-neutral-50 p-3 text-xs leading-relaxed text-neutral-600 ring-1 ring-neutral-100 dark:bg-neutral-800/60 dark:text-neutral-300 dark:ring-neutral-800">
            {notes}
          </div>
        ) : (
          <p className="mt-4 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
            {t("updater.available.hint")}
          </p>
        )}

        {phase === "checking" && (
          <div className="mt-6 flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
            <SpinnerIcon className="h-4 w-4 animate-spin" />
            {t("updater.checking")}
          </div>
        )}

        {phase === "downloading" && (
          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="text-neutral-600 dark:text-neutral-300">
                {t("updater.downloading")}
              </span>
              <span className="font-medium text-brand-600 dark:text-brand-300">
                {progress}%
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
              <div
                className="h-full rounded-full brand-gradient transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {phase === "installing" && (
          <div className="mt-6 flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
            <SpinnerIcon className="h-4 w-4 animate-spin" />
            {t("updater.installing")}
          </div>
        )}

        {!busy && phase !== "checking" && (
          <div className="mt-6 flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              {t("updater.later")}
            </button>
            <button
              onClick={onDownload}
              className="rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 active:bg-brand-700"
            >
              {t("updater.download")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
