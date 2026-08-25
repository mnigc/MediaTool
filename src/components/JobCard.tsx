import { useEffect, useState } from "react";
import type { Job, JobParams } from "../types";
import JobParamsEditor from "../tools/JobParamsEditor";
import { getThumbnail } from "../lib/tauri";
import { estimateOutputSize } from "../lib/estimate";
import { friendlyError } from "../lib/errors";
import {
  CheckIcon,
  CopyIcon,
  CheckCircleIcon,
  FilmIcon,
  FolderIcon,
  ImageIcon,
  MusicIcon,
  PlayIcon,
  SpinnerIcon,
  XIcon,
} from "./icons";
import { formatBytes } from "../lib/tauri";
import { useI18n } from "../i18n";
import { isBatchEditable } from "../tools/kinds";

type Props = {
  job: Job;
  startIndex: number;
  onStart: (uiId: string) => void;
  onCancel: (uiId: string) => void;
  onRemove: (uiId: string) => void;
  onOpenFolder: (path: string) => void;
  onChangeParams?: (uiId: string, params: JobParams) => void;
  onSyncParams?: (uiId: string) => void;
  onRetry: (uiId: string) => void;
  onReorderStart?: (uiId: string) => void;
  onReorderOver?: (uiId: string) => void;
  onReorderDrop?: (uiId: string) => void;
};

const staggerClass = (i: number): string => {
  const idx = i % 8;
  return idx === 0 ? "stagger-in-1" : `stagger-in-${idx}`;
};

const TypeBadgeStyle: Record<string, { cls: string; Icon: typeof FilmIcon }> = {
  video: { cls: "bg-brand-50 text-brand-700 ring-brand-200 dark:bg-brand-950 dark:text-brand-300 dark:ring-brand-800", Icon: FilmIcon },
  image: { cls: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800", Icon: ImageIcon },
  audio: { cls: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800", Icon: MusicIcon },
};

const statusClass = (phase: Job["phase"]): string => {
  switch (phase) {
    case "queued": return "status-bar-queued";
    case "running": return "status-bar-running";
    case "done": return "status-bar-done";
    case "error": return "status-bar-error";
    default: return "status-bar-cancelled";
  }
};

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1);
}

function formatEta(seconds: number, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (!isFinite(seconds) || seconds <= 0) return "";
  const s = Math.round(seconds);
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return mm > 0 ? t("job.eta.min", { m: mm, s: ss }) : t("job.eta.sec", { s: ss });
}

function getProgressDetail(job: Job, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const parts: string[] = [];
  if (job.speed) parts.push(job.speed);
  if (job.startedAt && job.percent > 0) {
    const elapsed = (Date.now() - job.startedAt) / 1000;
    const eta = elapsed * (100 - job.percent) / job.percent;
    parts.push(formatEta(eta, t));
  }
  return parts.join(" · ") || t("job.processing");
}

function meta(job: Job): string {
  const i = job.info;
  const parts: string[] = [];
  if (i.width && i.height) parts.push(`${i.width}×${i.height}`);
  if (i.durationSecs && i.durationSecs > 0) {
    const s = Math.round(i.durationSecs);
    const mm = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, "0");
    parts.push(mm > 0 ? `${mm}:${ss}` : `${s}s`);
  }
  if (i.sizeBytes) parts.push(formatBytes(i.sizeBytes));
  if (i.bitrateKbps) parts.push(`${i.bitrateKbps} kbps`);
  const codec = i.videoCodec ?? i.audioCodec;
  if (codec) parts.push(codec);
  return parts.join(" · ");
}

export default function JobCard({
  job,
  startIndex,
  onStart,
  onCancel,
  onRemove,
  onOpenFolder,
  onChangeParams,
  onSyncParams,
  onRetry,
  onReorderStart,
  onReorderOver,
  onReorderDrop,
}: Props) {
  const { t } = useI18n();
  const badge = TypeBadgeStyle[job.info.mediaType] ?? TypeBadgeStyle.video;
  const Icon = badge.Icon;
  const typeLabel = t(
    `job.type.${job.info.mediaType === "unknown" ? "other" : job.info.mediaType}`
  );
  const isError = job.phase === "error";
  const isDone = job.phase === "done";
  const isRunning = job.phase === "running";
  const isQueued = job.phase === "queued";
  // Compress/convert tools show a size estimate; all queued jobs are editable.
  const isCore = isBatchEditable(job.toolId);
  const isEditable = job.toolId !== "inspect";
  const [over, setOver] = useState(false);
  const draggable = isQueued && isEditable && !!onReorderStart;
  const [thumb, setThumb] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCopyError = async () => {
    if (!job.error) return;
    await copyText(job.error);
  };

  useEffect(() => {
    let cancelled = false;
    if (job.info.mediaType === "image" || job.info.mediaType === "video") {
      getThumbnail(job.info.path, job.info.mediaType)
        .then((t) => {
          if (!cancelled) setThumb(t);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [job.info.path, job.info.mediaType]);

  const savings =
    job.outputSize != null && job.info.sizeBytes && job.info.sizeBytes > 0
      ? 1 - job.outputSize / job.info.sizeBytes
      : null;

  const formula =
    isCore && job.phase !== "done"
      ? estimateOutputSize(job.info, job.params)
      : null;
  const estimate = job.sizeEstimate
    ? {
        bytes: job.sizeEstimate.bytes,
        rough: !job.sizeEstimate.exact,
        exact: job.sizeEstimate.exact,
      }
    : formula;

  return (
    <div
      draggable={draggable}
      tabIndex={isQueued ? 0 : -1}
      onDragStart={(e) => {
        if (!onReorderStart) return;
        e.dataTransfer.effectAllowed = "move";
        onReorderStart(job.uiId);
      }}
      onDragOver={(e) => {
        if (!draggable || !onReorderOver) return;
        e.preventDefault();
        setOver(true);
        onReorderOver(job.uiId);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onReorderDrop?.(job.uiId);
      }}
      className={`pop stagger-in ${staggerClass(startIndex)} rounded-2xl bg-white p-5 shadow-card ring-1 ring-neutral-200 transition-all duration-200 ${statusClass(job.phase)} ${
        over ? "ring-2 ring-brand-400 shadow-md" : ""
      } ${
        draggable ? "cursor-grab active:cursor-grabbing" : ""
      } hover:shadow-card-hover dark:bg-neutral-900 dark:ring-neutral-800`}
    >
      <div className="flex items-start gap-4">
        {thumb ? (
          <img
            src={thumb}
            alt=""
            className="h-11 w-11 shrink-0 rounded-xl object-cover ring-1 ring-neutral-200 dark:ring-neutral-700"
          />
        ) : (
          <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${badge.cls}`}>
            <Icon className="h-6 w-6" />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${badge.cls}`}>
              {typeLabel}
            </span>
            <span
              className="shrink-0 whitespace-nowrap rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500 ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:ring-neutral-700"
              title={t(`tool.${job.toolId}.desc`)}
            >
              {t(`tool.${job.toolId}.name`)}
            </span>
            <h3 className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100" title={job.info.path}>
              {basename(job.info.path)}
            </h3>
          </div>
          <p className="mt-1 truncate text-xs text-neutral-400 dark:text-neutral-500" title={meta(job)}>
            {isError ? job.error : meta(job)}
          </p>
          {(isQueued || isRunning) && estimate && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-600 dark:bg-brand-950/40 dark:text-brand-300">
                {t("job.estimate", {
                  size: formatBytes(estimate.bytes),
                  kind: estimate.rough
                    ? t("job.estimate.rough")
                    : t("job.estimate.exact"),
                })}
              </span>
              {isQueued && job.estimating && (
                <span className="flex items-center gap-1 text-[10px] text-neutral-400 dark:text-neutral-500">
                  <SpinnerIcon className="h-3 w-3 animate-spin" />
                  {t("job.estimating")}
                </span>
              )}
            </div>
          )}
        </div>

        <button
          onClick={() => onRemove(job.uiId)}
          className="shrink-0 rounded-lg p-1.5 text-neutral-300 transition hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          title={t("job.remove")}
          aria-label={t("job.remove")}
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      {isError && (
        <>
          <div className="mt-4 rounded-xl border border-error-100 bg-error-50 dark:border-error-900/50 dark:bg-error-950/30">
            <div className="px-4 pt-2.5">
              <div className="text-sm font-medium text-error-700 dark:text-error-400">
                {friendlyError(job.error, t)}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowLog(!showLog)}
                  className="text-[11px] font-medium text-error-500 underline-offset-2 hover:underline dark:text-error-400"
                >
                  {showLog ? t("job.hideLog") : t("job.viewLog")}
                </button>
                <button
                  onClick={handleCopyError}
                  className="ml-auto flex items-center gap-1 rounded-lg p-1.5 text-error-400 transition hover:bg-error-100 hover:text-error-600 dark:text-error-500 dark:hover:bg-error-900/50 dark:hover:text-error-400"
                  title={copied ? t("job.copied") : t("job.copyError")}
                  aria-label={copied ? t("job.copied") : t("job.copyError")}
                >
                  {copied ? (
                    <CheckCircleIcon className="h-4 w-4" />
                  ) : (
                    <CopyIcon className="h-4 w-4" />
                  )}
                </button>
              </div>
              {showLog && (
                <div className="mt-2 overflow-auto max-h-48 whitespace-pre-wrap rounded-lg bg-white/60 p-2 text-xs leading-relaxed text-neutral-600 dark:bg-neutral-900/60 dark:text-neutral-300">
                  {job.error ?? t("job.noLog")}
                </div>
              )}
            </div>
          </div>
          <button
            onClick={() => onRetry(job.uiId)}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm font-medium text-brand-700 transition hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
          >
            {t("job.retry")}
          </button>
        </>
      )}

      {isQueued && (
        <>
          {isEditable && onChangeParams && (
            <div className="mt-4 border-t border-neutral-100 pt-4 dark:border-neutral-700/60">
              <JobParamsEditor
                toolId={job.toolId}
                params={job.params}
                onChange={(p) => onChangeParams(job.uiId, p)}
              />
            </div>
          )}
          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={() => onStart(job.uiId)}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 dark:bg-brand-600"
            >
              <PlayIcon className="h-4 w-4" />
              {t("job.start")}
            </button>
            {onSyncParams && (
              <button
                onClick={() => onSyncParams(job.uiId)}
                className="rounded-xl border border-brand-200 bg-brand-50 px-3 py-2.5 text-sm font-medium text-brand-700 transition hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
                title={t("job.sync")}
              >
                {t("job.sync")}
              </button>
            )}
          </div>
        </>
      )}

      {isRunning && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
            <span className="flex items-center gap-1.5 text-brand-600 dark:text-brand-400">
              <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
              {t("job.processing")}
            </span>
            <span className="font-medium text-neutral-700 dark:text-neutral-300">
              {job.percent.toFixed(1)}%
              {job.startedAt
                ? (() => {
                    const elapsed = (Date.now() - job.startedAt) / 1000;
                    const eta = elapsed * (100 - job.percent) / Math.max(job.percent, 0.5);
                    return <span className="ml-2 text-neutral-400 dark:text-neutral-500">{formatEta(eta, t)}</span>;
                  })()
                : null}
            </span>
          </div>
          <div
            className="relative h-2 w-full overflow-hidden rounded-full bg-neutral-100 progress-tooltip-trigger dark:bg-neutral-800"
            title={job.startedAt ? getProgressDetail(job, t) : ""}
          >
            <div
              className="relative h-full rounded-full brand-progress transition-all duration-300"
              style={{ width: `${job.percent}%` }}
            >
              <div className="absolute inset-0 rounded-full brand-shimmer" />
            </div>
            {job.startedAt && (
              <div className="absolute left-1/2 top-6 -translate-x-1/2 z-10 hidden rounded-lg bg-neutral-900 px-3 py-2 text-xs text-white shadow-lg whitespace-nowrap progress-tooltip dark:bg-neutral-700">
                <div className="font-medium">{getProgressDetail(job, t)}</div>
                <div className="mt-0.5 text-neutral-400">
                  <span>{job.info.sizeBytes ? formatBytes(job.info.sizeBytes) : "—"}</span>
                  {job.outputSize != null ? <span> → {formatBytes(job.outputSize)}</span> : ""}
                </div>
                <div className="absolute left-1/2 -top-1.5 -translate-x-1/2 h-2 w-2 rotate-45 bg-neutral-900 dark:bg-neutral-700" />
              </div>
            )}
          </div>
          <div className="mt-3 flex justify-end">
            <button
              onClick={() => onCancel(job.uiId)}
              className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              {t("confirm.cancel")}
            </button>
          </div>
        </div>
      )}

      {isDone && (
        <div className="mt-4 flex items-center justify-between rounded-xl bg-success-50 px-4 py-3 ring-1 ring-success-100 dark:bg-success-950/20 dark:ring-success-900/50">
          <div className="flex items-center gap-2 text-sm text-neutral-800 dark:text-neutral-200">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-500 text-white">
              <CheckIcon className="h-3 w-3" />
            </span>
            <span>
              {t("job.done", {
                size: formatBytes(job.outputSize ?? 0),
                saved:
                  savings != null && savings > 0
                    ? ` (−${(savings * 100).toFixed(0)}%)`
                    : "",
              })}
            </span>
          </div>
          {job.output && (
            <button
              onClick={() => onOpenFolder(job.output!)}
              className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-brand-700 shadow-sm ring-1 ring-brand-200 transition hover:bg-brand-50 dark:bg-neutral-800 dark:text-brand-300 dark:ring-neutral-700 dark:hover:bg-neutral-700"
            >
              <FolderIcon className="h-3.5 w-3.5" />
              {t("job.open")}
            </button>
          )}
        </div>
      )}

      {job.phase === "cancelled" && (
        <div className="mt-4 rounded-xl bg-neutral-50 px-4 py-2.5 text-sm text-neutral-400 ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-500 dark:ring-neutral-700">
          {t("job.cancelled")}
          <button
            onClick={() => onRetry(job.uiId)}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2 text-sm font-medium text-brand-700 transition hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
          >
            {t("job.retry")}
          </button>
        </div>
      )}

      {job.phase === "skipped" && (
        <div className="mt-4 rounded-xl bg-neutral-50 px-4 py-2.5 text-sm text-neutral-500 ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:ring-neutral-700">
          {t("job.skipped")}
        </div>
      )}
    </div>
  );
}