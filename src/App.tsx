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

const MAX_CONCURRENT = 2;

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
        startTime: undefined,
        duration: undefined,
        extractAudio: false,
        extractFormat: "mp3",
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
  const [outputSuffix, setOutputSuffix] = useState<string>("_mediapress");
  const [dark, setDark] = useState<boolean>(() => {
    try {
      return localStorage.getItem("mediapress.dark") === "1";
    } catch {
      return false;
    }
  });
  const counter = useRef(0);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("mediapress.dark", dark ? "1" : "0");
    } catch {
      // ignore
    }
  }, [dark]);
  const jobsRef = useRef<Job[]>([]);
  const pendingQueue = useRef<string[]>([]);
  const runningCount = useRef(0);
  jobsRef.current = jobs;

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
        runningCount.current = Math.max(0, runningCount.current - 1);
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
        if (pendingQueue.current.length > 0 && runningCount.current < MAX_CONCURRENT) {
          const next = pendingQueue.current.shift()!;
          void startOne(next);
        }
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
    const job = jobsRef.current.find((j) => j.uiId === uiId);
    if (!job || job.phase !== "queued") return;
    setError(null);
    try {
      const rustId = await startJob({
        input: job.info.path,
        mediaType: job.info.mediaType,
        params: job.params,
        outputDir: outputDir ?? undefined,
        outputSuffix: outputSuffix || "_mediapress",
      });
      runningCount.current += 1;
      setJobs((prev) =>
        prev.map((j) =>
          j.uiId === uiId
            ? { ...j, rustId, percent: 0, phase: "running", startedAt: Date.now() }
            : j
        )
      );
    } catch (err) {
      setError(`启动失败: ${String(err)}`);
    }
  }

  async function startAll() {
    const queued = jobsRef.current.filter((j) => j.phase === "queued");
    pendingQueue.current = queued.map((j) => j.uiId);
    while (runningCount.current < MAX_CONCURRENT && pendingQueue.current.length > 0) {
      const next = pendingQueue.current.shift()!;
      await startOne(next);
    }
  }

  function cancelOne(uiId: string) {
    const job = jobsRef.current.find((j) => j.uiId === uiId);
    if (job?.rustId) cancelJob(job.rustId);
    setJobs((prev) => prev.map((j) => (j.uiId === uiId ? { ...j, phase: "cancelled" } : j)));
  }

  function removeOne(uiId: string) {
    setJobs((prev) => prev.filter((j) => j.uiId !== uiId));
  }

  function retryOne(uiId: string) {
    setJobs((prev) =>
      prev.map((j) =>
        j.uiId === uiId && j.phase === "error"
          ? { ...j, phase: "queued", error: null, outputSize: null, startedAt: null }
          : j
      )
    );
  }

  function retryAllFailed() {
    setJobs((prev) =>
      prev.map((j) =>
        j.phase === "error"
          ? { ...j, phase: "queued", error: null, outputSize: null, startedAt: null }
          : j
      )
    );
  }

  function changeParams(uiId: string, params: JobParams) {
    setJobs((prev) => prev.map((j) => (j.uiId === uiId ? { ...j, params } : j)));
  }

  function syncParamsToAll(uiId: string) {
    const source = jobsRef.current.find((j) => j.uiId === uiId);
    if (!source || source.phase !== "queued") return;
    setJobs((prev) =>
      prev.map((j) =>
        j.phase === "queued" && j.info.mediaType === source.info.mediaType
          ? { ...j, params: source.params }
          : j
      )
    );
  }

  function clearFinished() {
    setJobs((prev) =>
      prev.filter((j) => j.phase !== "done" && j.phase !== "error" && j.phase !== "cancelled")
    );
  }

  const queuedCount = jobs.filter((j) => j.phase === "queued").length;
  const doneCount = jobs.filter((j) => j.phase === "done").length;
  const failedCount = jobs.filter((j) => j.phase === "error").length;
  const runningVal = jobs.filter((j) => j.phase === "running").length;

  const doneJobs = jobs.filter((j) => j.phase === "done" && j.outputSize != null);
  const totalIn = doneJobs.reduce((a, j) => a + (j.info.sizeBytes || 0), 0);
  const totalOut = doneJobs.reduce((a, j) => a + (j.outputSize || 0), 0);
  const overall = totalIn > 0 ? 1 - totalOut / totalIn : 0;
  const allDone = jobs.length > 0 && jobs.every((j) => j.phase === "done");

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-slate-200/70 bg-white/70 backdrop-blur dark:border-slate-700/60 dark:bg-slate-900/70">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-6 py-3.5">
          <LogoIcon className="h-9 w-9" />
          <div className="leading-tight">
            <div className="text-base font-semibold text-slate-800 dark:text-slate-100">MediPress</div>
            <div className="text-xs text-slate-400 dark:text-slate-500">本地媒体压缩与转换</div>
          </div>
          <button
            onClick={() => setDark((v) => !v)}
            className="ml-auto rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            title="切换深色 / 浅色模式"
          >
            {dark ? "浅色" : "深色"}
          </button>
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-600 ring-1 ring-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20">
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
              : "border-slate-300 bg-white/60 hover:border-indigo-300 hover:bg-indigo-50/30 dark:border-slate-600 dark:bg-slate-800/40 dark:hover:border-indigo-400 dark:hover:bg-slate-800/60"
          }`}
        >
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-200">
            <UploadIcon className="h-7 w-7" />
          </div>
          <p className="text-base font-medium text-slate-700 dark:text-slate-100">
            点击选择文件，或将文件拖拽到此处
          </p>
          <p className="mt-1 text-sm text-slate-400 dark:text-slate-500">支持视频、图片、音频 · 可批量添加</p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          <FolderIcon className="h-4 w-4 text-slate-400" />
          <span>输出到</span>
          <span className="max-w-[260px] truncate font-medium text-slate-600 dark:text-slate-300">
            {outputDir ?? "与源文件相同目录"}
          </span>
          <button
            onClick={chooseOutput}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
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
          <span className="ml-1 text-slate-400 dark:text-slate-500">文件名后缀</span>
          <input
            value={outputSuffix}
            onChange={(e) => setOutputSuffix(e.target.value)}
            placeholder="_mediapress"
            className="w-28 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 shadow-sm transition focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:focus:border-indigo-400"
          />
        </div>

        {error && (
          <div className="mt-4 rounded-xl bg-red-50 px-4 py-2.5 text-sm text-red-600 ring-1 ring-red-100 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/20">
            {error}
          </div>
        )}

        {jobs.length > 0 && (
          <div className="mt-6 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <span className="font-medium text-slate-700 dark:text-slate-200">{jobs.length}</span> 个任务
              {doneCount > 0 && (
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
                  {doneCount} 已完成
                </span>
              )}
              {runningVal > 0 && (
                <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
                  {runningVal} 处理中
                </span>
              )}
            </div>
            {queuedCount > 0 && (
              <button
                onClick={startAll}
                className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600"
              >
                全部开始 ({queuedCount})
              </button>
            )}
            {jobs.length > doneCount && (
              <button
                onClick={clearFinished}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
                title="移除已完成、失败、已取消的任务"
              >
                清除已完成
              </button>
            )}
            {failedCount > 0 && (
              <button
                onClick={retryAllFailed}
                className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-600 transition hover:bg-amber-100"
                title="将所有失败任务重新加入队列"
              >
                重试失败 ({failedCount})
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
              onSyncParams={syncParamsToAll}
              onRetry={retryOne}
            />
          ))}
        </div>

        {jobs.length === 0 && (
          <p className="mt-10 text-center text-sm text-slate-400 dark:text-slate-500">
            还没有任务。添加文件后，选择压缩参数即可开始。
          </p>
        )}
      </main>
    </div>
  );
}
