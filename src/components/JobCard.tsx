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
    <div className="pop rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <div className="flex items-start gap-4">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${badge.cls}`}>
          <Icon className="h-6 w-6" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${badge.cls}`}>
              {badge.label}
            </span>
            <h3 className="truncate text-sm font-medium text-slate-800" title={job.info.path}>
              {basename(job.info.path)}
            </h3>
          </div>
          <p className="mt-1 truncate text-xs text-slate-400" title={meta(job)}>
            {isError ? job.error : meta(job)}
          </p>
        </div>

        <button
          onClick={() => onRemove(job.uiId)}
          className="shrink-0 rounded-lg p-1.5 text-slate-300 transition hover:bg-slate-50 hover:text-slate-500"
          title="移除"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      {isError && (
        <div className="mt-4 rounded-xl bg-red-50 px-4 py-2.5 text-sm text-red-600 ring-1 ring-red-100">
          {job.error}
        </div>
      )}

      {isQueued && (
        <>
          <div className="mt-4 border-t border-slate-100 pt-4">
            <OptionsPanel
              mediaType={job.info.mediaType}
              params={job.params}
              onChange={(p) => onChangeParams(job.uiId, p)}
            />
          </div>
          <button
            onClick={() => onStart(job.uiId)}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-indigo-200 transition hover:opacity-95"
          >
            <PlayIcon className="h-4 w-4" />
            开始压缩
          </button>
        </>
      )}

      {isRunning && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between text-xs text-slate-500">
            <span className="flex items-center gap-1.5 text-indigo-500">
              <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
              处理中…
            </span>
            <span className="font-medium text-slate-600">{job.percent}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
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
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-50"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {isDone && (
        <div className="mt-4 flex items-center justify-between rounded-xl bg-emerald-50 px-4 py-3 ring-1 ring-emerald-100">
          <div className="flex items-center gap-2 text-sm text-emerald-700">
            <CheckIcon className="h-4 w-4" />
            <span>
              完成 · 输出 {formatBytes(job.outputSize ?? 0)}
              {savings != null && savings > 0 && (
                <span className="ml-1 font-medium text-emerald-600">
                  (−{(savings * 100).toFixed(0)}%)
                </span>
              )}
            </span>
          </div>
          {job.output && (
            <button
              onClick={() => onOpenFolder(job.output!)}
              className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50"
            >
              <FolderIcon className="h-3.5 w-3.5" />
              打开
            </button>
          )}
        </div>
      )}

      {job.phase === "cancelled" && (
        <div className="mt-4 rounded-xl bg-slate-50 px-4 py-2.5 text-sm text-slate-400 ring-1 ring-slate-100">
          已取消
        </div>
      )}
    </div>
  );
}
