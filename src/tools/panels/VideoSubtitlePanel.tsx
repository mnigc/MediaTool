import { open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../../i18n";
import type { SubtitleParams } from "../../types";
import { Field, Checkbox } from "./ui";

export default function VideoSubtitlePanel({
  params,
  onChange,
}: {
  params: SubtitleParams;
  onChange: (p: SubtitleParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<SubtitleParams>) => onChange({ ...params, ...patch });
  const pick = async () => {
    const s = await open({
      multiple: false,
      title: t("opt.subtitlePick"),
      filters: [{ name: "Subtitle", extensions: ["srt", "ass", "vtt", "sub"] }],
    });
    if (s && !Array.isArray(s)) set({ path: s });
  };
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={pick}
        className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition hover:border-brand-200 hover:bg-brand-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
      >
        {params.path ? t("opt.changeFile") : t("opt.subtitlePick")}
      </button>
      {params.path && (
        <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400" title={params.path}>
          {params.path.replace(/\\/g, "/").split("/").pop()}
        </span>
      )}
      <Field label={t("opt.burnIn")}>
        <Checkbox checked={params.burn ?? true} onChange={(v) => set({ burn: v })} />
      </Field>
    </div>
  );
}
