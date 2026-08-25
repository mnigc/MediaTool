import { useI18n } from "../../i18n";
import type { AudioTrimParams } from "../../types";
import { Field, FieldRow, NumInput } from "./ui";

export default function AudioTrimPanel({
  params,
  onChange,
}: {
  params: AudioTrimParams;
  onChange: (p: AudioTrimParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<AudioTrimParams>) => onChange({ ...params, ...patch });
  return (
    <div className="space-y-3">
      <FieldRow>
        <Field label={t("opt.startSec")}>
          <NumInput value={params.startTime} min={0} step={0.1} onChange={(v) => set({ startTime: v ?? 0 })} />
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
    </div>
  );
}
