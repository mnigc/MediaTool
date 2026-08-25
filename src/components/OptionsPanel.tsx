import { useState, type ReactNode } from "react";
import type { AudioParams, ImageParams, JobParams, VideoParams } from "../types";
import PresetsBar from "./PresetsBar";
import { useI18n } from "../i18n";

interface Props {
  toolId: string;
  params: JobParams;
  onChange: (p: JobParams) => void;
}

export default function OptionsPanel({ toolId, params, onChange }: Props) {
  const [expanded, setExpanded] = useState(false);

  const renderContent = () => {
    switch (toolId) {
      case "video-compress":
        return <VideoCompressOptions params={params} onChange={onChange} />;
      case "video-convert":
        return <VideoConvertOptions params={params as VideoParams} onChange={onChange} />;
      case "image-compress":
        return <ImageCompressOptions params={params as ImageParams} onChange={onChange} />;
      case "image-convert":
        return <ImageConvertOptions params={params as ImageParams} onChange={onChange} />;
      case "audio-compress":
        return <AudioCompressOptions params={params as AudioParams} onChange={onChange} />;
      case "audio-convert":
        return <AudioConvertOptions params={params as AudioParams} onChange={onChange} />;
      default:
        return null;
    }
  };

  const showPresets = !toolId.endsWith("-convert");

  return (
    <div className="flex flex-col gap-3">
      {showPresets && <PresetsBar toolId={toolId} params={params} onChange={onChange} />}
      <SettingsCollapsible expanded={expanded} onToggle={() => setExpanded(!expanded)}>
        {renderContent()}
      </SettingsCollapsible>
    </div>
  );
}

/* ── 设置折叠面板 ─────────────────────────────────── */

function SettingsCollapsible({ expanded, onToggle, children }: {
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left transition hover:bg-neutral-100/50 dark:hover:bg-neutral-800/50"
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
          {t("opt.settings")}
        </span>
        <svg
          viewBox="0 0 16 16"
          className={`h-3.5 w-3.5 text-neutral-400 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="currentColor"
        >
          <path d="M4 6l4 4 4-4z" />
        </svg>
      </button>
      <div
        className={`overflow-hidden transition-all duration-250 ${
          expanded ? "max-h-[1200px] opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="rounded-xl border border-neutral-100 bg-white p-4 pt-3 dark:border-neutral-700/60 dark:bg-neutral-800/30">
          {children}
        </div>
      </div>
    </div>
  );
}

/* ── 字段组件 ─────────────────────────────────── */

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function FieldRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">{label}</span>
    </div>
  );
}

const sel =
  "w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-700 transition focus:border-brand-400 focus:ring-1 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:focus:border-brand-500";

const range = "mp-range flex-1";

const sourceTag =
  "w-full rounded-lg border border-dashed border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-400";

/** Fixed-format chip used by compress tools that keep the source container. */
function SourceFormatChip({ label }: { label: string }) {
  return <div className={sourceTag}>{label}</div>;
}

/* ── 视频压缩 ───────────────────────────────────── */

export function VideoCompressOptions({
  params,
  onChange,
}: {
  params: JobParams;
  onChange: (p: JobParams) => void;
}) {
  const { t } = useI18n();
  const v = params as VideoParams;
  const set = (patch: Partial<VideoParams>) => onChange({ ...params, ...patch } as JobParams);

  return (
    <div className="space-y-3">
      <SectionDivider label={t("opt.videoOutput")} />

      <FieldRow>
        <Field label={t("opt.format")}>
          <select className={sel} value={v.format} onChange={(e) => set({ format: e.target.value })}>
            <option value="source">{t("opt.format.source")}</option>
            <option value="mp4">MP4</option>
            <option value="mkv">MKV</option>
          </select>
        </Field>
        <Field label={t("opt.codec")}>
          <select className={sel} value={v.videoCodec} onChange={(e) => set({ videoCodec: e.target.value })}>
            <option value="libx264">H.264</option>
            <option value="libvpx-vp9">VP9</option>
            <option value="libsvtav1">AV1</option>
            <option value="copy">{t("opt.copy")}</option>
          </select>
        </Field>
        <Field label={t("opt.qualityMode")}>
          <select className={sel} value={v.qualityMode} onChange={(e) => set({ qualityMode: e.target.value })}>
            <option value="crf">{t("opt.crf")}</option>
            <option value="target_size">{t("opt.targetSize")}</option>
            <option value="bitrate">{t("opt.fixedBitrate")}</option>
          </select>
        </Field>
      </FieldRow>

      <div className="space-y-2 rounded-xl bg-neutral-50/50 p-3 dark:bg-neutral-800/40">
        {v.qualityMode === "crf" && (
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
              {t("opt.crfQuality", { n: v.crf ?? 28 })}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="shrink-0 text-[9px] text-neutral-400 dark:text-neutral-600">{t("opt.highQuality")}</span>
              <input
                type="range"
                min={18}
                max={40}
                value={v.crf ?? 28}
                onChange={(e) => set({ crf: Number(e.target.value) })}
                className={range}
              />
              <span className="shrink-0 text-[9px] text-neutral-400 dark:text-neutral-600">{t("opt.lowQuality")}</span>
            </div>
          </div>
        )}
        {v.qualityMode === "target_size" && (
          <Field label={t("opt.targetSizeMb")}>
            <input type="number" className={sel} min={1} value={v.targetSizeMb ?? ""} onFocus={(e) => e.currentTarget.select()} onChange={(e) => set({ targetSizeMb: e.target.value === "" ? undefined : Number(e.target.value) })} />
          </Field>
        )}
        {v.qualityMode === "bitrate" && (
          <Field label={t("opt.bitrate")}>
            <input type="number" className={sel} min={100} value={v.videoBitrateKbps ?? ""} onFocus={(e) => e.currentTarget.select()} onChange={(e) => set({ videoBitrateKbps: e.target.value === "" ? undefined : Number(e.target.value) })} />
          </Field>
        )}
        <FieldRow>
          <Field label={t("opt.resolution")}>
            <select className={sel} value={v.resolution} onChange={(e) => set({ resolution: e.target.value })}>
              <option value="original">{t("opt.res.original")}</option>
              <option value="2160p">2160p</option>
              <option value="1440p">1440p</option>
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
              <option value="480p">480p</option>
            </select>
          </Field>
          <Field label={t("opt.speed")}>
            <select className={sel} value={v.preset} onChange={(e) => set({ preset: e.target.value })}>
              <option value="veryfast">{t("opt.speed.veryfast")}</option>
              <option value="faster">{t("opt.speed.faster")}</option>
              <option value="fast">{t("opt.speed.fast")}</option>
              <option value="medium">{t("opt.speed.medium")}</option>
              <option value="slow">{t("opt.speed.slow")}</option>
              <option value="slower">{t("opt.speed.slower")}</option>
              <option value="veryslow">{t("opt.speed.veryslow")}</option>
            </select>
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label={t("opt.fps")}>
            <select
              className={sel}
              value={v.fps ? String(v.fps) : ""}
              onChange={(e) => set({ fps: e.target.value ? Number(e.target.value) : undefined })}
            >
              <option value="">{t("opt.fps.original")}</option>
              <option value="60">60</option>
              <option value="50">50</option>
              <option value="30">30</option>
              <option value="24">24</option>
              <option value="15">15</option>
            </select>
          </Field>
        </FieldRow>
      </div>

      <SectionDivider label={t("opt.audio")} />
      <FieldRow>
        <Field label={t("opt.audioCodec")}>
          <select className={sel} value={v.audioCodec} onChange={(e) => set({ audioCodec: e.target.value })}>
            <option value="aac">AAC</option>
            <option value="opus">Opus</option>
            <option value="copy">{t("opt.copy")}</option>
            <option value="none">{t("opt.remove")}</option>
          </select>
        </Field>
        {v.audioCodec !== "none" && v.audioCodec !== "copy" && (
          <Field label={t("opt.audioBitrate")}>
            <input type="number" className={sel} min={32} value={v.audioBitrateKbps ?? ""} onFocus={(e) => e.currentTarget.select()} onChange={(e) => set({ audioBitrateKbps: e.target.value === "" ? undefined : Number(e.target.value) })} />
          </Field>
        )}
      </FieldRow>
    </div>
  );
}

/* ── 质量档次（转换工具共用）────────────────────── */

type QualityTier = "high" | "balanced" | "compact";

const TIER_ORDER: QualityTier[] = ["high", "balanced", "compact"];

const TIER_KEY: Record<QualityTier, string> = {
  high: "opt.tier.high",
  balanced: "opt.tier.balanced",
  compact: "opt.tier.compact",
};

function TierPicker({ value, onChange }: {
  value: QualityTier;
  onChange: (t: QualityTier) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {TIER_ORDER.map((tier) => (
        <button
          key={tier}
          type="button"
          onClick={() => onChange(tier)}
          className={`rounded-lg px-2.5 py-1.5 text-[10px] font-medium transition ${
            value === tier
              ? "bg-brand-500 text-white dark:bg-brand-600"
              : "border border-neutral-200 bg-white text-neutral-600 hover:border-brand-200 hover:bg-brand-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:border-brand-800 dark:hover:bg-brand-950/40"
          }`}
        >
          {t(TIER_KEY[tier])}
        </button>
      ))}
    </div>
  );
}

/* ── 视频转换（极简：格式 + 质量档，其余全自动）──── */

/** Container → codec set + per-tier CRF. WebM strictly requires VP9+Opus. */
const CONVERT_PRESETS: Record<string, {
  codec: string;
  audio: string;
  crf: Record<QualityTier, number>;
}> = {
  mp4: { codec: "libx264", audio: "aac", crf: { high: 18, balanced: 22, compact: 27 } },
  webm: { codec: "libvpx-vp9", audio: "opus", crf: { high: 26, balanced: 31, compact: 35 } },
  mkv: { codec: "libx264", audio: "aac", crf: { high: 18, balanced: 22, compact: 27 } },
  mov: { codec: "libx264", audio: "aac", crf: { high: 18, balanced: 22, compact: 27 } },
};

const TIER_AUDIO_KBPS: Record<QualityTier, number> = { high: 256, balanced: 192, compact: 128 };

function tierOfVideo(v: VideoParams): QualityTier {
  const d = CONVERT_PRESETS[v.format];
  if (!d) return "balanced";
  if (v.crf === d.crf.high) return "high";
  if (v.crf === d.crf.compact) return "compact";
  return "balanced";
}

export function VideoConvertOptions({
  params,
  onChange,
}: {
  params: VideoParams;
  onChange: (p: JobParams) => void;
}) {
  const { t } = useI18n();
  const v = params;

  const changeFormat = (format: string) => {
    const d = CONVERT_PRESETS[format] ?? CONVERT_PRESETS.mp4;
    onChange({
      ...v,
      videoCodec: d.codec,
      qualityMode: "crf",
      crf: d.crf.balanced,
      targetSizeMb: undefined,
      videoBitrateKbps: undefined,
      resolution: "original",
      audioCodec: d.audio,
      audioBitrateKbps: TIER_AUDIO_KBPS.balanced,
      format,
      preset: "medium",
      fps: undefined,
    });
  };

  const changeTier = (tier: QualityTier) => {
    const d = CONVERT_PRESETS[v.format] ?? CONVERT_PRESETS.mp4;
    onChange({
      ...v,
      videoCodec: d.codec,
      qualityMode: "crf",
      crf: d.crf[tier],
      audioCodec: d.audio,
      audioBitrateKbps: TIER_AUDIO_KBPS[tier],
      preset: "medium",
    });
  };

  return (
    <div className="space-y-3">
      <FieldRow>
        <Field label={t("opt.format")}>
          <select className={sel} value={v.format} onChange={(e) => changeFormat(e.target.value)}>
            <option value="mp4">MP4</option>
            <option value="webm">WebM</option>
            <option value="mkv">MKV</option>
            <option value="mov">MOV</option>
          </select>
        </Field>
        <Field label={t("opt.tier")}>
          <TierPicker value={tierOfVideo(v)} onChange={changeTier} />
        </Field>
      </FieldRow>
      <p className="text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
        {t("opt.convert.autoHint")}
      </p>
    </div>
  );
}

/* ── 图片压缩（保持原格式）────────────────────── */

export function ImageCompressOptions({ params, onChange }: {
  params: ImageParams;
  onChange: (p: ImageParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<ImageParams>) => onChange({ ...params, ...patch });

  return (
    <div className="space-y-3">
      <FieldRow>
        <Field label={t("opt.format")}>
          <SourceFormatChip label={t("opt.format.sourceKeep")} />
        </Field>
        <Field label={t("opt.quality", { n: params.quality })}>
          <input
            type="range"
            min={1}
            max={100}
            value={params.quality}
            onChange={(e) => set({ quality: Number(e.target.value) })}
            className={range}
          />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label={t("opt.maxSide")}>
          <input
            type="number"
            className={sel}
            min={0}
            step={10}
            value={params.maxDimension ?? ""}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => set({ maxDimension: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
        </Field>
      </FieldRow>
    </div>
  );
}

/* ── 图片转换（极简：格式 + 质量档）────────────── */

const IMAGE_TIER_QUALITY: Record<QualityTier, number> = { high: 90, balanced: 80, compact: 60 };

function tierOfImage(p: ImageParams): QualityTier {
  if (p.quality === IMAGE_TIER_QUALITY.high) return "high";
  if (p.quality === IMAGE_TIER_QUALITY.compact) return "compact";
  return "balanced";
}

export function ImageConvertOptions({ params, onChange }: {
  params: ImageParams;
  onChange: (p: ImageParams) => void;
}) {
  const { t } = useI18n();
  const isPng = params.format === "png";

  const changeFormat = (format: string) =>
    onChange({ ...params, format, quality: format === "png" ? 100 : IMAGE_TIER_QUALITY.balanced });

  return (
    <div className="space-y-3">
      <FieldRow>
        <Field label={t("opt.format")}>
          <select className={sel} value={params.format} onChange={(e) => changeFormat(e.target.value)}>
            <option value="webp">WebP</option>
            <option value="jpeg">JPEG</option>
            <option value="png">PNG</option>
            <option value="avif">AVIF</option>
          </select>
        </Field>
        {!isPng && (
          <Field label={t("opt.tier")}>
            <TierPicker
              value={tierOfImage(params)}
              onChange={(tier) => onChange({ ...params, quality: IMAGE_TIER_QUALITY[tier] })}
            />
          </Field>
        )}
      </FieldRow>
      {isPng && (
        <p className="text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
          {t("opt.image.pngLossless")}
        </p>
      )}
      <p className="text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
        {t("opt.convert.autoHint")}
      </p>
    </div>
  );
}

/* ── 音频压缩（保持格式降码率）────────────────── */

export function AudioCompressOptions({ params, onChange }: {
  params: AudioParams;
  onChange: (p: AudioParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<AudioParams>) => onChange({ ...params, ...patch });

  return (
    <div className="space-y-3">
      <FieldRow>
        <Field label={t("opt.format")}>
          <SourceFormatChip label={t("opt.format.sourceKeep")} />
        </Field>
        <Field label={t("opt.bitrate")}>
          <input type="number" className={sel} min={32} value={params.bitrateKbps ?? 128} onFocus={(e) => e.currentTarget.select()} onChange={(e) => set({ bitrateKbps: Number(e.target.value) })} />
        </Field>
      </FieldRow>
    </div>
  );
}

/* ── 音频转换（极简：仅选格式，码率自动）────────── */

const AUDIO_CONVERT_KBPS: Record<string, number> = { mp3: 192, aac: 128, m4a: 128, opus: 128 };

export function AudioConvertOptions({ params, onChange }: {
  params: AudioParams;
  onChange: (p: AudioParams) => void;
}) {
  const { t } = useI18n();

  const changeFormat = (format: string) =>
    onChange({ ...params, format, bitrateKbps: AUDIO_CONVERT_KBPS[format] ?? params.bitrateKbps });

  return (
    <div className="space-y-3">
      <Field label={t("opt.format")}>
        <select className={sel} value={params.format} onChange={(e) => changeFormat(e.target.value)}>
          <option value="mp3">MP3</option>
          <option value="aac">AAC</option>
          <option value="m4a">M4A</option>
          <option value="opus">Opus</option>
          <option value="flac">FLAC</option>
        </select>
      </Field>
      <p className="text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
        {t("opt.audio.autoBitrate")}
      </p>
    </div>
  );
}
