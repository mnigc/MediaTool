import { useI18n } from "../../i18n";
import type { TrimParams, TrimSegment } from "../../types";
import { Field, NumInput, sel } from "./ui";

export default function TrimPanel({
  params,
  onChange,
}: {
  params: TrimParams;
  onChange: (p: TrimParams) => void;
}) {
  const { t } = useI18n();

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
    <div className="space-y-3">
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div
            key={i}
            className="rounded-lg border border-neutral-100 bg-neutral-50/50 p-3 dark:border-neutral-700/60 dark:bg-neutral-800/30"
          >
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <Field label={t("opt.startSec")}>
                <NumInput
                  value={row.startTime}
                  min={0}
                  step={0.1}
                  onChange={(v) => setRow(i, { startTime: v ?? 0 })}
                />
              </Field>
              <Field label={t("opt.durationSec")}>
                <NumInput
                  value={row.duration}
                  min={0.1}
                  step={0.1}
                  placeholder={t("opt.toEnd")}
                  onChange={(v) => setRow(i, { duration: v })}
                />
              </Field>
              <button
                type="button"
                onClick={() => removeRow(i)}
                disabled={rows.length === 1}
                className="mt-4 shrink-0 self-start rounded-lg px-2 py-1 text-xs text-neutral-400 transition hover:text-error-500 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={t("opt.removeSegment")}
              >
                ✕
              </button>
            </div>
            {i === 0 && (
              <p className="mt-1 text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                {t("opt.startSecHint")}
              </p>
            )}
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addRow}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-neutral-200 py-1.5 text-xs font-medium text-neutral-500 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-600 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-brand-700 dark:hover:bg-brand-950/30 dark:hover:text-brand-300"
      >
        + {t("opt.addSegment")}
      </button>

      <Field label={t("tool.trim.mode")}>
        <select
          className={sel}
          value={params.mode}
          onChange={(e) => onChange({ ...params, mode: e.target.value as TrimParams["mode"] })}
        >
          <option value="copy">{t("tool.trim.quick")}</option>
          <option value="encode">{t("tool.trim.precise")}</option>
        </select>
      </Field>
      <p className="text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
        {params.mode === "copy" ? t("tool.trim.quickHint") : t("tool.trim.preciseHint")}
      </p>
    </div>
  );
}
