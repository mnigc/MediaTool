import { useI18n } from "../../i18n";
import type { SpeedParams } from "../../types";
import { Checkbox, Field } from "./ui";

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export default function SpeedPanel({
  params,
  onChange,
}: {
  params: SpeedParams;
  onChange: (p: SpeedParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<SpeedParams>) => onChange({ ...params, ...patch });

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          {t("tool.speed.rate", { n: params.rate })}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {RATES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => set({ rate: r })}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                params.rate === r
                  ? "bg-brand-600 text-white dark:bg-brand-500"
                  : "border border-neutral-200 bg-white text-neutral-600 hover:border-brand-200 hover:bg-brand-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              {r}×
            </button>
          ))}
        </div>
      </div>
      <input
        type="range"
        min={0.25}
        max={4}
        step={0.05}
        value={params.rate}
        onChange={(e) => set({ rate: Number(e.target.value) })}
        className="mp-range w-full"
      />
      <Field label={t("tool.speed.mute")}>
        <Checkbox
          checked={params.muteAudio ?? false}
          onChange={(b) => set({ muteAudio: b })}
        />
      </Field>
    </div>
  );
}
