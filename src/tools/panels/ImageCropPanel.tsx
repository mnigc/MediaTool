import { useI18n } from "../../i18n";
import type { ImageCropParams } from "../../types";
import { Field, FieldRow, NumInput, sel } from "./ui";

const ASPECTS = [
  "1:1", "16:9", "9:16", "4:3", "3:2", "3:4", "21:9", "2.35:1",
  "295:413", "413:579", "358:441", "original",
] as const;

export default function ImageCropPanel({
  params,
  onChange,
}: {
  params: ImageCropParams;
  onChange: (p: ImageCropParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<ImageCropParams>) => onChange({ ...params, ...patch });
  return (
    <div className="space-y-3">
      <Field label={t("opt.cropMode")}>
        <select
          className={sel}
          value={params.mode}
          onChange={(e) => set({ mode: e.target.value as ImageCropParams["mode"] })}
        >
          <option value="center">{t("opt.cropMode.center")}</option>
          <option value="custom">{t("opt.cropMode.custom")}</option>
        </select>
      </Field>
      {params.mode === "center" ? (
        <Field label={t("opt.aspect")}>
          <select
            className={sel}
            value={params.aspect ?? "original"}
            onChange={(e) => set({ aspect: e.target.value as ImageCropParams["aspect"] })}
          >
            {ASPECTS.map((a) => (
              <option key={a} value={a}>
                {a === "original" ? t("opt.aspect.original") : a}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <FieldRow>
          <Field label="X">
            <NumInput value={params.x} min={0} onChange={(v) => set({ x: v })} />
          </Field>
          <Field label="Y">
            <NumInput value={params.y} min={0} onChange={(v) => set({ y: v })} />
          </Field>
          <Field label={t("opt.width")}>
            <NumInput value={params.width} min={1} onChange={(v) => set({ width: v })} />
          </Field>
          <Field label={t("opt.height")}>
            <NumInput value={params.height} min={1} onChange={(v) => set({ height: v })} />
          </Field>
        </FieldRow>
      )}
    </div>
  );
}
