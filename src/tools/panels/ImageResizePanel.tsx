import { useI18n } from "../../i18n";
import type { ImageResizeParams } from "../../types";
import { Field, FieldRow, NumInput, sel } from "./ui";

export default function ImageResizePanel({
  params,
  onChange,
}: {
  params: ImageResizeParams;
  onChange: (p: ImageResizeParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<ImageResizeParams>) => onChange({ ...params, ...patch });
  return (
    <div className="space-y-3">
      <Field label={t("opt.resizeMode")}>
        <select
          className={sel}
          value={params.mode}
          onChange={(e) => set({ mode: e.target.value as ImageResizeParams["mode"] })}
        >
          <option value="longest">{t("opt.resizeMode.longest")}</option>
          <option value="exact">{t("opt.resizeMode.exact")}</option>
          <option value="percent">{t("opt.resizeMode.percent")}</option>
        </select>
      </Field>
      {params.mode === "longest" && (
        <Field label={t("opt.longestSide")}>
          <NumInput value={params.width} min={1} onChange={(v) => set({ width: v ?? 1280 })} />
        </Field>
      )}
      {params.mode === "exact" && (
        <FieldRow>
          <Field label={t("opt.width")}>
            <NumInput value={params.width} min={1} onChange={(v) => set({ width: v })} />
          </Field>
          <Field label={t("opt.height")}>
            <NumInput value={params.height} min={1} onChange={(v) => set({ height: v })} />
          </Field>
        </FieldRow>
      )}
      {params.mode === "percent" && (
        <Field label={t("opt.percent")}>
          <NumInput value={params.percent} min={1} max={1000} onChange={(v) => set({ percent: v ?? 100 })} />
        </Field>
      )}
    </div>
  );
}
