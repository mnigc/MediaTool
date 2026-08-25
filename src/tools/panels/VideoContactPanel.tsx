import { useI18n } from "../../i18n";
import type { ContactSheetParams } from "../../types";
import { Field, NumInput } from "./ui";

export default function VideoContactPanel({
  params,
  onChange,
}: {
  params: ContactSheetParams;
  onChange: (p: ContactSheetParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<ContactSheetParams>) => onChange({ ...params, ...patch });
  const isCount = params.mode === "count";

  const modeBtn = (active: boolean): string =>
    `rounded-lg px-2.5 py-1.5 text-[10px] font-medium transition ${
      active
        ? "bg-brand-500 text-white dark:bg-brand-600"
        : "border border-neutral-200 bg-white text-neutral-600 hover:border-brand-200 hover:bg-brand-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:border-brand-800 dark:hover:bg-brand-950/40"
    }`;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        {(["interval", "count"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => set({ mode: m })}
            className={modeBtn(params.mode === m)}
          >
            {t(`opt.contactMode.${m}`)}
          </button>
        ))}
      </div>

      {isCount ? (
        <Field label={t("opt.contactCount")}>
          <NumInput
            value={params.count}
            min={1}
            max={400}
            step={1}
            onChange={(v) => set({ count: v ?? 20 })}
          />
        </Field>
      ) : (
        <>
          <Field label={t("opt.contactInterval")}>
            <NumInput
              value={params.interval}
              min={0.1}
              max={60}
              step={0.5}
              onChange={(v) => set({ interval: v ?? 5 })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("opt.contactCols")}>
              <NumInput
                value={params.cols}
                min={1}
                max={16}
                step={1}
                onChange={(v) => set({ cols: v ?? 4 })}
              />
            </Field>
            <Field label={t("opt.contactRows")}>
              <NumInput
                value={params.rows}
                min={1}
                max={16}
                step={1}
                onChange={(v) => set({ rows: v ?? 4 })}
              />
            </Field>
          </div>
        </>
      )}

      <Field label={t("opt.contactThumb")}>
        <NumInput
          value={params.thumbW}
          min={32}
          max={640}
          step={8}
          onChange={(v) => set({ thumbW: v ?? 160 })}
        />
      </Field>
    </div>
  );
}
