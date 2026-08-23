import { useI18n } from "../../i18n";
import type { ScreenshotParams } from "../../types";
import { Field, FieldRow, NumInput, sel } from "./ui";

export default function ScreenshotPanel({
  params,
  onChange,
}: {
  params: ScreenshotParams;
  onChange: (p: ScreenshotParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<ScreenshotParams>) => onChange({ ...params, ...patch });

  return (
    <div className="space-y-3">
      <FieldRow>
        <Field label={t("tool.shot.mode")}>
          <select
            className={sel}
            value={params.mode}
            onChange={(e) => set({ mode: e.target.value as ScreenshotParams["mode"] })}
          >
            <option value="single">{t("tool.shot.single")}</option>
            <option value="interval">{t("tool.shot.interval")}</option>
          </select>
        </Field>
        <Field label={t("opt.format")}>
          <select
            className={sel}
            value={params.format}
            onChange={(e) => set({ format: e.target.value })}
          >
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
          </select>
        </Field>
      </FieldRow>

      {params.mode === "single" ? (
        <Field label={t("tool.shot.at")}>
          <NumInput value={params.atSec} min={0} step={0.1} onChange={(v) => set({ atSec: v })} />
        </Field>
      ) : (
        <>
          <FieldRow>
            <Field label={t("tool.shot.every")}>
              <NumInput value={params.everySec} min={0.1} step={0.5} onChange={(v) => set({ everySec: v })} />
            </Field>
            <Field label={t("opt.startSec")}>
              <NumInput value={params.startSec} min={0} step={1} onChange={(v) => set({ startSec: v })} />
            </Field>
          </FieldRow>
          <Field label={t("tool.shot.end")}>
            <NumInput value={params.endSec} min={0} step={1} placeholder={t("opt.toEnd")} onChange={(v) => set({ endSec: v })} />
          </Field>
        </>
      )}

      <Field label={t("opt.maxSide")}>
        <NumInput value={params.maxWidth} min={16} step={16} placeholder={t("opt.res.original")} onChange={(v) => set({ maxWidth: v })} />
      </Field>
    </div>
  );
}
