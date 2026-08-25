import { useI18n } from "../../i18n";
import type { FadeParams } from "../../types";
import { Field, FieldRow, NumInput } from "./ui";

export default function AudioFadePanel({
  params,
  onChange,
}: {
  params: FadeParams;
  onChange: (p: FadeParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<FadeParams>) => onChange({ ...params, ...patch });
  return (
    <div className="space-y-3">
      <FieldRow>
        <Field label={t("opt.fadeIn")}>
          <NumInput value={params.inSec} min={0} step={0.1} onChange={(v) => set({ inSec: v ?? 0 })} />
        </Field>
        <Field label={t("opt.fadeOut")}>
          <NumInput value={params.outSec} min={0} step={0.1} onChange={(v) => set({ outSec: v ?? 0 })} />
        </Field>
      </FieldRow>
    </div>
  );
}
