import type { ReactNode } from "react";
import { formatBytes } from "../../lib/tauri";
import { useI18n } from "../../i18n";
import type { MediaReport } from "../../types";

function Row({ k, v }: { k: string; v: string | number | null | undefined }) {
  if (v == null || v === "") return null;
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">{k}</span>
      <span className="min-w-0 break-all text-right text-xs text-neutral-700 dark:text-neutral-200">{v}</span>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-700/60 dark:bg-neutral-800/40">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
        {title}
      </div>
      {children}
    </div>
  );
}

export default function InspectReport({ report }: { report: MediaReport }) {
  const { t } = useI18n();
  const kindKey: Record<string, string> = {
    video: "job.type.video",
    audio: "job.type.audio",
    subtitle: "tool.inspect.subtitle",
  };
  const tags = (report.tags ?? {}) as Record<string, string>;

  return (
    <div className="space-y-3">
      <Card title={t("tool.inspect.container")}>
        <Row k={t("tool.inspect.format")} v={report.formatName} />
        <Row k={t("sidebar.total")} v={formatBytes(report.sizeBytes)} />
        <Row k={t("tool.inspect.duration")} v={
          report.durationSecs != null ? `${Math.round(report.durationSecs)}s` : null
        } />
        <Row k={t("tool.inspect.bitrate")} v={report.bitrateKbps != null ? `${report.bitrateKbps} kbps` : null} />
        <Row k={t("tool.inspect.chapters")} v={report.chapterCount > 0 ? report.chapterCount : null} />
        {Object.entries(tags).slice(0, 8).map(([k, v]) => (
          <Row key={k} k={k} v={String(v)} />
        ))}
      </Card>

      {report.streams.map((s) => (
        <Card
          key={`${s.kind}-${s.index}`}
          title={`# ${s.index} · ${t(kindKey[s.kind] ?? "job.type.other")}`}
        >
          <Row k={t("opt.codec")} v={[s.codecName, s.profile].filter(Boolean).join(" · ") || null} />
          <Row k={t("tool.inspect.resolution")} v={s.width && s.height ? `${s.width}×${s.height}` : null} />
          <Row k={t("opt.fps")} v={s.avgFrameRate} />
          <Row k={t("tool.inspect.pixfmt")} v={s.pixFmt} />
          <Row k={t("tool.inspect.samplerate")} v={s.sampleRate ? `${s.sampleRate} Hz` : null} />
          <Row k={t("tool.inspect.channels")} v={[s.channels, s.channelLayout].filter(Boolean).join(" · ") || null} />
          <Row k={t("tool.inspect.bitrate")} v={s.bitrateKbps != null ? `${s.bitrateKbps} kbps` : null} />
          <Row k={t("tool.inspect.lang")} v={s.language?.toUpperCase()} />
        </Card>
      ))}
    </div>
  );
}
