import { useState, type ReactNode } from "react";
import type { AudioParams, ImageParams, JobParams, MediaType, VideoParams } from "../types";
import { addPreset, loadPresets, removePreset, type Preset } from "../lib/presets";
import { blankParams } from "../lib/defaults";
import { useI18n } from "../i18n";

const DEFAULT_PRESET = "__default__";

interface Props {
  mediaType: string;
  params: JobParams;
  onChange: (p: JobParams) => void;
}

export default function OptionsPanel({ mediaType, params, onChange }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [presetsExpanded, setPresetsExpanded] = useState(false);

  const renderContent = () => {
    if (mediaType === "video") return <VideoOptionsCompact params={params} onChange={onChange} />;
    if (mediaType === "image") return <ImageOptionsCompact params={params as ImageParams} onChange={onChange} />;
    if (mediaType === "audio") return <AudioOptionsCompact params={params as AudioParams} onChange={onChange} />;
    return null;
  };

  return (
    <div className="flex flex-col gap-3">
      <PresetsBar
        mediaType={mediaType}
        params={params}
        onChange={onChange}
        expanded={presetsExpanded}
        onToggle={() => setPresetsExpanded(!presetsExpanded)}
      />
      <SettingsCollapsible expanded={expanded} onToggle={() => setExpanded(!expanded)}>
        {renderContent()}
      </SettingsCollapsible>
    </div>
  );
}

/* ── 预设面板 ─────────────────────────────────── */

function PresetsBar({
  mediaType,
  params,
  onChange,
  expanded,
  onToggle,
}: {
  mediaType: string;
  params: JobParams;
  onChange: (p: JobParams) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const [presets, setPresets] = useState<Preset[]>(() => loadPresets());
  const [selected, setSelected] = useState<string>(DEFAULT_PRESET);

  const myPresets = presets.filter((p) => p.mediaType === mediaType);
  const selectedPreset = myPresets.find((p) => p.name === selected);

  const apply = (name: string) => {
    if (name === DEFAULT_PRESET) {
      onChange(blankParams(mediaType as MediaType));
      return;
    }
    const p = myPresets.find((x) => x.name === name);
    if (p) onChange(p.params);
  };

  const save = () => {
    const name = window.prompt(t("pm.presetName"), `${mediaType} ${t("pm.presetName")}`);
    if (!name) return;
    setPresets(addPreset({ name, mediaType: mediaType as Preset["mediaType"], params }));
    setSelected(name);
  };

  const del = (name: string) => {
    setPresets(removePreset(mediaType as Preset["mediaType"], name));
    if (selected === name) setSelected("");
  };

  return (
    <div
      className="rounded-lg border border-neutral-200/70 bg-neutral-50/40 p-2.5 dark:border-neutral-700/70 dark:bg-neutral-800/40"
      data-od-id="presets-panel"
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
          {t("opt.presets")}
        </span>
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1 text-[10px] font-medium text-neutral-400 transition hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
        >
          <svg
            viewBox="0 0 16 16"
            className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
            fill="currentColor"
          >
            <path d="M4 6l4 4 4-4z" />
          </svg>
          {expanded ? t("opt.collapse") : t("opt.expand")}
        </button>
      </div>
      <div
        className={`overflow-hidden transition-all duration-200 ${
          expanded ? "max-h-[120px] opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <select
              value={selected === DEFAULT_PRESET ? "" : selected}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) {
                  setSelected(DEFAULT_PRESET);
                  apply(DEFAULT_PRESET);
                } else {
                  setSelected(v);
                  apply(v);
                }
              }}
              className="min-w-[110px] rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-xs text-neutral-700 transition focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:focus:border-brand-500"
            >
              <option value="">{t("opt.selectPreset")}</option>
              {myPresets.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          <button
            type="button"
            onClick={save}
            className="rounded-md border border-brand-200 bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-700 transition hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
          >
            {t("opt.saveCurrent")}
          </button>
          {selected && selected !== DEFAULT_PRESET && (
            <button
              type="button"
              onClick={() => del(selected)}
              disabled={selectedPreset?.builtin}
              className="rounded px-1.5 py-0.5 text-[10px] font-medium text-neutral-400 transition hover:text-error-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-neutral-400 dark:text-neutral-500 dark:hover:text-error-400"
            >
              {t("opt.delete")}
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => { setSelected(DEFAULT_PRESET); apply(DEFAULT_PRESET); }}
          className={`rounded-md px-2 py-0.5 text-[10px] font-medium transition ${
            selected === DEFAULT_PRESET
              ? "bg-brand-600 text-white dark:bg-brand-500"
              : "border border-neutral-200 bg-white text-neutral-600 hover:border-brand-200 hover:bg-brand-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:border-brand-800 dark:hover:bg-brand-950/40"
          }`}
        >
          {t("opt.defaultPreset")}
        </button>
        {myPresets.length > 0 &&
          myPresets.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => { setSelected(p.name); apply(p.name); }}
              className={`rounded-md px-2 py-0.5 text-[10px] font-medium transition ${
                selected === p.name
                  ? "bg-brand-600 text-white dark:bg-brand-500"
                  : "border border-neutral-200 bg-white text-neutral-600 hover:border-brand-200 hover:bg-brand-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:border-brand-800 dark:hover:bg-brand-950/40"
              }`}
            >
              {p.name}
            </button>
          ))}
        {myPresets.length > 0 && (
          <button
            type="button"
            onClick={save}
            className="rounded-md border border-dashed border-neutral-300 px-2 py-0.5 text-[10px] font-medium text-neutral-500 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-600 dark:border-neutral-600 dark:text-neutral-400 dark:hover:border-brand-700 dark:hover:bg-brand-950/30 dark:hover:text-brand-300"
          >
            + {t("opt.savePlus")}
          </button>
        )}
      </div>
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
        className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left transition hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
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
        <div className="rounded-lg border border-neutral-100 bg-white p-3 pt-2.5 dark:border-neutral-700/60 dark:bg-neutral-800/30">
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

function SectionDivider({ label, action }: { label: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">{label}</span>
      {action}
    </div>
  );
}

const sel =
  "w-full select-text rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-700 transition focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:focus:border-brand-500";

const range = "mp-range flex-1";

/* ── 视频参数 ───────────────────────────────────── */

export function VideoOptionsCompact({
  params,
  onChange,
}: {
  params: JobParams;
  onChange: (p: JobParams) => void;
}) {
  const { t } = useI18n();
  const v = params as VideoParams;
  const set = (patch: Partial<VideoParams>) => onChange({ ...params, ...patch });

  if (v.extractAudio) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between rounded-md bg-brand-50 px-3 py-2 text-[11px] font-medium text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
          <span>{t("opt.extractAudioOnly")}</span>
          <button
            type="button"
            onClick={() => set({ extractAudio: false })}
            className="text-brand-500 underline-offset-2 hover:underline dark:text-brand-400"
          >
            {t("opt.backToVideo")}
          </button>
        </div>
        <FieldRow>
          <Field label={t("opt.format")}>
            <select className={sel} value={v.extractFormat ?? "mp3"} onChange={(e) => set({ extractFormat: e.target.value })}>
              <option value="mp3">MP3</option>
              <option value="aac">AAC</option>
              <option value="m4a">M4A</option>
              <option value="opus">Opus</option>
              <option value="flac">FLAC</option>
            </select>
          </Field>
          <Field label={t("opt.bitrate")}>
            <input type="number" className={sel} min={32} value={v.audioBitrateKbps ?? 128} onChange={(e) => set({ audioBitrateKbps: Number(e.target.value) })} />
          </Field>
        </FieldRow>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <SectionDivider
        label={t("opt.videoOutput")}
        action={
          <button
            type="button"
            onClick={() => set({ extractAudio: true, extractFormat: v.extractFormat ?? "mp3" })}
            className="text-[10px] font-medium text-neutral-400 underline-offset-2 hover:text-neutral-700 hover:underline dark:text-neutral-500 dark:hover:text-neutral-300"
          >
            {t("opt.switchExtract")}
          </button>
        }
      />

      <FieldRow>
        <Field label={t("opt.format")}>
          <select className={sel} value={v.format} onChange={(e) => set({ format: e.target.value })}>
            <option value="mp4">MP4</option>
            <option value="mkv">MKV</option>
            <option value="webm">WebM</option>
            <option value="mov">MOV</option>
          </select>
        </Field>
        <Field label={t("opt.codec")}>
          <select className={sel} value={v.videoCodec} onChange={(e) => set({ videoCodec: e.target.value })}>
            <option value="libx264">H.264</option>
            <option value="libvpx-vp9">VP9</option>
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

      <div className="space-y-2 rounded-lg bg-neutral-50 p-2.5 dark:bg-neutral-800/40">
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

      <SectionDivider label={t("opt.trim")} />
      <FieldRow>
        <Field label={t("opt.startSec")}>
          <input type="number" className={sel} min={0} step={0.1} placeholder={t("opt.toEnd")} value={v.startTime ?? ""} onFocus={(e) => e.currentTarget.select()} onChange={(e) => set({ startTime: e.target.value ? Number(e.target.value) : undefined })} />
        </Field>
        <Field label={t("opt.durationSec")}>
          <input type="number" className={sel} min={0.1} step={0.1} placeholder={t("opt.toEnd")} value={v.duration ?? ""} onFocus={(e) => e.currentTarget.select()} onChange={(e) => set({ duration: e.target.value ? Number(e.target.value) : undefined })} />
        </Field>
      </FieldRow>
    </div>
  );
}

/* ── 图片参数（紧凑） ───────────────────────────── */

export function ImageOptionsCompact({ params, onChange }: {
  params: ImageParams;
  onChange: (p: ImageParams) => void;
}) {
  const { t } = useI18n();
  const img = params;
  const set = (patch: Partial<ImageParams>) => onChange({ ...params, ...patch });

  return (
    <div className="space-y-3">
      <FieldRow>
        <Field label={t("opt.format")}>
          <select className={sel} value={img.format} onChange={(e) => set({ format: e.target.value })}>
            <option value="keep">保持原格式</option>
            <option value="jpeg">JPEG</option>
            <option value="png">PNG</option>
            <option value="webp">WebP</option>
          </select>
        </Field>
        {img.format !== "png" && (
          <Field label={t("opt.quality", { n: img.quality })}>
            <input
              type="range"
              min={1}
              max={100}
              value={img.quality}
              onChange={(e) => set({ quality: Number(e.target.value) })}
              className={range}
            />
          </Field>
        )}
      </FieldRow>
      <FieldRow>
        <Field label={t("opt.maxSide")}>
          <input
            type="number"
            className={sel}
            min={0}
            step={10}
            value={img.maxDimension ?? ""}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => set({ maxDimension: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
        </Field>
      </FieldRow>
    </div>
  );
}

/* ── 音频参数（紧凑） ───────────────────────────── */

export function AudioOptionsCompact({ params, onChange }: {
  params: AudioParams;
  onChange: (p: AudioParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<AudioParams>) => onChange({ ...params, ...patch });

  return (
    <div className="space-y-3">
      <FieldRow>
        <Field label={t("opt.format")}>
          <select className={sel} value={params.format} onChange={(e) => set({ format: e.target.value })}>
            <option value="mp3">MP3</option>
            <option value="aac">AAC</option>
            <option value="m4a">M4A</option>
            <option value="opus">Opus</option>
            <option value="flac">FLAC</option>
          </select>
        </Field>
        <Field label={t("opt.bitrate")}>
          <input type="number" className={sel} min={32} value={params.bitrateKbps ?? 192} onChange={(e) => set({ bitrateKbps: Number(e.target.value) })} />
        </Field>
      </FieldRow>
    </div>
  );
}
