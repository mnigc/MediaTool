import { open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../../i18n";
import type { AddAudioParams } from "../../types";
import { Field, NumInput, sel } from "./ui";

export default function VideoAddAudioPanel({
  params,
  onChange,
}: {
  params: AddAudioParams;
  onChange: (p: AddAudioParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<AddAudioParams>) => onChange({ ...params, ...patch });
  const pick = async () => {
    const s = await open({
      multiple: false,
      title: t("opt.audioPick"),
      filters: [{ name: "Audio", extensions: ["mp3", "aac", "m4a", "wav", "flac", "ogg", "opus"] }],
    });
    if (s && !Array.isArray(s)) set({ audioPath: s });
  };
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={pick}
        className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition hover:border-brand-200 hover:bg-brand-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
      >
        {params.audioPath ? t("opt.changeFile") : t("opt.audioPick")}
      </button>
      {params.audioPath && (
        <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400" title={params.audioPath}>
          {params.audioPath.replace(/\\/g, "/").split("/").pop()}
        </span>
      )}
      <Field label={t("opt.mixMode")}>
        <select
          className={sel}
          value={params.mode}
          onChange={(e) => set({ mode: e.target.value as AddAudioParams["mode"] })}
        >
          <option value="replace">{t("opt.mixMode.replace")}</option>
          <option value="mix">{t("opt.mixMode.mix")}</option>
        </select>
      </Field>
      {params.mode === "mix" && (
        <Field label={t("opt.mixVolume")}>
          <NumInput
            value={params.volume}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => set({ volume: v ?? 1 })}
          />
        </Field>
      )}
    </div>
  );
}
