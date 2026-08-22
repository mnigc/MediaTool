import type { Job, JobParams } from "../types";
import OptionsPanel from "./OptionsPanel";
import {
  CheckIcon,
  FilmIcon,
  FolderIcon,
  ImageIcon,
  MusicIcon,
  PlayIcon,
  SpinnerIcon,
  XIcon,
} from "./icons";
import { formatBytes } from "../lib/tauri";

type Props = {
  job: Job;
  onStart: (uiId: string) => void;
  onCancel: (uiId: string) => void;
  onRemove: (uiId: string) => void;
  onOpenFolder: (path: string) => void;
  onChangeParams: (uiId: string, params: JobParams) => void;
  onSyncParams: (uiId: string) => void;
  onRetry: (uiId: string) => void;
};

const TypeBadge: Record<string, { label: string; cls: string; Icon: typeof FilmIcon }> = {
  video: { label: "视频", cls: "bg-indigo-50 text-indigo-600 ring-indigo-100", Icon: FilmIcon },
  image: { label: "图片", cls: "bg-sky-50 text-sky-600 ring-sky-100", Icon: ImageIcon },
  audio: { label: "音频", cls: "bg-amber-50 text-amber-600 ring-amber-100", Icon: MusicIcon },
};

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1);
}

function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "";
  const s = Math.round(seconds);
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return mm > 0 ? `约 ${mm}:${ss} 剩余` : `约 ${ss}s 剩余`;
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
  onStart,
  onCancel,
  onRemove,
  onOpenFolder,
  onChangeParams,
  onSyncParams,
  onRetry,
}: Props) {
  const badge = TypeBadge[job.info.mediaType] ?? TypeBadge.video;
  const Icon = badge.Icon;
  const isError = job.phase === "error";
  const isDone = job.phase === "done";
  const isRunning = job.phase === "running";
  const isQueued = job.phase === "queued";

  const savings =
    job.outputSize != null && job.info.sizeBytes && job.info.sizeBytes > 0
      ? 1 - job.outputSize / job.info.sizeBytes
      : null;

  return (
    <div className="pop rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100 dark:bg-slate-800 dark:ring-slate-700/60">
      <div className="flex items-start gap-4">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${badge.cls}`}>
          <Icon className="h-6 w-6" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${badge.cls}`}>
              {badge.label}
            </span>
            <h3 className="truncate text-sm font-medium text-slate-800 dark:text-slate-100" title={job.info.path}>
              {basename(job.info.path)}
            </h3>
          </div>
          <p className="mt-1 truncate text-xs text-slate-400 dark:text-slate-500" title={meta(job)}>
            {isError ? job.error : meta(job)}
          </p>
        </div>

        <button
          onClick={() => onRemove(job.uiId)}
          className="shrink-0 rounded-lg p-1.5 text-slate-300 transition hover:bg-slate-50 hover:text-slate-500 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-slate-300"
          title="移除"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      {isError && (
        <>
          <div className="mt-4 rounded-xl bg-red-50 px-4 py-2.5 text-sm text-red-600 ring-1 ring-red-100 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/20">
            {job.error}
          </div>
          <button
            onClick={() => onRetry(job.uiId)}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-red-200 bg-white px-4 py-2.5 text-sm font-medium text-red-500 transition hover:bg-red-50 dark:border-red-500/30 dark:bg-slate-800 dark:text-red-300 dark:hover:bg-red-500/10"
          >
            重试
          </button>
        </>
      )}

      {isQueued && (
        <>
          <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-700/60">
            <OptionsPanel
              mediaType={job.info.mediaType}
              params={job.params}
              onChange={(p) => onChangeParams(job.uiId, p)}
            />
          </div>
          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={() => onStart(job.uiId)}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-indigo-200 transition hover:opacity-95"
            >
              <PlayIcon className="h-4 w-4" />
              开始压缩
            </button>
            <button
              onClick={() => onSyncParams(job.uiId)}
              className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-500 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700"
              title="将当前参数同步到所有同类型待处理任务"
            >
              同步参数
            </button>
          </div>
        </>
      )}

      {isRunning && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span className="flex items-center gap-1.5 text-indigo-500">
              <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
              处理中…
            </span>
            <span className="font-medium text-slate-600">
              {job.percent}%
              {job.startedAt
                ? (() => {
                    const elapsed = (Date.now() - job.startedAt) / 1000;
                    const eta = elapsed * (100 - job.percent) / Math.max(job.percent, 0.5);
                    return <span className="ml-2 text-slate-400">{formatEta(eta)}</span>;
                  })()
                : null}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700/60">
            <div
              className="relative h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500"
              style={{ width: `${job.percent}%` }}
            >
              <div className="shimmer absolute inset-0 rounded-full" />
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <button
              onClick={() => onCancel(job.uiId)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {isDone && (
        <div className="mt-4 flex items-center justify-between rounded-xl bg-emerald-50 px-4 py-3 ring-1 ring-emerald-100 dark:bg-emerald-500/10 dark:ring-emerald-500/20">
          <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
            <CheckIcon className="h-4 w-4" />
            <span>
              完成 · 输出 {formatBytes(job.outputSize ?? 0)}
              {savings != null && savings > 0 && (
                <span className="ml-1 font-medium text-emerald-600 dark:text-emerald-400">
                  (−{(savings * 100).toFixed(0)}%)
                </span>
              )}
            </span>
          </div>
          {job.output && (
            <button
              onClick={() => onOpenFolder(job.output!)}
              className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50 dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-600 dark:hover:bg-slate-600"
            >
              <FolderIcon className="h-3.5 w-3.5" />
              打开
            </button>
          )}
        </div>
      )}

      {job.phase === "cancelled" && (
        <div className="mt-4 rounded-xl bg-slate-50 px-4 py-2.5 text-sm text-slate-400 ring-1 ring-slate-100 dark:bg-slate-700/40 dark:text-slate-400 dark:ring-slate-700">
          已取消
        </div>
      )}
    </div>
  );
}
