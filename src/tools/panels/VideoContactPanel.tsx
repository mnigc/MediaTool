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
  return (
    <div className="space-y-3">
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
