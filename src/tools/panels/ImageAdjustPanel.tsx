import { useI18n } from "../../i18n";
import type { ImageAdjustParams } from "../../types";
import { Field, FieldRow, NumInput } from "./ui";

export default function ImageAdjustPanel({
  params,
  onChange,
}: {
  params: ImageAdjustParams;
  onChange: (p: ImageAdjustParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<ImageAdjustParams>) => onChange({ ...params, ...patch });
  return (
    <div className="space-y-3">
      <FieldRow>
        <Field label={t("opt.brightness")}>
          <NumInput value={params.brightness} min={-1} max={1} step={0.05} onChange={(v) => set({ brightness: v ?? 0 })} />
        </Field>
        <Field label={t("opt.contrast")}>
          <NumInput value={params.contrast} min={-2} max={2} step={0.05} onChange={(v) => set({ contrast: v ?? 1 })} />
        </Field>
        <Field label={t("opt.saturation")}>
          <NumInput value={params.saturation} min={0} max={3} step={0.05} onChange={(v) => set({ saturation: v ?? 1 })} />
        </Field>
      </FieldRow>
    </div>
  );
}
