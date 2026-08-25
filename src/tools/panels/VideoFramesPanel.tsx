import { useI18n } from "../../i18n";
import type { FrameSampleParams } from "../../types";
import { Field, NumInput } from "./ui";

export default function VideoFramesPanel({
  params,
  onChange,
}: {
  params: FrameSampleParams;
  onChange: (p: FrameSampleParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<FrameSampleParams>) => onChange({ ...params, ...patch });
  return (
    <div className="space-y-3">
      <Field label={t("opt.frameInterval")}>
        <NumInput
          value={params.interval}
          min={0.1}
          max={60}
          step={0.5}
          onChange={(v) => set({ interval: v ?? 2 })}
        />
      </Field>
      <Field label={t("opt.frameFps")}>
        <NumInput
          value={params.fps}
          min={1}
          max={60}
          step={1}
          onChange={(v) => set({ fps: v ?? 12 })}
        />
      </Field>
      <Field label={t("opt.frameWidth")}>
        <NumInput
          value={params.width}
          min={64}
          max={3840}
          step={16}
          onChange={(v) => set({ width: v ?? 480 })}
        />
      </Field>
    </div>
  );
}
