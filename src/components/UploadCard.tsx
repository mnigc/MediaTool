import type { UploadTargetKind, UploadTask } from "../types";
import { formatBytes, openOutputFolder } from "../lib/engine";
import { canRevealInFolder, openExternal } from "../lib/shell";
import {
  CheckIcon,
  UploadIcon,
  FolderIcon,
  GlobeIcon,
  SpinnerIcon,
  XIcon,
} from "./icons";
import { useI18n } from "../i18n";

type Props = {
  task: UploadTask;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
};

const KIND_LABEL: Record<UploadTargetKind, string> = {
  webdav: "WebDAV",
  telegram: "Telegram",
  youtube: "YouTube",
  gdrive: "Google Drive",
  onedrive: "OneDrive",
};

const KIND_CLS: Record<UploadTargetKind, string> = {
  webdav:
    "bg-brand-50 text-brand-700 ring-brand-200 dark:bg-brand-950 dark:text-brand-300 dark:ring-brand-800",
  telegram:
    "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-800",
  youtube:
    "bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-800",
  gdrive:
    "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800",
  onedrive:
    "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-800",
};

const statusClass = (phase: UploadTask["phase"]): string => {
  switch (phase) {
    case "queued": return "status-bar-queued";
    case "running": return "status-bar-running";
    case "done": return "status-bar-done";
    case "error": return "status-bar-error";
    default: return "status-bar-cancelled";
  }
};

/** One upload transfer, rendered in the task center next to jobs. A Telegram
 *  card can cover several files, which land as a single album. */
export default function UploadCard({ task, onCancel, onRetry, onRemove }: Props) {
  const { t } = useI18n();
  const isDone = task.phase === "done";
  const isError = task.phase === "error";
  const isRunning = task.phase === "running";
  const isQueued = task.phase === "queued";

  return (
    <div
      className={`pop rounded-2xl bg-white p-4 shadow-card ring-1 ring-neutral-200 transition-all duration-200 ${statusClass(task.phase)} hover:shadow-card-hover dark:bg-neutral-900 dark:ring-neutral-800`}
    >
      <div className="flex items-start gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${KIND_CLS[task.kind]}`}>
          <UploadIcon className="h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${KIND_CLS[task.kind]}`}>
              {KIND_LABEL[task.kind]}
            </span>
            <span
              className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100"
              title={task.filePaths.map(baseName).join("\n")}
            >
              {baseName(task.filePaths[0] ?? "")}
            </span>
            {task.filePaths.length > 1 && (
              <span className="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">
                {t("upload.card.fileCount", { n: task.filePaths.length })}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-neutral-400 dark:text-neutral-500" title={task.targetName}>
            {task.targetName}
            {task.size > 0 ? ` · ${formatBytes(task.size)}` : ""}
          </p>
        </div>

        <button
          onClick={() => onRemove(task.id)}
          className="shrink-0 rounded-lg p-1.5 text-neutral-300 transition hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          title={t("job.remove")}
          aria-label={t("job.remove")}
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      {isError && task.error && (
        <div className="mt-3 rounded-xl border border-error-100 bg-error-50 px-3 py-2 text-xs leading-relaxed text-error-700 dark:border-error-900/50 dark:bg-error-950/30 dark:text-error-400">
          {task.error}
        </div>
      )}

      {isRunning && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
            <span className="flex items-center gap-1.5 text-brand-600 dark:text-brand-400">
              <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
              {t("upload.card.uploading")}
            </span>
            <span className="font-medium text-neutral-700 dark:text-neutral-300">
              {task.percent.toFixed(1)}%
              {task.speed ? <span className="ml-2 text-neutral-400 dark:text-neutral-500">{task.speed}</span> : null}
            </span>
          </div>
          <div className="relative h-2 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
            <div
              className="relative h-full rounded-full brand-progress transition-all duration-300"
              style={{ width: `${task.percent}%` }}
            >
              <div className="absolute inset-0 rounded-full brand-shimmer" />
            </div>
          </div>
        </div>
      )}

      {(isDone || isError || task.phase === "cancelled") && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span
            className={`flex items-center gap-1.5 text-xs font-medium ${
              isDone
                ? "text-success-600 dark:text-success-400"
                : isError
                  ? "text-error-600 dark:text-error-400"
                  : "text-neutral-500 dark:text-neutral-400"
            }`}
          >
            {isDone ? <CheckIcon className="h-3.5 w-3.5" /> : null}
            {isDone
              ? t("upload.card.done")
              : isError
                ? t("upload.card.failed")
                : t("upload.card.cancelled")}
          </span>
          <div className="flex items-center gap-2">
            {isDone && task.url && (
              <button
                onClick={() => openExternal(task.url!)}
                className="flex items-center gap-1 rounded-lg bg-white px-2.5 py-1.5 text-xs font-medium text-brand-700 ring-1 ring-brand-200 transition hover:bg-brand-50 dark:bg-neutral-800 dark:text-brand-300 dark:ring-neutral-700 dark:hover:bg-neutral-700"
              >
                <GlobeIcon className="h-3.5 w-3.5" />
                {t("upload.card.openLink")}
              </button>
            )}
            {isDone && canRevealInFolder && (
              <button
                onClick={() => openOutputFolder(task.filePaths[0])}
                className="flex items-center gap-1 rounded-lg bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-600 ring-1 ring-neutral-200 transition hover:bg-neutral-50 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700 dark:hover:bg-neutral-700"
              >
                <FolderIcon className="h-3.5 w-3.5" />
                {t("job.open")}
              </button>
            )}
            {(isError || task.phase === "cancelled") && (
              <button
                onClick={() => onRetry(task.id)}
                className="rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-xs font-medium text-brand-700 transition hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
              >
                {t("job.retry")}
              </button>
            )}
          </div>
        </div>
      )}

      {isQueued && (
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-neutral-400 dark:text-neutral-500">{t("upload.card.queued")}</span>
          <button
            onClick={() => onCancel(task.id)}
            className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            {t("confirm.cancel")}
          </button>
        </div>
      )}

      {isRunning && (
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => onCancel(task.id)}
            className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            {t("confirm.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}

function baseName(p: string): string {
  const norm = p.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1);
}
