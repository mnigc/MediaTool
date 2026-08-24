import { useI18n } from "../../i18n";
import type { TrimParams } from "../../types";
import { Field, FieldRow, NumInput, sel } from "./ui";

export default function TrimPanel({
  params,
  onChange,
}: {
  params: TrimParams;
  onChange: (p: TrimParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<TrimParams>) => onChange({ ...params, ...patch });

  return (
    <div className="space-y-3">
      <FieldRow>
        <Field label={t("opt.startSec")}>
          <NumInput
            value={params.startTime}
            min={0}
            step={0.1}
            onChange={(v) => set({ startTime: v ?? 0 })}
          />
        </Field>
        <Field label={t("opt.durationSec")}>
          <NumInput
            value={params.duration}
            min={0.1}
            step={0.1}
            placeholder={t("opt.toEnd")}
            onChange={(v) => set({ duration: v })}
          />
        </Field>
      </FieldRow>
      <Field label={t("tool.trim.mode")}>
        <select
          className={sel}
          value={params.mode}
          onChange={(e) => set({ mode: e.target.value as TrimParams["mode"] })}
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
