import { useI18n } from "../../i18n";
import type { VideoSilenceParams } from "../../types";
import { Field, NumInput } from "./ui";

export default function VideoSilencePanel({
  params,
  onChange,
}: {
  params: VideoSilenceParams;
  onChange: (p: VideoSilenceParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<VideoSilenceParams>) => onChange({ ...params, ...patch });
  return (
    <div className="space-y-3">
      <Field label={t("opt.threshold")}>
        <NumInput
          value={params.threshold}
          min={-80}
          max={-5}
          step={1}
          onChange={(v) => set({ threshold: v ?? -35 })}
        />
      </Field>
      <Field label={t("opt.minLen")}>
        <NumInput
          value={params.minLen}
          min={0.1}
          max={30}
          step={0.1}
          onChange={(v) => set({ minLen: v ?? 2 })}
        />
      </Field>
    </div>
  );
}
