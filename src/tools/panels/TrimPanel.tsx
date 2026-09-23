import { useState } from "react";
import { useI18n } from "../../i18n";
import Select from "../../components/Select";
import type { TrimParams, TrimSegment } from "../../types";
import { NumInput } from "./ui";

export default function TrimPanel({
  params,
  onChange,
}: {
  params: TrimParams;
  onChange: (p: TrimParams) => void;
}) {
  const { t } = useI18n();
  /** Second column lens: an absolute out point (default, what people reach for)
   *  or a length. Only the display changes — `segments` store a duration. */
  const [endMode, setEndMode] = useState(true);

  // Normalize to a segments list. Legacy single-range params (no segments) are
  // shown as one row and rewritten back into `segments` on first edit.
  const rows: TrimSegment[] =
    params.segments && params.segments.length > 0
      ? params.segments
      : [{ startTime: params.startTime, duration: params.duration }];

  const setRows = (next: TrimSegment[]) => {
    onChange({
      ...params,
      startTime: next[0]?.startTime ?? 0,
      duration: next[0]?.duration,
      segments: next,
    });
  };

  const setRow = (i: number, patch: Partial<TrimSegment>) => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    setRows(next);
  };

  const removeRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    setRows(next.length ? next : [{ startTime: 0, duration: undefined }]);
  };

  const addRow = () => {
    const last = rows[rows.length - 1];
    const nextStart = last ? (last.duration ?? 0) + last.startTime : 0;
    setRows([...rows, { startTime: nextStart, duration: undefined }]);
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_1fr_1.75rem] items-center gap-x-2">
        <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
          {t("opt.startSec")}
        </span>
        <Select
          variant="text"
          value={endMode ? "end" : "duration"}
          onChange={(v) => setEndMode(v === "end")}
        >
          <option value="duration">{t("opt.durationSec")}</option>
          <option value="end">{t("opt.endSec")}</option>
        </Select>
      </div>

      <div className="divide-y divide-neutral-200/70 dark:divide-neutral-700/60">
        {rows.map((row, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_1fr_1.75rem] items-center gap-x-2 py-1.5 first:pt-0 last:pb-0"
          >
            <NumInput
              value={row.startTime}
              min={0}
              step={0.1}
              onChange={(v) => setRow(i, { startTime: v ?? 0 })}
            />
            <NumInput
              value={
                endMode && row.duration != null
                  ? row.startTime + row.duration
                  : row.duration
              }
              min={0.1}
              step={0.1}
              placeholder={t("opt.toEnd")}
              onChange={(v) =>
                setRow(i, {
                  duration:
                    endMode && v != null
                      ? Math.max(0.1, v - row.startTime)
                      : v,
                })
              }
            />
            <button
              type="button"
              onClick={() => removeRow(i)}
              disabled={rows.length === 1}
              className="w-7 rounded-lg py-1 text-xs text-neutral-400 transition hover:text-error-500 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={t("opt.removeSegment")}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <p className="text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
        {endMode ? t("opt.endSecHint") : t("opt.startSecHint")}
      </p>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 pt-0.5">
        <button
          type="button"
          onClick={addRow}
          className="rounded-lg border border-dashed border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-500 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-600 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-brand-700 dark:hover:bg-brand-950/30 dark:hover:text-brand-300"
        >
          + {t("opt.addSegment")}
        </button>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
            {t("tool.trim.mode")}
          </span>
          <Select
            className="w-36"
            value={params.mode}
            onChange={(v) => onChange({ ...params, mode: v as TrimParams["mode"] })}
          >
            <option value="copy">{t("tool.trim.quick")}</option>
            <option value="encode">{t("tool.trim.precise")}</option>
          </Select>
        </span>
      </div>

      <p className="text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
        {params.mode === "copy" ? t("tool.trim.quickHint") : t("tool.trim.preciseHint")}
      </p>
    </div>
  );
}
