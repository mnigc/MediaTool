import { useI18n } from "../../i18n";
import type { GifParams } from "../../types";
import { Field, FieldRow, NumInput, sel } from "./ui";

export default function GifPanel({
  params,
  onChange,
}: {
  params: GifParams;
  onChange: (p: GifParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<GifParams>) => onChange({ ...params, ...patch });

  return (
    <div className="space-y-3">
      <FieldRow>
        <Field label={t("tool.gif.fps")}>
          <select
            className={sel}
            value={params.fps}
            onChange={(e) => set({ fps: Number(e.target.value) })}
          >
            {[10, 12, 15, 20, 24].map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </Field>
        <Field label={t("tool.gif.width")}>
          <select
            className={sel}
            value={params.width}
            onChange={(e) => set({ width: Number(e.target.value) })}
          >
            {[240, 360, 480, 640, 720].map((w) => (
              <option key={w} value={w}>{w}px</option>
            ))}
          </select>
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label={t("opt.startSec")}>
          <NumInput value={params.startTime} min={0} step={0.1} placeholder={t("opt.toEnd")}
            onChange={(v) => set({ startTime: v })} />
        </Field>
        <Field label={t("opt.durationSec")}>
          <NumInput value={params.duration} min={0.1} step={0.1} placeholder={t("opt.toEnd")}
            onChange={(v) => set({ duration: v })} />
        </Field>
      </FieldRow>
    </div>
  );
}
