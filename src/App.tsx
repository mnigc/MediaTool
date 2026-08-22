import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  cancelJob,
  formatBytes,
  onDone,
  onProgress,
  openOutputFolder,
  probeFile,
  startJob,
} from "./lib/tauri";
import type {
  AudioParams,
  ImageParams,
  Job,
  JobParams,
  MediaInfo,
  VideoParams,
} from "./types";
import JobCard from "./components/JobCard";
import { CheckIcon, FolderIcon, LogoIcon, UploadIcon, XIcon } from "./components/icons";

function defaultParams(info: MediaInfo): JobParams {
  switch (info.mediaType) {
    case "video":
      return {
        videoCodec: "libx264",
        qualityMode: "crf",
        crf: 28,
        resolution: "original",
        audioCodec: "aac",
        audioBitrateKbps: 128,
        format: "mp4",
        preset: "medium",
      } satisfies VideoParams;
    case "image":
      return { format: "webp", quality: 80 } satisfies ImageParams;
    case "audio":
      return { format: "mp3", bitrateKbps: 128 } satisfies AudioParams;
    default:
      return { format: "mp4", quality: 80 } as JobParams;
  }
}

export default function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const counter = useRef(0);

  useEffect(() => {
    const unsubs: Array<Promise<() => void>> = [];
    unsubs.push(
      onProgress((e) => {
        setJobs((prev) =>
          prev.map((j) => (j.rustId === e.id ? { ...j, percent: e.percent, phase: "running" } : j))
        );
      })
    );
    unsubs.push(
      onDone((e) => {
        setJobs((prev) =>
          prev.map((j) =>
            j.rustId === e.id
              ? {
                  ...j,
                  phase: e.ok ? "done" : "error",
                  output: e.output ?? null,
                  error: e.error ?? null,
                  outputSize: e.outputSize ?? null,
                }
              : j
          )
        );
      })
    );

    let dropUnlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          addFiles(event.payload.paths);
        }
      })
      .then((fn) => {
        dropUnlisten = fn;
      });

    return () => {
      unsubs.forEach((p) => p.then((fn) => fn()));
      dropUnlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addFiles(paths: string[]) {
    setError(null);
    for (const p of paths) {
      try {
        const info = await probeFile(p);
        const params = defaultParams(info);
        counter.current += 1;
        const job: Job = {
          uiId: `ui-${counter.current}`,
          info,
          params,
          percent: 0,
          phase: info.mediaType === "unknown" ? "error" : "queued",
          output: null,
          outputSize: null,
        };
        if (info.mediaType === "unknown") job.error = "无法识别的媒体类型";
        setJobs((prev) => [...prev, job]);
      } catch (err) {
        setError(`无法读取文件: ${String(err)}`);
      }
    }
  }

  async function pickFiles() {
    const selected = await open({ multiple: true, title: "选择媒体文件" });
    if (selected && !Array.isArray(selected)) addFiles([selected]);
    else if (Array.isArray(selected)) addFiles(selected);
  }

  async function chooseOutput() {
    const d = await open({ directory: true, title: "选择输出目录" });
    if (d && !Array.isArray(d)) setOutputDir(d);
  }

  async function startOne(uiId: string) {
    const job = jobs.find((j) => j.uiId === uiId);
    if (!job) return;
    setError(null);
    try {
      const rustId = await startJob({
        input: job.info.path,
        mediaType: job.info.mediaType,
        params: job.params,
        outputDir: outputDir ?? undefined,
      });
      setJobs((prev) =>
        prev.map((j) => (j.uiId === uiId ? { ...j, rustId, percent: 0, phase: "running" } : j))
      );
    } catch (err) {
      setError(`启动失败: ${String(err)}`);
    }
  }

  async function startAll() {
    const queued = jobs.filter((j) => j.phase === "queued");
    for (const j of queued) await startOne(j.uiId);
  }

  function cancelOne(uiId: string) {
    const job = jobs.find((j) => j.uiId === uiId);
    if (job?.rustId) cancelJob(job.rustId);
    setJobs((prev) => prev.map((j) => (j.uiId === uiId ? { ...j, phase: "cancelled" } : j)));
  }

  function removeOne(uiId: string) {
    setJobs((prev) => prev.filter((j) => j.uiId !== uiId));
  }

  function changeParams(uiId: string, params: JobParams) {
    setJobs((prev) => prev.map((j) => (j.uiId === uiId ? { ...j, params } : j)));
  }

  const queuedCount = jobs.filter((j) => j.phase === "queued").length;
  const doneCount = jobs.filter((j) => j.phase === "done").length;

  const doneJobs = jobs.filter((j) => j.phase === "done" && j.outputSize != null);
  const totalIn = doneJobs.reduce((a, j) => a + (j.info.sizeBytes || 0), 0);
  const totalOut = doneJobs.reduce((a, j) => a + (j.outputSize || 0), 0);
  const overall = totalIn > 0 ? 1 - totalOut / totalIn : 0;
  const allDone = jobs.length > 0 && jobs.every((j) => j.phase === "done");

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-slate-200/70 bg-white/70 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-6 py-3.5">
          <LogoIcon className="h-9 w-9" />
          <div className="leading-tight">
            <div className="text-base font-semibold text-slate-800">MediPress</div>
            <div className="text-xs text-slate-400">本地媒体压缩与转换</div>
          </div>
          <span className="ml-auto rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-600 ring-1 ring-emerald-100">
            本地处理 · 文件不上传
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        <div
          onClick={pickFiles}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
          }}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed px-6 py-14 text-center transition ${
            dragOver
              ? "border-indigo-400 bg-indigo-50/60"
              : "border-slate-300 bg-white/60 hover:border-indigo-300 hover:bg-indigo-50/30"
          }`}
        >
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-200">
            <UploadIcon className="h-7 w-7" />
          </div>
          <p className="text-base font-medium text-slate-700">
            点击选择文件，或将文件拖拽到此处
          </p>
          <p className="mt-1 text-sm text-slate-400">支持视频、图片、音频 · 可批量添加</p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-500">
          <FolderIcon className="h-4 w-4 text-slate-400" />
          <span>输出到</span>
          <span className="max-w-[260px] truncate font-medium text-slate-600">
            {outputDir ?? "与源文件相同目录"}
          </span>
          <button
            onClick={chooseOutput}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
          >
            更改
          </button>
          {outputDir && (
            <button
              onClick={() => setOutputDir(null)}
              className="rounded-lg p-1 text-slate-300 transition hover:bg-slate-50 hover:text-slate-500"
              title="重置为源目录"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {error && (
          <div className="mt-4 rounded-xl bg-red-50 px-4 py-2.5 text-sm text-red-600 ring-1 ring-red-100">
            {error}
          </div>
        )}

        {jobs.length > 0 && (
          <div className="mt-6 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span className="font-medium text-slate-700">{jobs.length}</span> 个任务
              {doneCount > 0 && (
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-600">
                  {doneCount} 已完成
                </span>
              )}
            </div>
            {queuedCount > 0 && (
              <button
                onClick={startAll}
                className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-700"
              >
                全部开始 ({queuedCount})
              </button>
            )}
          </div>
        )}

        {allDone && (
          <div className="mt-6 flex items-center gap-3 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 px-5 py-4 text-white shadow-sm">
            <CheckIcon className="h-6 w-6 shrink-0" />
            <div>
              <div className="text-sm font-semibold">全部完成</div>
              <div className="text-xs text-emerald-50">
                共 {jobs.length} 个任务 · 节省 {(overall * 100).toFixed(0)}% 空间（
                {formatBytes(totalIn - totalOut)}）
              </div>
            </div>
          </div>
        )}

        <div className="mt-4 space-y-4">
          {jobs.map((job) => (
            <JobCard
              key={job.uiId}
              job={job}
              onStart={startOne}
              onCancel={cancelOne}
              onRemove={removeOne}
              onOpenFolder={openOutputFolder}
              onChangeParams={changeParams}
            />
          ))}
        </div>

        {jobs.length === 0 && (
          <p className="mt-10 text-center text-sm text-slate-400">
            还没有任务。添加文件后，选择压缩参数即可开始。
          </p>
        )}
      </main>
    </div>
  );
}
