import { useI18n } from "../../i18n";
import type { ExtractAudioParams } from "../../types";
import { Field, FieldRow, NumInput, sel } from "./ui";

const FORMATS = [
  { value: "mp3", label: "MP3" },
  { value: "aac", label: "AAC" },
  { value: "m4a", label: "M4A" },
  { value: "opus", label: "Opus" },
  { value: "flac", label: "FLAC" },
];

export default function ExtractAudioPanel({
  params,
  onChange,
}: {
  params: ExtractAudioParams;
  onChange: (p: ExtractAudioParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<ExtractAudioParams>) => onChange({ ...params, ...patch });

  return (
    <div className="space-y-3">
      <FieldRow>
        <Field label={t("opt.format")}>
          <select
            className={sel}
            value={params.format}
            onChange={(e) => set({ format: e.target.value })}
          >
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("opt.bitrate")}>
          {params.format === "flac" ? (
            <input className={`${sel} opacity-50`} value="—" disabled />
          ) : (
            <NumInput
              value={params.bitrateKbps}
              min={32}
              step={32}
              onChange={(v) => set({ bitrateKbps: v ?? 128 })}
            />
          )}
        </Field>
      </FieldRow>
    </div>
  );
}
