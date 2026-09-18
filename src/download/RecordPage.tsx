import { useEffect, useState } from "react";
import {
  monitorAdd,
  monitorList,
  monitorRecordNow,
  monitorRemove,
  monitorUpdate,
  onMonitorStatus,
} from "../lib/tauri";
import { useI18n } from "../i18n";
import { useDownloads } from "../contexts/DownloadCenter";
import Select from "../components/Select";
import { useConfirm } from "../components/ConfirmDialog";
import SiteStrip from "./SiteStrip";
import SaveLocationBar from "./SaveLocationBar";
import { ConfigSidebar, Field, NetworkSection, PipelineChips, SidebarSection } from "./Sidebar";
import { presetById } from "./pipelines";
import type { MonitorInfo } from "../types";

const QUALITIES = ["best", "2160p", "1080p", "720p", "480p"] as const;
const INTERVALS = [60, 180, 300, 600] as const;

function liveBadge(live?: string | null): { cls: string; key: string } | null {
  switch (live) {
    case "is_live":
      return {
        cls: "bg-error-500 animate-pulse text-white",
        key: "dl.live.now",
      };
    case "not_live":
      return {
        cls: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
        key: "dl.live.off",
      };
    case "post_live":
      return {
        cls: "bg-warning-50 text-warning-600 dark:bg-warning-950/40 dark:text-warning-400",
        key: "dl.live.post",
      };
    case "unknown":
      return {
        cls: "bg-neutral-100 text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500",
        key: "dl.live.unknown",
      };
    default:
      return null;
  }
}

function statusBadge(m: MonitorInfo, t: (k: string) => string): { cls: string; label: string } {
  if (m.status === "recording") {
    return {
      cls: "bg-error-500 text-white animate-pulse",
      label: t("dl.monitor.recording"),
    };
  }
  if (m.status === "stopped") {
    return { cls: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400", label: t("dl.monitor.stopped") };
  }
  return { cls: "bg-success-50 text-success-600 dark:bg-success-950/40 dark:text-success-400", label: t("dl.monitor.watching") };
}

/* ── add-monitor form ───────────────────────────────────────────── */

function AddMonitorForm({
  onAdded,
  quality,
  intervalSec,
  pipelineIds,
}: {
  onAdded: () => void;
  quality: string;
  intervalSec: number;
  pipelineIds: string[];
}) {
  const { t } = useI18n();
  const dl = useDownloads();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = !dl.ytdlp?.installed || !url.trim() || busy || !dl.settings.outputDir;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await monitorAdd({
        url: url.trim(),
        name: name.trim() || null,
        intervalSec,
        // New monitors start with auto-record on; the card switch adjusts it.
        autoRecord: true,
        quality,
        outputDir: dl.settings.outputDir!,
        cookiesBrowser: dl.settings.cookiesBrowser || null,
        proxy: dl.settings.proxy || null,
        pipeline: pipelineIds.flatMap((id) => presetById(id)?.steps ?? []),
      });
      setUrl("");
      setName("");
      onAdded();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-6 rounded-2xl bg-white p-4 shadow-card ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("dl.monitor.urlPlaceholder")}
          className="min-w-0 flex-1 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:border-brand-500"
        />
        <button
          onClick={() => void submit()}
          disabled={disabled}
          className="shrink-0 rounded-xl bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-brand-600 dark:hover:bg-brand-700"
        >
          {t("dl.monitor.add")}
        </button>
      </div>

      <label className="mt-3 flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
        {t("dl.monitor.name")}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("dl.monitor.namePlaceholder")}
          className="w-36 rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
        />
      </label>

      {error && (
        <p className="mt-2 rounded-lg bg-error-50 px-2.5 py-1.5 text-[11px] text-error-600 dark:bg-error-950/30 dark:text-error-400">
          {error}
        </p>
      )}
    </div>
  );
}

/* ── monitor card ───────────────────────────────────────────────── */

function AutoRecordSwitch({ m }: { m: MonitorInfo }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const on = m.autoRecord;
  const toggle = async () => {
    setBusy(true);
    try {
      await monitorUpdate(m.id, { autoRecord: !on });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      role="switch"
      aria-checked={on}
      title={t("dl.monitor.autoRecord")}
      onClick={() => void toggle()}
      disabled={busy}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-brand-500 dark:bg-brand-600" : "bg-neutral-300 dark:bg-neutral-600"
      }`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${
          on ? "left-3.5" : "left-0.5"
        }`}
      />
    </button>
  );
}

function EditMonitorForm({
  m,
  onDone,
  onCancel,
}: {
  m: MonitorInfo;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(m.name === m.url ? "" : m.name);
  const [quality, setQuality] = useState(m.quality);
  const [intervalSec, setIntervalSec] = useState(m.intervalSec);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await monitorUpdate(m.id, {
        name: name.trim(),
        quality,
        intervalSec,
      });
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-xl bg-neutral-50 p-3 ring-1 ring-neutral-200 dark:bg-neutral-800/60 dark:ring-neutral-700">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          {t("dl.monitor.name")}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("dl.monitor.namePlaceholder")}
            className="w-36 rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          {t("dl.quality")}
          <Select value={quality} onChange={setQuality} className="w-24 text-xs">
            {QUALITIES.map((q) => (
              <option key={q} value={q}>
                {t(`dl.quality.${q}`)}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          {t("dl.monitor.interval")}
          <Select
            value={String(intervalSec)}
            onChange={(v) => setIntervalSec(Number(v))}
            className="w-24 text-xs"
          >
            {INTERVALS.map((s) => (
              <option key={s} value={s}>
                {t("dl.monitor.intervalMin", { n: Math.round(s / 60) })}
              </option>
            ))}
          </Select>
        </label>
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg bg-brand-500 px-3 py-1 text-xs font-medium text-white transition hover:bg-brand-600 disabled:opacity-50 dark:bg-brand-600 dark:hover:bg-brand-700"
        >
          {t("dl.monitor.save")}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-neutral-200 px-3 py-1 text-xs text-neutral-500 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          {t("dl.monitor.cancel")}
        </button>
      </div>
      {error && (
        <p className="mt-2 rounded-lg bg-error-50 px-2.5 py-1.5 text-[11px] text-error-600 dark:bg-error-950/30 dark:text-error-400">
          {error}
        </p>
      )}
    </div>
  );
}

function MonitorCard({ m, onChanged }: { m: MonitorInfo; onChanged: () => void }) {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirm();
  const [removing, setRemoving] = useState(false);
  const [editing, setEditing] = useState(false);
  const badge = liveBadge(m.liveStatus);
  const st = statusBadge(m, t);
  const lastChecked = m.lastChecked
    ? new Date(m.lastChecked * 1000).toLocaleTimeString()
    : null;

  const remove = async () => {
    const heading = m.name && m.name !== m.url ? m.name : m.title || m.url;
    const ok = await confirm({
      title: t("dl.monitor.deleteTitle"),
      message:
        m.status === "recording"
          ? t("dl.monitor.deleteRecordingMsg", { name: heading })
          : t("dl.monitor.deleteMsg", { name: heading }),
      confirmLabel: t("dl.monitor.delete"),
      cancelLabel: t("confirm.cancel"),
      danger: true,
    });
    if (!ok) return;
    setRemoving(true);
    try {
      await monitorRemove(m.id);
      onChanged();
    } finally {
      setRemoving(false);
    }
  };

  // No custom name (the backend falls back to the URL): show the live
  // room's title, and keep the streamer in the sub-line.
  const autoNamed = !m.name || m.name === m.url;
  const heading = autoNamed ? m.title || m.url : m.name;
  const subline = [
    m.author,
    t("dl.monitor.meta", {
      interval: Math.round(m.intervalSec / 60),
      quality: t(`dl.quality.${m.quality}`),
      auto: m.autoRecord ? t("dl.monitor.autoOn") : t("dl.monitor.autoOff"),
      time: lastChecked ?? "—",
    }),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1" title={m.url}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
              {heading}
            </span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${st.cls}`}>
              {st.label}
            </span>
            {badge && (
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
                {t(badge.key)}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-neutral-400 dark:text-neutral-500">
            {subline}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {m.status !== "recording" && m.liveStatus === "is_live" && (
            <button
              onClick={() => void monitorRecordNow(m.id).then(onChanged).catch(() => {})}
              className="rounded-lg border border-error-200 bg-error-50 px-2.5 py-1 text-[11px] font-medium text-error-600 transition hover:bg-error-100 dark:border-error-800 dark:bg-error-950/30 dark:text-error-400 dark:hover:bg-error-900/50"
            >
              {t("dl.monitor.recordNow")}
            </button>
          )}
          <AutoRecordSwitch m={m} />
          <button
            onClick={() => setEditing((v) => !v)}
            title={t("dl.monitor.edit")}
            className={`rounded-lg border px-2 py-1 text-[11px] transition dark:border-neutral-700 ${
              editing
                ? "border-brand-300 bg-brand-50 text-brand-600 dark:border-brand-700 dark:bg-brand-950/40 dark:text-brand-400"
                : "border-neutral-200 text-neutral-400 hover:bg-neutral-50 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            }`}
          >
            ✎
          </button>
          <button
            onClick={() => void remove()}
            disabled={removing}
            className="rounded-lg border border-neutral-200 px-2 py-1 text-[11px] text-neutral-400 hover:bg-neutral-50 hover:text-error-500 dark:border-neutral-700 dark:hover:bg-neutral-800 disabled:opacity-50"
          >
            ✕
          </button>
        </div>
      </div>
      {editing && (
        <EditMonitorForm m={m} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
      )}
      {dialog}
    </div>
  );
}

/* ── page ───────────────────────────────────────────────────────── */

export default function RecordPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  const dl = useDownloads();
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [quality, setQuality] = useState("best");
  const [intervalSec, setIntervalSec] = useState(180);
  const [pipelineIds, setPipelineIds] = useState<string[]>(["transcode"]);

  const refresh = () => {
    monitorList()
      .then(setMonitors)
      .catch(() => {});
  };

  useEffect(() => {
    refresh();
    let un: (() => void) | null = null;
    let active = true;
    onMonitorStatus((info) => {
      setMonitors((prev) => prev.map((x) => (x.id === info.id ? info : x)));
    }).then((fn) => {
      if (!active) fn();
      else un = fn;
    });
    return () => {
      active = false;
      un?.();
    };
  }, []);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-5">
        <h2 className="text-xl font-semibold text-neutral-800 dark:text-neutral-100">
          {t("dl.record.title")}
        </h2>
        {dl.streamlink && !dl.streamlink.installed && dl.streamlink.installable && (
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            <button
              onClick={() => void dl.installStreamlink()}
              disabled={dl.streamlinkInstalling}
              className="rounded-lg border border-neutral-200 px-2 py-0.5 text-[11px] font-medium text-neutral-600 transition hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {dl.streamlinkInstalling ? t("dl.installing") : t("dl.record.installEngine")}
            </button>
          </p>
        )}
      </div>

      <SiteStrip record />

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-5">
        <div className="min-w-0 flex-1">
          {!dl.ytdlp?.installed && (
            <div className="mb-4 rounded-xl border border-warning-100 bg-warning-50 px-4 py-2.5 text-sm text-warning-700 dark:border-warning-900/50 dark:bg-warning-950/30 dark:text-warning-400">
              {t("dl.missingGoAbout")}
            </div>
          )}

          <AddMonitorForm
            onAdded={refresh}
            quality={quality}
            intervalSec={intervalSec}
            pipelineIds={pipelineIds}
          />

          {monitors.length > 0 && (
          <>
            <h3 className="mb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              {t("dl.monitor.list", { n: monitors.length })}
            </h3>
            <div className="divide-y divide-neutral-100 rounded-2xl bg-white shadow-card ring-1 ring-neutral-200 dark:divide-neutral-800 dark:bg-neutral-900 dark:ring-neutral-800">
              {monitors.map((m) => (
                <MonitorCard key={m.id} m={m} onChanged={refresh} />
              ))}
            </div>
          </>
        )}
      </div>

      <ConfigSidebar>
        <SaveLocationBar />

        <SidebarSection title={t("dl.record.title")}>
          <Field label={t("dl.quality")}>
            <Select value={quality} onChange={setQuality} className="w-28">
              {QUALITIES.map((q) => (
                <option key={q} value={q}>
                  {t(`dl.quality.${q}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("dl.monitor.interval")}>
            <Select
              value={String(intervalSec)}
              onChange={(v) => setIntervalSec(Number(v))}
              className="w-24"
            >
              {[60, 180, 300, 600].map((s) => (
                <option key={s} value={s}>
                  {t("dl.monitor.intervalMin", { n: Math.round(s / 60) })}
                </option>
              ))}
            </Select>
          </Field>
        </SidebarSection>

        <SidebarSection title={t("dl.pipeline.title")}>
          <PipelineChips selected={pipelineIds} onChange={setPipelineIds} />
        </SidebarSection>

        <NetworkSection onOpenSettings={onOpenSettings} />
      </ConfigSidebar>
      </div>
    </div>
  );
}
