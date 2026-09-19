import {
  addPreset,
  applyPresetParams,
  materializePresetParams,
  presetDisplayName,
  presetParamsEqual,
  presetSummary,
  removePreset,
  usePresets,
} from "../lib/presets";
import { useI18n } from "../i18n";
import { usePrompt } from "./PromptDialog";
import Select from "./Select";
import type { JobParams } from "../types";

const DEFAULT_PRESET = "__default__";
/** Chips shown inline (besides 默认); the rest collapse into a dropdown so the
 *  bar stays one row as custom presets pile up. */
const MAX_VISIBLE_CHIPS = 5;

/** Per-tool preset bar: builtin scenario presets are surfaced as quick chips,
 *  custom presets can be saved / deleted here. Applying a preset replaces the
 *  tool's whole encode state (identity fields like the watermark image are
 *  kept), so presets can never leave stale fields behind.
 *
 *  The active chip is derived from the params themselves, not stored per card:
 *  params synced onto other cards (同步参数) highlight the same preset there,
 *  and any manual edit away from the preset de-highlights it automatically. */
export default function PresetsBar({
  toolId,
  params,
  onChange,
}: {
  toolId: string;
  params: JobParams;
  onChange: (p: JobParams) => void;
}) {
  const { t } = useI18n();
  // Shared store: presets saved/deleted on any other card or page update here.
  const presets = usePresets();
  const { prompt, dialog } = usePrompt();

  const myPresets = presets.filter((p) => p.toolId === toolId);
  const visiblePresets = myPresets.slice(0, MAX_VISIBLE_CHIPS);
  const overflowPresets = myPresets.slice(MAX_VISIBLE_CHIPS);
  const overflowNames = new Set(overflowPresets.map((p) => p.name));

  const defaultsParams = materializePresetParams(toolId, {});
  const defaultActive = presetParamsEqual(toolId, params, defaultsParams);
  const matched = defaultActive
    ? undefined
    : myPresets.find((p) => presetParamsEqual(toolId, params, p.params));
  const matchedCustom = matched && !matched.builtin ? matched : undefined;

  const apply = (name: string) => {
    if (name === DEFAULT_PRESET) {
      onChange(applyPresetParams(toolId, params, {}));
      return;
    }
    const p = myPresets.find((x) => x.name === name);
    if (p) onChange(applyPresetParams(toolId, params, p.params));
  };

  const save = async () => {
    const name = await prompt({
      title: t("pm.presetName"),
      initialValue: `${t(`tool.${toolId}.name`)} ${t("pm.presetName")}`,
    });
    if (!name) return;
    addPreset({ name, toolId, params });
  };

  return (
    <div
      className="rounded-xl border border-neutral-200/70 bg-neutral-50/40 p-3 dark:border-neutral-700/70 dark:bg-neutral-800/40"
      data-od-id="presets-panel"
    >
      <p className="text-xs font-semibold text-neutral-600 dark:text-neutral-300">
        {t("opt.presets")}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => apply(DEFAULT_PRESET)}
          title={presetSummary({ name: "", toolId, params: defaultsParams, builtin: false }, t)}
          className={`rounded-lg px-2.5 py-1.5 text-[10px] font-medium transition ${
            defaultActive
              ? "bg-brand-500 text-white dark:bg-brand-600"
              : "border border-neutral-200 bg-white text-neutral-600 hover:border-brand-200 hover:bg-brand-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:border-brand-800 dark:hover:bg-brand-950/40"
          }`}
        >
          {t("opt.defaultPreset")}
        </button>
        {myPresets.length > 0 &&
          visiblePresets.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => apply(p.name)}
              title={presetSummary(p, t)}
              className={`rounded-lg px-2.5 py-1.5 text-[10px] font-medium transition ${
                matched?.name === p.name
                  ? "bg-brand-500 text-white dark:bg-brand-600"
                  : "border border-neutral-200 bg-white text-neutral-600 hover:border-brand-200 hover:bg-brand-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:border-brand-800 dark:hover:bg-brand-950/40"
              }`}
            >
              {presetDisplayName(p, t)}
            </button>
          ))}
        {overflowPresets.length > 0 && (
          <Select
            value={matched && overflowNames.has(matched.name) ? matched.name : ""}
            onChange={(v) => {
              if (!v) return;
              apply(v);
            }}
            className="max-w-44"
            triggerClassName="text-[10px] py-1.5"
          >
            <option value="">{t("opt.morePresets", { n: overflowPresets.length })}</option>
            {overflowPresets.map((p) => (
              <option key={p.name} value={p.name}>
                {presetDisplayName(p, t)}
              </option>
            ))}
          </Select>
        )}
        <button
          type="button"
          onClick={save}
          className="rounded-lg border border-dashed border-neutral-300 px-2.5 py-1.5 text-[10px] font-medium text-neutral-500 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-600 dark:border-neutral-600 dark:text-neutral-400 dark:hover:border-brand-700 dark:hover:bg-brand-950/30 dark:hover:text-brand-300"
        >
          + {t("opt.savePlus")}
        </button>
        {matchedCustom && (
          <button
            type="button"
            onClick={() => removePreset(toolId, matchedCustom.name)}
            className="rounded-lg px-2 py-1.5 text-[10px] font-medium text-neutral-400 transition hover:text-error-500 dark:text-neutral-500 dark:hover:text-error-400"
          >
            {t("opt.delete")}
          </button>
        )}
      </div>
      {dialog}
    </div>
  );
}
