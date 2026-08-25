import { useI18n } from "../../i18n";
import type { AudioVolumeParams } from "../../types";
import { Field, NumInput, sel } from "./ui";

export default function AudioVolumePanel({
  params,
  onChange,
}: {
  params: AudioVolumeParams;
  onChange: (p: AudioVolumeParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<AudioVolumeParams>) => onChange({ ...params, ...patch });
  return (
    <div className="space-y-3">
      <Field label={t("opt.mode")}>
        <select
          className={sel}
          value={params.mode}
          onChange={(e) => set({ mode: e.target.value as AudioVolumeParams["mode"] })}
        >
          <option value="normalize">{t("opt.mode.normalize")}</option>
          <option value="gain">{t("opt.mode.gain")}</option>
        </select>
      </Field>
      {params.mode === "gain" && (
        <Field label={t("opt.gainDb")}>
          <NumInput
            value={params.gain}
            min={-20}
            max={20}
            step={1}
            onChange={(v) => set({ gain: v ?? 0 })}
          />
        </Field>
      )}
    </div>
  );
}
