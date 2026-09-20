import { useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { defaultParamsFor } from "../lib/defaults";
import Select from "./Select";
import { NumInput } from "../tools/panels/ui";
import type { JobParams, ToolId } from "../types";

/* Preset editing as a diff view: instead of re-showing the whole tool panel,
 * list only the fields the preset overrides (vs the tool defaults), with an
 * "add parameter" menu. A preset is still stored as a full param object —
 * the diff is derived, so defaults can evolve without migrating every stored
 * preset. Per-field 恢复 reverts to the preset's own original value (the
 * `original` baseline), never to the tool default; only 移除 takes an added
 * field back to default. */

interface Opt {
  value: string;
  label?: string;
  labelKey?: string;
}

type Control =
  | { kind: "select"; options: Opt[]; numeric?: boolean }
  | { kind: "number"; min?: number; max?: number; step?: number }
  /** min/max/step are in display units; `divide` converts to stored
   *  (e.g. opacity displays 50% stored as 0.5). */
  | { kind: "range"; min: number; max: number; step?: number; suffix?: string; divide?: number };

interface FieldDef {
  key: string;
  labelKey: string;
  control: Control;
}

const AUDIO_FORMATS_PLAIN: Opt[] = [
  { value: "mp3", label: "MP3" },
  { value: "aac", label: "AAC" },
  { value: "m4a", label: "M4A" },
  { value: "opus", label: "Opus" },
  { value: "flac", label: "FLAC" },
];

const FIELD_TABLES: Record<string, FieldDef[]> = {
  "video-compress": [
    {
      key: "videoCodec",
      labelKey: "opt.codec",
      control: {
        kind: "select",
        options: [
          { value: "libx264", label: "H.264" },
          { value: "libx265", label: "H.265 (HEVC)" },
          { value: "libvpx-vp9", label: "VP9" },
          { value: "libsvtav1", label: "AV1" },
          { value: "copy", labelKey: "opt.copy" },
        ],
      },
    },
    {
      key: "qualityMode",
      labelKey: "opt.qualityMode",
      control: {
        kind: "select",
        options: [
          { value: "crf", labelKey: "opt.crf" },
          { value: "target_size", labelKey: "opt.targetSize" },
          { value: "bitrate", labelKey: "opt.fixedBitrate" },
        ],
      },
    },
    { key: "crf", labelKey: "opt.crf", control: { kind: "range", min: 18, max: 40 } },
    { key: "targetSizeMb", labelKey: "opt.targetSizeMb", control: { kind: "number", min: 1 } },
    { key: "videoBitrateKbps", labelKey: "opt.bitrate", control: { kind: "number", min: 100 } },
    {
      key: "resolution",
      labelKey: "opt.resolution",
      control: {
        kind: "select",
        options: [
          { value: "original", labelKey: "opt.res.original" },
          ...["2160p", "1440p", "1080p", "720p", "480p"].map((r) => ({ value: r, label: r })),
        ],
      },
    },
    {
      key: "format",
      labelKey: "opt.format",
      control: {
        kind: "select",
        options: [
          { value: "source", labelKey: "opt.format.source" },
          ...["mp4", "mkv", "webm", "mov"].map((f) => ({ value: f, label: f.toUpperCase() })),
        ],
      },
    },
    {
      key: "preset",
      labelKey: "opt.speed",
      control: {
        kind: "select",
        options: ["veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"].map(
          (s) => ({ value: s, labelKey: `opt.speed.${s}` })
        ),
      },
    },
    {
      key: "fps",
      labelKey: "opt.fps",
      control: {
        kind: "select",
        numeric: true,
        options: [
          { value: "", labelKey: "opt.fps.original" },
          ...["60", "50", "30", "24", "15"].map((f) => ({ value: f, label: f })),
        ],
      },
    },
    {
      key: "audioCodec",
      labelKey: "opt.audioCodec",
      control: {
        kind: "select",
        options: [
          { value: "aac", label: "AAC" },
          { value: "opus", label: "Opus" },
          { value: "copy", labelKey: "opt.copy" },
          { value: "none", labelKey: "opt.remove" },
        ],
      },
    },
    { key: "audioBitrateKbps", labelKey: "opt.audioBitrate", control: { kind: "number", min: 32 } },
  ],
  "audio-compress": [
    {
      key: "format",
      labelKey: "opt.format",
      control: {
        kind: "select",
        options: [{ value: "source", labelKey: "opt.format.source" }, ...AUDIO_FORMATS_PLAIN],
      },
    },
    { key: "bitrateKbps", labelKey: "opt.bitrate", control: { kind: "number", min: 32, step: 32 } },
  ],
  "extract-audio": [
    { key: "format", labelKey: "opt.format", control: { kind: "select", options: AUDIO_FORMATS_PLAIN } },
    { key: "bitrateKbps", labelKey: "opt.bitrate", control: { kind: "number", min: 32, step: 32 } },
  ],
  watermark: [
    {
      key: "position",
      labelKey: "tool.wm.position",
      control: {
        kind: "select",
        options: ["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"].map((p) => ({
          value: p,
          labelKey: `opt.pos.${p}`,
        })),
      },
    },
    { key: "scalePercent", labelKey: "tool.wm.scale", control: { kind: "range", min: 5, max: 60, suffix: "%" } },
    { key: "opacity", labelKey: "tool.wm.opacity", control: { kind: "range", min: 5, max: 100, suffix: "%", divide: 100 } },
    { key: "marginPercent", labelKey: "tool.wm.margin", control: { kind: "number", min: 0, max: 30 } },
  ],
  "video-contact": [
    {
      key: "mode",
      labelKey: "opt.contactMode",
      control: {
        kind: "select",
        options: [
          { value: "count", labelKey: "opt.contactMode.count" },
          { value: "interval", labelKey: "opt.contactMode.interval" },
        ],
      },
    },
    { key: "interval", labelKey: "opt.contactInterval", control: { kind: "number", min: 0.1, max: 60, step: 0.5 } },
    { key: "count", labelKey: "opt.contactCount", control: { kind: "number", min: 1, max: 400 } },
    { key: "countCols", labelKey: "opt.contactCountCols", control: { kind: "number", min: 1, max: 20 } },
    { key: "cols", labelKey: "opt.contactCols", control: { kind: "number", min: 1, max: 16 } },
    { key: "rows", labelKey: "opt.contactRows", control: { kind: "number", min: 1, max: 16 } },
    { key: "thumbW", labelKey: "opt.contactThumb", control: { kind: "number", min: 32, max: 640, step: 8 } },
  ],
};

export default function PresetDiffEditor({
  toolId,
  params,
  original,
  onChange,
}: {
  toolId: string;
  params: JobParams;
  /** The preset's stored params when editing began — the baseline that
   *  per-field 恢复 returns to. */
  original: JobParams;
  onChange: (p: JobParams) => void;
}) {
  const { t } = useI18n();
  /** Fields kept visible even while equal to the tool default: ones the user
   *  added from the menu, so the add action is never a no-op surprise. */
  const [kept, setKept] = useState<string[]>([]);
  const defaults = useMemo(
    () => defaultParamsFor(toolId as ToolId) as Record<string, unknown>,
    [toolId]
  );
  const fields = FIELD_TABLES[toolId] ?? [];
  const p = params as Record<string, unknown>;
  const base = original as Record<string, unknown>;
  const norm = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  const valueOf = (k: string) => (p[k] === undefined ? defaults[k] : p[k]);
  const isDiff = (k: string) => norm(valueOf(k)) !== norm(defaults[k]);
  const isChanged = (k: string) => norm(valueOf(k)) !== norm(base[k]);

  const set = (k: string, value: unknown) => {
    const next: Record<string, unknown> = { ...p, [k]: value };
    // WebM strictly requires VP9+Opus — keep the same coupling as the tool panel.
    if (toolId === "video-compress" && k === "format" && value === "webm") {
      next.videoCodec = "libvpx-vp9";
      next.audioCodec = "opus";
    }
    onChange(next as JobParams);
  };

  /** Undo the edit to this field: back to the preset's own stored value. */
  const revert = (k: string) => set(k, base[k]);

  /** Take an added-but-unchanged field out of the list again. */
  const drop = (k: string) => setKept((a) => a.filter((x) => x !== k));

  const rows = fields.filter((f) => isDiff(f.key) || kept.includes(f.key));
  const rest = fields.filter((f) => !isDiff(f.key) && !kept.includes(f.key));

  const optLabel = (o: Opt) => (o.labelKey ? t(o.labelKey) : o.label ?? o.value);

  const control = (f: FieldDef): ReactNode => {
    const v = valueOf(f.key);
    const c = f.control;
    if (c.kind === "select") {
      return (
        <Select
          className="w-full"
          value={norm(v)}
          onChange={(nv) => set(f.key, c.numeric ? (nv === "" ? undefined : Number(nv)) : nv)}
        >
          {c.options.map((o) => (
            <option key={o.value} value={o.value}>
              {optLabel(o)}
            </option>
          ))}
        </Select>
      );
    }
    if (c.kind === "number") {
      return (
        <NumInput
          value={typeof v === "number" ? v : undefined}
          min={c.min}
          max={c.max}
          step={c.step}
          onChange={(nv) => set(f.key, nv)}
        />
      );
    }
    const stored = Number(v ?? c.min);
    const shown = c.divide ? Math.round(stored * c.divide) : stored;
    return (
      <div className="flex items-center gap-2">
        <input
          type="range"
          className="mp-range flex-1"
          min={c.min}
          max={c.max}
          step={c.step ?? 1}
          value={shown}
          onChange={(e) => {
            const n = Number(e.target.value);
            set(f.key, c.divide ? n / c.divide : n);
          }}
        />
        <span className="w-11 shrink-0 text-right text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
          {shown}
          {c.suffix ?? ""}
        </span>
      </div>
    );
  };

  return (
    <div className="space-y-2">
      {rows.length === 0 && (
        <p className="text-[11px] text-neutral-400 dark:text-neutral-500">{t("pm.diffEmpty")}</p>
      )}
      {rows.map((f) => {
        const pending = !isDiff(f.key);
        const changed = !pending && isChanged(f.key);
        return (
          <div key={f.key} className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-xs font-medium leading-tight text-neutral-600 dark:text-neutral-300">
              {t(f.labelKey)}
            </span>
            <div className={`min-w-0 flex-1 ${pending ? "opacity-50" : ""}`}>{control(f)}</div>
            {pending && (
              <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500">
                {t("pm.defaultTag")}
              </span>
            )}
            {changed && (
              <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-600 dark:bg-brand-950/40 dark:text-brand-400">
                {t("preset.modified")}
              </span>
            )}
            {pending ? (
              <button
                type="button"
                onClick={() => drop(f.key)}
                className="shrink-0 rounded-md px-1.5 py-1 text-[10px] font-medium text-neutral-400 transition hover:text-brand-600 dark:hover:text-brand-300"
              >
                {t("opt.remove")}
              </button>
            ) : changed ? (
              <button
                type="button"
                onClick={() => revert(f.key)}
                className="shrink-0 rounded-md px-1.5 py-1 text-[10px] font-medium text-neutral-400 transition hover:text-brand-600 dark:hover:text-brand-300"
              >
                {t("pm.revertField")}
              </button>
            ) : null}
          </div>
        );
      })}
      {rest.length > 0 && (
        <Select
          value=""
          onChange={(v) => {
            if (v) setKept((a) => (a.includes(v) ? a : [...a, v]));
          }}
          className="max-w-60"
          triggerClassName="text-[10px] py-1.5"
        >
          <option value="">{t("pm.pickField")}</option>
          {rest.map((f) => (
            <option key={f.key} value={f.key}>
              {t(f.labelKey)}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}
