import { useState, type ReactNode } from "react";
import type { AudioParams, JobParams, VideoParams } from "../types";
import PresetsBar from "./PresetsBar";
import { presetSummary } from "../lib/presets";
import { useI18n } from "../i18n";
import { useTasks } from "../contexts/TaskCenter";
import Select from "./Select";
import { inputClsSm } from "./ui";

interface Props {
  toolId: string;
  params: JobParams;
  onChange: (p: JobParams) => void;
}

export default function OptionsPanel({ toolId, params, onChange }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const renderContent = () => {
    switch (toolId) {
      case "video-compress":
        return <VideoCompressOptions params={params} onChange={onChange} />;
      case "audio-compress":
        return <AudioCompressOptions params={params as AudioParams} onChange={onChange} />;
      default:
        return null;
    }
  };

  // While collapsed, the header line carries a one-line params summary so
  // multi-task lists stay scannable without expanding every card.
  const summary = expanded ? "" : presetSummary({ name: "", toolId, params, builtin: false }, t);

  return (
    <div className="flex flex-col gap-3">
      <PresetsBar toolId={toolId} params={params} onChange={onChange} />
      <SettingsCollapsible
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        summary={summary}
      >
        {renderContent()}
      </SettingsCollapsible>
    </div>
  );
}

/* ── 设置折叠面板 ─────────────────────────────────── */

function SettingsCollapsible({ expanded, onToggle, summary, children }: {
  expanded: boolean;
  onToggle: () => void;
  summary: string;
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
        <span className="shrink-0 text-xs font-semibold text-neutral-600 dark:text-neutral-300">
          {t("opt.settings")}
        </span>
        {!expanded && summary && (
          <span className="min-w-0 flex-1 truncate px-3 text-right text-[11px] font-normal text-neutral-400 dark:text-neutral-500">
            {summary}
          </span>
        )}
        <svg
          viewBox="0 0 16 16"
          className={`h-3.5 w-3.5 shrink-0 text-neutral-400 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="currentColor"
        >
          <path d="M4 6l4 4 4-4z" />
        </svg>
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="rounded-xl border border-neutral-100 bg-white p-3 dark:border-neutral-700/60 dark:bg-neutral-800/30">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── 字段组件 ─────────────────────────────────── */

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-xs font-medium text-neutral-600 dark:text-neutral-300">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function FieldRow({ cols = 2, children }: { cols?: 2 | 3; children: ReactNode }) {
  return <div className={`grid ${cols === 3 ? "grid-cols-3" : "grid-cols-2"} gap-3`}>{children}</div>;
}

const sel = `${inputClsSm} w-full`;

const range = "mp-range flex-1";

/* ── 视频压缩 ───────────────────────────────────── */

export function VideoCompressOptions({
  params,
  onChange,
}: {
  params: JobParams;
  onChange: (p: JobParams) => void;
}) {
  const { t } = useI18n();
  const tasks = useTasks();
  const v = params as VideoParams;
  const set = (patch: Partial<VideoParams>) => onChange({ ...params, ...patch } as JobParams);
  const changeFormat = (format: string) => {
    // WebM strictly requires VP9+Opus, so switching containers brings the
    // codecs along; other containers keep the current codec choice.
    if (format === "webm") set({ format, videoCodec: "libvpx-vp9", audioCodec: "opus" });
    else set({ format });
  };
  // The backend silently swaps libx264 for the GPU encoder when the sidebar
  // picked one — surface that here, since the codec select still says "H.264".
  const gpuName = tasks.settings.gpu ? t(`gpu.${tasks.settings.gpu}`) : "";

  return (
    <div className="space-y-2">
      <FieldRow cols={3}>
        <Field label={t("opt.format")}>
          <Select className="w-full" value={v.format} onChange={changeFormat}>
            <option value="source">{t("opt.format.source")}</option>
            <option value="mp4">MP4</option>
            <option value="mkv">MKV</option>
            <option value="webm">WebM</option>
            <option value="mov">MOV</option>
          </Select>
        </Field>
        <Field label={t("opt.codec")}>
          <Select className="w-full" value={v.videoCodec} onChange={(v) => set({ videoCodec: v })}>
            <option value="libx264">H.264</option>
            <option value="libx265">H.265 (HEVC)</option>
            <option value="libvpx-vp9">VP9</option>
            <option value="libsvtav1">AV1</option>
            <option value="copy">{t("opt.copy")}</option>
          </Select>
        </Field>
        {/* Stream copy ignores every encode-quality knob, so hide them rather
            than render a CRF slider stuck at its fallback value. */}
        {v.videoCodec !== "copy" && (
          <Field label={t("opt.qualityMode")}>
            <Select className="w-full" value={v.qualityMode} onChange={(v) => set({ qualityMode: v })}>
              <option value="crf">{t("opt.crf")}</option>
              <option value="target_size">{t("opt.targetSize")}</option>
              <option value="bitrate">{t("opt.fixedBitrate")}</option>
            </Select>
          </Field>
        )}
      </FieldRow>
      {/* Kept outside the field rows: inside one it distorts the grid and
          shoves the select out of the card. */}
      {gpuName && (v.videoCodec === "libx264" || v.videoCodec === "libx265") && (
        <p className="-mt-1 text-[10px] text-neutral-400 dark:text-neutral-500">
          {t("opt.gpuActive", { name: gpuName })}
        </p>
      )}

      <div className="space-y-2 rounded-xl bg-neutral-100/70 p-2.5 dark:bg-neutral-800/60">
        {v.videoCodec !== "copy" && v.qualityMode === "crf" && (
          <div>
            <div className="flex items-center gap-3">
              <span className="shrink-0 text-xs font-medium text-neutral-600 dark:text-neutral-300">
                {t("opt.crfQuality", { n: v.crf ?? 28 })}
              </span>
              <input
                type="range"
                min={18}
                max={40}
                value={v.crf ?? 28}
                onChange={(e) => set({ crf: Number(e.target.value) })}
                className={range}
                // The job card is natively draggable for reordering, which
                // hijacks scrubbing into a card drag — clicks still landed but
                // the thumb never followed the pointer. Claiming draggable here
                // makes the slider the drag source, and cancelling the drag
                // hands mouse moves back to the range control.
                draggable={true}
                onDragStart={(e) => e.preventDefault()}
              />
            </div>
            <div className="mt-0.5 flex justify-between text-[10px] text-neutral-400 dark:text-neutral-500">
              <span>18 · {t("opt.crf.hint.low")}</span>
              <span>{t("opt.crf.hint.high")} · 40</span>
            </div>
          </div>
        )}
        {v.videoCodec !== "copy" && v.qualityMode === "target_size" && (
          <Field label={t("opt.targetSizeMb")}>
            <input type="number" className={sel} min={1} value={v.targetSizeMb ?? ""} onFocus={(e) => e.currentTarget.select()} onChange={(e) => set({ targetSizeMb: e.target.value === "" ? undefined : Number(e.target.value) })} />
          </Field>
        )}
        {v.videoCodec !== "copy" && v.qualityMode === "bitrate" && (
          <Field label={t("opt.bitrate")}>
            <input type="number" className={sel} min={100} value={v.videoBitrateKbps ?? ""} onFocus={(e) => e.currentTarget.select()} onChange={(e) => set({ videoBitrateKbps: e.target.value === "" ? undefined : Number(e.target.value) })} />
          </Field>
        )}
        <FieldRow cols={v.videoCodec === "copy" ? 2 : 3}>
          <Field label={t("opt.resolution")}>
            <Select className="w-full" value={v.resolution} onChange={(v) => set({ resolution: v })}>
              <option value="original">{t("opt.res.original")}</option>
              <option value="2160p">2160p</option>
              <option value="1440p">1440p</option>
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
              <option value="480p">480p</option>
            </Select>
          </Field>
          {v.videoCodec !== "copy" && (
            <Field label={t("opt.speed")}>
              <Select className="w-full" value={v.preset} onChange={(v) => set({ preset: v })}>
                <option value="veryfast">{t("opt.speed.veryfast")}</option>
                <option value="faster">{t("opt.speed.faster")}</option>
                <option value="fast">{t("opt.speed.fast")}</option>
                <option value="medium">{t("opt.speed.medium")}</option>
                <option value="slow">{t("opt.speed.slow")}</option>
                <option value="slower">{t("opt.speed.slower")}</option>
                <option value="veryslow">{t("opt.speed.veryslow")}</option>
              </Select>
            </Field>
          )}
          <Field label={t("opt.fps")}>
            <Select className="w-full" value={v.fps ? String(v.fps) : ""} onChange={(v) => set({ fps: v ? Number(v) : undefined })}>
              <option value="">{t("opt.fps.original")}</option>
              <option value="60">60</option>
              <option value="50">50</option>
              <option value="30">30</option>
              <option value="24">24</option>
              <option value="15">15</option>
            </Select>
          </Field>
        </FieldRow>
      </div>

      <FieldRow>
        <Field label={t("opt.audioCodec")}>
          <Select className="w-full" value={v.audioCodec} onChange={(v) => set({ audioCodec: v })}>
            <option value="aac">AAC</option>
            <option value="opus">Opus</option>
            <option value="copy">{t("opt.copy")}</option>
            <option value="none">{t("opt.remove")}</option>
          </Select>
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

/* ── 音频转码（压缩/换格式共用）────────────────── */

export function AudioCompressOptions({ params, onChange }: {
  params: AudioParams;
  onChange: (p: AudioParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<AudioParams>) => onChange({ ...params, ...patch });
  // FLAC is lossless — a bitrate target would be meaningless.
  const showBitrate = params.format !== "flac";

  return (
    <FieldRow>
      <Field label={t("opt.format")}>
        <Select className="w-full" value={params.format} onChange={(f) => set({ format: f })}>
          <option value="source">{t("opt.format.source")}</option>
          <option value="mp3">MP3</option>
          <option value="aac">AAC</option>
          <option value="m4a">M4A</option>
          <option value="opus">Opus</option>
          <option value="flac">FLAC</option>
        </Select>
      </Field>
      {showBitrate && (
        <Field label={t("opt.bitrate")}>
          <input type="number" className={sel} min={32} value={params.bitrateKbps ?? 128} onFocus={(e) => e.currentTarget.select()} onChange={(e) => set({ bitrateKbps: Number(e.target.value) })} />
        </Field>
      )}
    </FieldRow>
  );
}
