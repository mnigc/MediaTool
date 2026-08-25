import { useI18n } from "../../i18n";
import type { PitchParams } from "../../types";
import { Field, FieldRow, NumInput } from "./ui";

export default function AudioPitchPanel({
  params,
  onChange,
}: {
  params: PitchParams;
  onChange: (p: PitchParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<PitchParams>) => onChange({ ...params, ...patch });
  return (
    <div className="space-y-3">
      <FieldRow>
        <Field label={t("opt.speed")}>
          <NumInput value={params.speed} min={0.5} max={2} step={0.05} onChange={(v) => set({ speed: v ?? 1 })} />
        </Field>
        <Field label={t("opt.pitch")}>
          <NumInput value={params.pitch} min={-12} max={12} step={1} onChange={(v) => set({ pitch: v ?? 0 })} />
        </Field>
      </FieldRow>
    </div>
  );
}
