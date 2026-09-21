import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ytdlpProbe } from "../lib/engine";
import { formatBytes, openOutputFolder } from "../lib/engine";
import { canRevealInFolder } from "../lib/shell";
import { useI18n } from "../i18n";
import { useDownloads } from "../contexts/DownloadCenter";
import { useUploads } from "../contexts/UploadCenter";
import { CopyIcon, FilmIcon, FolderIcon, MusicIcon, XIcon } from "../components/icons";
import Select from "../components/Select";
import UploadTargetChips from "../components/UploadTargetChips";
import { Button } from "../components/ui";
import EmptyState from "../components/EmptyState";
import { useConfirm } from "../components/ConfirmDialog";
import SiteStrip from "./SiteStrip";
import SaveLocationBar from "./SaveLocationBar";
import { ConfigSidebar, NetworkSection, PipelineChips, SidebarSection } from "./Sidebar";
import { pipelineById, pipelineDisplayName } from "../workflow/pipelines";
import type { DownloadTask } from "../contexts/DownloadCenter";

/* ── helpers ────────────────────────────────────────────────────── */

function fmtDuration(secs?: number | null): string {
  if (!secs || secs <= 0) return "";
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

interface ProbeResult {
  title: string;
  duration?: number | null;
  uploader?: string | null;
  thumbnail?: string | null;
  isLive: boolean;
}

function extractProbe(json: Record<string, unknown>): ProbeResult | null {
  const type = json._type;
  if (type === "playlist") {
    const entries = json.entries as Record<string, unknown>[] | undefined;
    const first = entries?.[0];
    if (!first) return null;
    json = first;
  }
  const title = typeof json.title === "string" ? json.title : "";
  if (!title) return null;
  return {
    title,
    duration: typeof json.duration === "number" ? json.duration : null,
    uploader: typeof json.uploader === "string" ? json.uploader : null,
    thumbnail:
      typeof json.thumbnail === "string" ? json.thumbnail : null,
    isLive:
      json.is_live === true ||
      (typeof json.live_status === "string" && json.live_status === "is_live"),
  };
}

/* ── slim hint: only shown when the engine can't do its job ────── */

function YtdlpHint() {
  const { t } = useI18n();
  const dl = useDownloads();
  const s = dl.ytdlp;
  if (!s) return null;
  if (!s.installed) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-warning-100 bg-warning-50 px-4 py-2.5 text-sm text-warning-700 dark:border-warning-900/50 dark:bg-warning-950/30 dark:text-warning-400">
        <span className="flex-1">{t("dl.missingGoAbout")}</span>
        <button
          onClick={() => void dl.installYtdlp()}
          disabled={dl.ytdlpInstalling}
          className="rounded-lg bg-warning-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-warning-700 disabled:opacity-50"
        >
          {dl.ytdlpInstalling ? t("dl.installing") : t("dl.install")}
        </button>
      </div>
    );
  }
  if (!s.ffmpegFound) {
    return (
      <div className="mb-4 rounded-xl border border-warning-100 bg-warning-50 px-4 py-2.5 text-sm text-warning-700 dark:border-warning-900/50 dark:bg-warning-950/30 dark:text-warning-400">
        {t("dl.noFfmpeg")}
      </div>
    );
  }
  return null;
}

/* ── quality / pipeline selectors ───────────────────────────────── */

const QUALITIES = ["best", "2160p", "1080p", "720p", "480p", "audio"] as const;

/** Audio-only containers have no frames to grab, so the card uses a note icon. */
const AUDIO_EXTS = /\.(mp3|m4a|opus|flac|wav|aac|ogg)$/i;

/* ── new download form ──────────────────────────────────────────── */

/** Split free-form textarea content into unique URLs (newline / space /
 *  comma separated). */
function parseUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\s,，]+/)) {
    const u = raw.trim();
    if (!u || !/^https?:\/\//i.test(u) || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function NewDownloadForm({
  quality,
  audioFormat,
  pipelineIds,
  uploadTo,
}: {
  quality: string;
  audioFormat: string;
  pipelineIds: string[];
  uploadTo: string[];
}) {
  const { t } = useI18n();
  const dl = useDownloads();
  const [urlText, setUrlText] = useState("");
  const urls = parseUrls(urlText);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [starting, setStarting] = useState(false);
  const probeToken = useRef(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the pasted lines, capped at 240px (max-h below) then scroll.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [urlText]);

  const doProbe = useCallback((u: string) => {
    const token = ++probeToken.current;
    if (!u.trim()) {
      setProbe(null);
      // Clearing the box bumps the token, so an in-flight probe's .finally
      // will never reset this flag — reset it here or the spinner sticks.
      setProbing(false);
      return;
    }
    setProbing(true);
    ytdlpProbe(u.trim(), {
      cookiesFile: dl.settings.cookiesFile || null,
      cookiesText: dl.settings.cookiesText || null,
      proxy: dl.settings.proxy || null,
    })
      .then((json) => {
        if (probeToken.current !== token) return;
        setProbe(extractProbe(json));
      })
      .catch(() => {
        if (probeToken.current === token) setProbe(null);
      })
      .finally(() => {
        if (probeToken.current === token) setProbing(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dl.settings.cookiesFile, dl.settings.cookiesText, dl.settings.proxy]);

  // Debounced auto-probe — only meaningful for a single link; batches start
  // without probing so a big paste doesn't fire N requests up front.
  useEffect(() => {
    const timer = setTimeout(() => doProbe(urls.length === 1 ? urls[0] : ""), 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlText, doProbe]);

  const disabled = !dl.ytdlp?.installed || urls.length === 0 || starting || !dl.settings.outputDir;

  const start = async () => {
    setStarting(true);
    try {
      for (const u of urls) {
        // One failed link leaves an errored card; the rest keep going.
        await dl
          .startDownload({
            url: u,
            title: urls.length === 1 ? (probe?.title ?? null) : null,
            thumbnail: urls.length === 1 ? (probe?.thumbnail ?? null) : null,
            quality,
            audioFormat: quality === "audio" ? audioFormat : null,
            pipelineIds,
            uploadTo,
          })
          .catch(() => {});
      }
      setUrlText("");
      setProbe(null);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="mb-6 rounded-2xl bg-white p-4 shadow-card ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
      <div className="flex gap-2">
        <textarea
          ref={taRef}
          value={urlText}
          onChange={(e) => setUrlText(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/⌘+Enter submits, plain Enter stays a newline.
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !disabled) {
              e.preventDefault();
              void start();
            }
          }}
          rows={2}
          placeholder={t("dl.urlPlaceholder")}
          className="max-h-60 min-w-0 flex-1 resize-none overflow-y-auto rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm leading-relaxed text-neutral-800 placeholder:text-neutral-400 focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:border-brand-500"
        />
        <Button
          variant="primary"
          onClick={() => void start()}
          disabled={disabled}
          className="self-start"
        >
          {starting
            ? t("dl.starting")
            : urls.length > 1
              ? t("dl.batchDownload", { n: urls.length })
              : t("dl.download")}
        </Button>
      </div>

      {urls.length > 1 ? (
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          {t("dl.batchDetected", { n: urls.length })}
        </p>
      ) : (probing || probe) && (
        <div className="mt-2 flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          {probing ? (
            <>
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
              {t("dl.probing")}
            </>
          ) : (
            probe && (
              <>
                <span className="truncate font-medium text-neutral-700 dark:text-neutral-200">
                  {probe.title}
                </span>
                {probe.uploader && <span className="truncate">· {probe.uploader}</span>}
                {probe.duration != null && <span>· {fmtDuration(probe.duration)}</span>}
                {probe.isLive && (
                  <span className="rounded-full bg-error-50 px-2 py-0.5 text-[10px] font-semibold text-error-600 dark:bg-error-950/40 dark:text-error-400">
                    LIVE
                  </span>
                )}
              </>
            )
          )}
        </div>
      )}
    </div>
  );
}

/* ── expandable error box ───────────────────────────────────────── */

function ErrorBox({ text }: { text: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="mt-2 rounded-lg bg-error-50 px-2.5 py-1.5 dark:bg-error-950/30">
      <div className="mb-1 flex items-center justify-end gap-1">
        <button
          onClick={() => void copy()}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-error-500/80 transition hover:bg-error-100 hover:text-error-600 dark:hover:bg-error-900/40"
        >
          <CopyIcon className="h-3 w-3" />
          {copied ? t("dl.copied") : t("job.copyError")}
        </button>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="rounded px-1.5 py-0.5 text-[10px] font-medium text-error-500/80 transition hover:bg-error-100 hover:text-error-600 dark:hover:bg-error-900/40"
        >
          {expanded ? t("dl.collapse") : t("dl.expand")}
        </button>
      </div>
      <p
        className={`whitespace-pre-wrap break-all text-[11px] leading-relaxed text-error-600 dark:text-error-400 ${
          expanded ? "" : "line-clamp-3"
        }`}
      >
        {text}
      </p>
    </div>
  );
}

/* ── task cards ─────────────────────────────────────────────────── */

function PhaseBadge({ task }: { task: DownloadTask }) {
  const { t } = useI18n();
  const map: Record<string, string> = {
    running: "bg-brand-50 text-brand-600 dark:bg-brand-950/40 dark:text-brand-400",
    done: "bg-success-50 text-success-600 dark:bg-success-950/40 dark:text-success-400",
    error: "bg-error-50 text-error-600 dark:bg-error-950/40 dark:text-error-400",
    cancelled: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
  };
  const label: Record<string, string> = {
    running: task.postprocessing ? t("dl.postprocessing") : t("dl.phase.running"),
    done: task.limitReached ? t("dl.limitReached") : t("dl.phase.done"),
    error: t("dl.phase.error"),
    cancelled: t("dl.phase.cancelled"),
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${map[task.phase]}`}
    >
      {task.phase === "running" && !task.postprocessing && (
        <span className="mr-1 h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500 dark:bg-brand-400" />
      )}
      {label[task.phase]}
    </span>
  );
}

/** 16:9 cover with graceful fallback when the probe had no thumbnail or the
 *  remote image fails to load (private links, hotlink protection…). */
function Thumb({
  src,
  live,
  audio,
}: {
  src?: string | null;
  live?: boolean;
  audio?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <div className="relative flex h-14 w-24 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-neutral-100 to-neutral-200/70 ring-1 ring-neutral-200/70 dark:from-neutral-800 dark:to-neutral-800/40 dark:ring-neutral-700/60">
        {audio ? (
          <MusicIcon className="h-5 w-5 text-neutral-400 dark:text-neutral-600" />
        ) : (
          <FilmIcon className="h-5 w-5 text-neutral-400 dark:text-neutral-600" />
        )}
        {live && (
          <span className="absolute left-1 top-1 rounded bg-error-500 px-1 py-px text-[9px] font-bold leading-none text-white">
            LIVE
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-xl ring-1 ring-neutral-200/70 dark:ring-neutral-700/60">
      <img
        src={src}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
        className="h-full w-full object-cover"
      />
      {live && (
        <span className="absolute left-1 top-1 rounded bg-error-500 px-1 py-px text-[9px] font-bold leading-none text-white">
          LIVE
        </span>
      )}
    </div>
  );
}

function CardButton({
  onClick,
  children,
  danger,
}: {
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition ${
        danger
          ? "text-neutral-400 hover:bg-error-50 hover:text-error-500 dark:hover:bg-error-950/40"
          : "border border-neutral-200 text-neutral-600 hover:border-brand-200 hover:bg-brand-50 hover:text-brand-600 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-brand-800 dark:hover:bg-brand-950/40 dark:hover:text-brand-400"
      }`}
    >
      {children}
    </button>
  );
}

function DownloadCard({
  task,
}: {
  task: DownloadTask;
}) {
  const { t } = useI18n();
  const dl = useDownloads();
  const { confirm, dialog } = useConfirm();
  const running = task.phase === "running";
  const pct = Math.round(task.percent);
  const pipelineRunning = task.pipeline?.phase === "running";
  const stepNames = task.pipelineSteps.map((s) => t(`tool.${s.toolId}.name`));
  // A frame grabbed from the finished file beats a hotlink-protected remote
  // thumbnail; audio-only outputs have no frames to show at all.
  const thumbSrc = dl.thumbs[task.id] ?? task.thumbnail;
  const audio = task.quality === "audio" || AUDIO_EXTS.test(task.output ?? "");
  // Live recordings never carry a cover: no probe thumbnail, and grabbing a
  // frame from a half-written file is pointless.
  const showThumb = task.kind !== "record";

  return (
    <div
      className={`group rounded-2xl bg-white p-3 shadow-card ring-1 ring-neutral-200 transition-shadow hover:shadow-card-hover dark:bg-neutral-900 dark:ring-neutral-800 ${
        running ? "job-fill" : ""
      }`}
      style={
        running
          ? ({ "--job-fill": `${Math.min(Math.max(pct, 0), 100)}%` } as CSSProperties)
          : undefined
      }
    >
      {dialog}
      <div className="flex gap-2.5">
        {showThumb && <Thumb src={thumbSrc} audio={audio} />}

        <div className="min-w-0 flex-1">
          <p
            className="truncate text-sm font-medium leading-snug text-neutral-800 dark:text-neutral-100"
            title={task.title}
          >
            {task.title}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <PhaseBadge task={task} />
            {task.quality && (
              <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                {t(`dl.quality.${task.quality}`) || task.quality}
              </span>
            )}
          </div>
          <p
            className="mt-1 truncate text-[11px] text-neutral-400 dark:text-neutral-500"
            title={task.output ?? task.url}
          >
            {task.output ?? task.url}
          </p>
        </div>

        <div className="flex shrink-0 items-start gap-1.5">
          {(running || pipelineRunning) && (
            <CardButton onClick={() => dl.cancelTask(task.id)}>{t("confirm.cancel")}</CardButton>
          )}
          {!running && task.phase === "error" && task.retryReq && (
            <CardButton onClick={() => dl.retryTask(task.id)}>{t("job.retry")}</CardButton>
          )}
          {/* Finished with a bound pipeline that isn't in flight: offer a manual
              rerun (failed post-processing, or a re-run onto a fresh output). */}
          {task.phase === "done" &&
            task.pipelineSteps.length > 0 &&
            task.pipeline?.phase !== "running" && (
              <CardButton onClick={() => dl.runPipeline(task.id)}>
                {t("dl.pipeline.rerun")}
              </CardButton>
            )}
          {task.output && canRevealInFolder && (
            <button
              onClick={() => void openOutputFolder(task.output!)}
              className="flex h-6 w-6 items-center justify-center rounded-lg border border-neutral-200 text-neutral-500 transition hover:border-brand-200 hover:bg-brand-50 hover:text-brand-600 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-brand-800 dark:hover:bg-brand-950/40 dark:hover:text-brand-400"
              title={t("dl.openFolder")}
              aria-label={t("dl.openFolder")}
            >
              <FolderIcon className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={async () => {
              const deleting = running || pipelineRunning;
              const ok = await confirm({
                title: t("dl.removeTask.title"),
                message: deleting
                  ? t("dl.removeTask.runningMsg", { name: task.title })
                  : t("dl.removeTask.msg", { name: task.title }),
                confirmLabel: t("confirm.delete"),
                cancelLabel: t("confirm.cancel"),
                danger: true,
              });
              if (ok) dl.removeTask(task.id);
            }}
            className="flex h-6 w-6 items-center justify-center rounded-lg text-neutral-300 transition hover:bg-error-50 hover:text-error-500 dark:text-neutral-600 dark:hover:bg-error-950/40"
            title={t("job.remove")}
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Progress is the card's own background fill (same as the transcode
          cards), so this line only carries the numbers. */}
      {running && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-neutral-400 dark:text-neutral-500">
          <span className="font-medium text-neutral-600 dark:text-neutral-300">{pct}%</span>
          {task.speed && <span>· {task.speed}</span>}
          {task.eta && <span>· ETA {task.eta}</span>}
          {task.downloadedBytes != null && (
            <span className="ml-auto tabular-nums">
              {formatBytes(task.downloadedBytes)}
              {task.totalBytes != null ? ` / ${formatBytes(task.totalBytes)}` : ""}
            </span>
          )}
        </div>
      )}

      {task.phase === "error" && task.error && <ErrorBox text={task.error} />}

      {/* Bound post-processing (sprite sheet etc.) rendered inline as a
          sub-progress of this task instead of a separate workflow card. */}
      {pipelineRunning && task.pipeline && (
        <div className="mt-2.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
            <div
              className="h-full rounded-full bg-brand-500 transition-all duration-300"
              style={{ width: `${Math.max(Math.round(task.pipeline.percent), 2)}%` }}
            />
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-400 dark:text-neutral-500">
            <span className="font-medium text-neutral-600 dark:text-neutral-300">
              {t("dl.pipeline.step", {
                name: stepNames[task.pipeline.stepIndex] ?? "",
              })}
            </span>
            <span className="tabular-nums">{Math.round(task.pipeline.percent)}%</span>
          </div>
        </div>
      )}

      {task.pipeline?.phase === "done" && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px]">
          <span className="shrink-0 font-medium text-success-600 dark:text-success-400">
            {t("dl.pipeline.doneLine")}
          </span>
          {task.pipeline.output && (
            <span
              className="truncate text-neutral-400 dark:text-neutral-500"
              title={task.pipeline.output}
            >
              {task.pipeline.output}
            </span>
          )}
        </p>
      )}

      {task.pipeline?.phase === "done" && task.pipeline.note && (
        <p
          className="mt-1 text-[11px] text-amber-600 dark:text-amber-400"
          title={task.pipeline.note}
        >
          {task.pipeline.note}
        </p>
      )}

      {task.pipeline?.phase === "cancelled" && (
        <p className="mt-2 text-[11px] text-neutral-400 dark:text-neutral-500">
          {t("dl.phase.cancelled")} · {stepNames.join(" + ")}
        </p>
      )}

      {task.pipeline?.phase === "error" && task.pipeline.error && (
        <ErrorBox text={task.pipeline.error} />
      )}

      {!task.pipeline && task.pipelineSteps.length > 0 &&
        (task.phase === "running" || task.phase === "done") && (
        <p className="mt-2 text-[11px] text-neutral-400 dark:text-neutral-500">
          {t("dl.pipeline.bound", { n: task.pipelineSteps.length, names: stepNames.join(" + ") })}
        </p>
      )}
    </div>
  );
}

/* ── page ───────────────────────────────────────────────────────── */

export default function DownloadPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  const dl = useDownloads();
  const uploads = useUploads();
  const { confirm, dialog } = useConfirm();
  // Recordings live on the record page next to their monitors.
  const tasks = dl.tasks.filter((x) => x.kind === "download");
  const removable = tasks.filter(
    (x) => x.phase !== "running" && x.pipeline?.phase !== "running"
  ).length;

  const handleClearFinished = async () => {
    if (removable === 0) return;
    const ok = await confirm({
      title: t("app.clearFinished.title"),
      message: t("app.clearFinished.msg", { n: removable }),
      confirmLabel: t("app.clearFinished.confirm"),
      cancelLabel: t("confirm.cancel"),
      danger: true,
    });
    if (ok) dl.clearFinished("download");
  };

  const [quality, setQuality] = useState(dl.settings.quality);
  const [audioFormat, setAudioFormat] = useState("mp3");
  const [pipelineIds, setPipelineIds] = useState<string[]>([]);
  const [uploadTo, setUploadTo] = useState<string[]>([]);
  const pipelineSummary = pipelineIds
    .map((id) => {
      const p = pipelineById(id);
      return p ? pipelineDisplayName(p, t) : id;
    })
    .join(" → ");
  const uploadSummary = uploadTo
    .map((id) => uploads.targets.find((x) => x.id === id)?.name ?? id)
    .join("、");

  return (
    <div className="mx-auto max-w-5xl">
      {dialog}
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">
          {t("dl.page.title")}
        </h2>
        <SiteStrip />
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-5">
        <div className="min-w-0 flex-1">
          <YtdlpHint />
          <NewDownloadForm
            quality={quality}
            audioFormat={audioFormat}
            pipelineIds={pipelineIds}
            uploadTo={uploadTo}
          />

          {tasks.length > 0 ? (
          <>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
                {t("dl.tasks")}
              </h3>
              <Button size="sm" onClick={() => void handleClearFinished()}>
                {t("dl.clearFinished")}
              </Button>
            </div>
            <div className="space-y-2.5">
              {tasks.map((x) => (
                <DownloadCard key={x.id} task={x} />
              ))}
            </div>
          </>
        ) : (
          <EmptyState message={t("dl.empty.hint")} />
        )}
      </div>

      <ConfigSidebar>
        <SaveLocationBar />

        <SidebarSection title={t("dl.quality")}>
          <Select value={quality} onChange={setQuality} className="w-full">
            {QUALITIES.map((q) => (
              <option key={q} value={q}>
                {t(`dl.quality.${q}`)}
              </option>
            ))}
          </Select>
          {quality === "audio" && (
            <Select value={audioFormat} onChange={setAudioFormat} className="w-full">
              {["mp3", "m4a", "opus", "flac"].map((f) => (
                <option key={f} value={f}>
                  {f.toUpperCase()}
                </option>
              ))}
            </Select>
          )}
        </SidebarSection>

        <SidebarSection
          title={t("dl.pipeline.title")}
          collapsible
          defaultOpen={false}
          summary={pipelineSummary || t("dl.pipeline.noTreatment")}
        >
          <PipelineChips selected={pipelineIds} onChange={setPipelineIds} />
        </SidebarSection>

        <SidebarSection
          title={t("upload.pick.title")}
          collapsible
          defaultOpen={false}
          summary={uploadSummary || t("upload.pick.none")}
        >
          <div className="space-y-1.5">
            <UploadTargetChips selected={uploadTo} onChange={setUploadTo} />
            {uploadTo.length > 0 && (
              <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
                {t("upload.pick.hint")}
              </p>
            )}
          </div>
        </SidebarSection>

        <SidebarSection title={t("dl.advanced")} collapsible defaultOpen={false}>
          <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={dl.settings.subtitles}
              onChange={(e) => dl.updateSettings({ subtitles: e.target.checked })}
              className="h-3.5 w-3.5 accent-brand-500"
            />
            {t("dl.subtitles")}
          </label>
        </SidebarSection>

        <NetworkSection onOpenSettings={onOpenSettings} />
      </ConfigSidebar>
      </div>
    </div>
  );
}
