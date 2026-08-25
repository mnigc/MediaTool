import { useI18n } from "../../i18n";
import type { ImageRotateParams } from "../../types";
import { Field, sel } from "./ui";

export default function ImageRotatePanel({
  params,
  onChange,
}: {
  params: ImageRotateParams;
  onChange: (p: ImageRotateParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<ImageRotateParams>) => onChange({ ...params, ...patch });
  return (
    <div className="space-y-3">
      <Field label={t("opt.rotate")}>
        <select
          className={sel}
          value={params.transform}
          onChange={(e) => set({ transform: e.target.value as ImageRotateParams["transform"] })}
        >
          <option value="90c">{t("opt.rotate.90c")}</option>
          <option value="90cc">{t("opt.rotate.90cc")}</option>
          <option value="180">{t("opt.rotate.180")}</option>
          <option value="hflip">{t("opt.rotate.hflip")}</option>
          <option value="vflip">{t("opt.rotate.vflip")}</option>
        </select>
      </Field>
    </div>
  );
}
