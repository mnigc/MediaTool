import type { ReactNode } from "react";
import { formatBytes } from "../../lib/engine";
import { useI18n } from "../../i18n";
import type { MediaReport } from "../../types";

function Row({
  k,
  v,
  flat,
}: {
  k: string;
  v: string | number | null | undefined;
  /** Rail variant sits beside a picture, so it stays quiet: no bold labels and
   *  no bright values competing with the video. */
  flat?: boolean;
}) {
  if (v == null || v === "") return null;
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span
        className={`shrink-0 text-xs ${
          flat
            ? "text-neutral-500 dark:text-neutral-500"
            : "font-medium text-neutral-600 dark:text-neutral-300"
        }`}
      >
        {k}
      </span>
      <span
        className={`min-w-0 break-all text-right text-xs ${
          flat ? "text-neutral-600 dark:text-neutral-400" : "text-neutral-700 dark:text-neutral-200"
        }`}
      >
        {v}
      </span>
    </div>
  );
}

function Card({
  title,
  children,
  flat,
}: {
  title: string;
  children: ReactNode;
  /** A plain hairline-separated section, for narrow side panels where nested
   *  bordered cards would be all frame and no content. */
  flat?: boolean;
}) {
  if (flat) {
    return (
      <div className="px-3 py-2">
        <div className="mb-0.5 text-[11px] font-medium text-neutral-500 dark:text-neutral-500">
          {title}
        </div>
        {children}
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-700/60 dark:bg-neutral-800/40">
      <div className="mb-1 text-xs font-semibold text-neutral-600 dark:text-neutral-300">
        {title}
      </div>
      {children}
    </div>
  );
}

/** ffprobe hands frame rates over as a rational ("25807200/1076999"), which is
 *  not a number anyone can read at a glance. */
function fmtFrameRate(rate: string | null | undefined): string | null {
  if (!rate || rate === "0/0") return null;
  const [num, den] = rate.split("/").map(Number);
  const fps = den ? num / den : num;
  return Number.isFinite(fps) && fps > 0 ? `${fps.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")} fps` : rate;
}

export default function InspectReport({
  report,
  flat,
}: {
  report: MediaReport;
  /** Stack hairline-separated sections instead of bordered cards. */
  flat?: boolean;
}) {
  const { t } = useI18n();
  const kindKey: Record<string, string> = {
    video: "job.type.video",
    audio: "job.type.audio",
    subtitle: "tool.inspect.subtitle",
  };
  const tags = (report.tags ?? {}) as Record<string, string>;

  // 90-minute videos shouldn't render as "5412s".
  const fmtDuration = (secs: number): string => {
    const s = Math.round(secs);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(r).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  };

  return (
    <div className={flat ? "divide-y divide-neutral-100 dark:divide-neutral-800" : "space-y-3"}>
      <Card flat={flat} title={t("tool.inspect.container")}>
        <Row flat={flat} k={t("tool.inspect.format")} v={report.formatName} />
        <Row flat={flat} k={t("sidebar.total")} v={formatBytes(report.sizeBytes)} />
        <Row flat={flat} k={t("tool.inspect.duration")} v={
          report.durationSecs != null ? fmtDuration(report.durationSecs) : null
        } />
        <Row flat={flat} k={t("tool.inspect.bitrate")} v={report.bitrateKbps != null ? `${report.bitrateKbps} kbps` : null} />
        <Row flat={flat} k={t("tool.inspect.chapters")} v={report.chapterCount > 0 ? report.chapterCount : null} />
        {Object.entries(tags).slice(0, 8).map(([k, v]) => (
          <Row key={k} flat={flat} k={k} v={String(v)} />
        ))}
      </Card>

      {report.streams.map((s) => (
        <Card
          key={`${s.kind}-${s.index}`}
          flat={flat}
          title={`# ${s.index} · ${t(kindKey[s.kind] ?? "job.type.other")}`}
        >
          <Row flat={flat} k={t("opt.codec")} v={[s.codecName, s.profile].filter(Boolean).join(" · ") || null} />
          <Row flat={flat} k={t("tool.inspect.resolution")} v={s.width && s.height ? `${s.width}×${s.height}` : null} />
          <Row flat={flat} k={t("opt.fps")} v={fmtFrameRate(s.avgFrameRate)} />
          <Row flat={flat} k={t("tool.inspect.pixfmt")} v={s.pixFmt} />
          <Row flat={flat} k={t("tool.inspect.samplerate")} v={s.sampleRate ? `${s.sampleRate} Hz` : null} />
          <Row flat={flat} k={t("tool.inspect.channels")} v={[s.channels, s.channelLayout].filter(Boolean).join(" · ") || null} />
          <Row flat={flat} k={t("tool.inspect.bitrate")} v={s.bitrateKbps != null ? `${s.bitrateKbps} kbps` : null} />
          <Row flat={flat} k={t("tool.inspect.lang")} v={s.language?.toUpperCase()} />
        </Card>
      ))}
    </div>
  );
}
