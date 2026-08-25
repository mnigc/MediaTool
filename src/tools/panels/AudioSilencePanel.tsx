import { useI18n } from "../../i18n";
import type { SilenceParams } from "../../types";
import { Field, FieldRow, NumInput, sel } from "./ui";

export default function AudioSilencePanel({
  params,
  onChange,
}: {
  params: SilenceParams;
  onChange: (p: SilenceParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<SilenceParams>) => onChange({ ...params, ...patch });
  return (
    <div className="space-y-3">
      <Field label={t("opt.silenceMode")}>
        <select
          className={sel}
          value={params.mode}
          onChange={(e) => set({ mode: e.target.value as SilenceParams["mode"] })}
        >
          <option value="remove">{t("opt.silenceMode.remove")}</option>
          <option value="detect">{t("opt.silenceMode.detect")}</option>
        </select>
      </Field>
      {params.mode === "remove" && (
        <FieldRow>
          <Field label={t("opt.threshold")}>
            <NumInput
              value={params.thresholdDb}
              min={-60}
              max={0}
              step={1}
              onChange={(v) => set({ thresholdDb: v ?? -35 })}
            />
          </Field>
          <Field label={t("opt.minLen")}>
            <NumInput value={params.minLen} min={0.05} step={0.1} onChange={(v) => set({ minLen: v ?? 0.5 })} />
          </Field>
        </FieldRow>
      )}
    </div>
  );
}
