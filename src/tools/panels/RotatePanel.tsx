import { useI18n } from "../../i18n";
import type { RotateParams } from "../../types";
import { Field, sel } from "./ui";

const TRANSFORMS: Array<{ value: RotateParams["transform"]; key: string }> = [
  { value: "90c", key: "tool.rotate.90c" },
  { value: "90cc", key: "tool.rotate.90cc" },
  { value: "180", key: "tool.rotate.180" },
  { value: "hflip", key: "tool.rotate.hflip" },
  { value: "vflip", key: "tool.rotate.vflip" },
];

export default function RotatePanel({
  params,
  onChange,
}: {
  params: RotateParams;
  onChange: (p: RotateParams) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="space-y-3">
      <Field label={t("tool.rotate.transform")}>
        <select
          className={sel}
          value={params.transform}
          onChange={(e) => onChange({ transform: e.target.value as RotateParams["transform"] })}
        >
          {TRANSFORMS.map((o) => (
            <option key={o.value} value={o.value}>
              {t(o.key)}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
        {t("tool.rotate.hint")}
      </p>
    </div>
  );
}
