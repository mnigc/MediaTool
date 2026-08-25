import { useState } from "react";
import {
  addPreset,
  loadPresets,
  presetDisplayName,
  removePreset,
  type Preset,
} from "../lib/presets";
import { defaultParamsFor } from "../lib/defaults";
import { useI18n } from "../i18n";
import type { JobParams, ToolId } from "../types";

const DEFAULT_PRESET = "__default__";

/** Per-tool preset bar: builtin scenario presets are surfaced as quick chips,
 *  custom presets can be saved / deleted here. Presets apply on top of the
 *  current params so dynamic fields (e.g. watermark text/image) are preserved. */
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
  const [expanded, setExpanded] = useState(false);
  const [presets, setPresets] = useState<Preset[]>(() => loadPresets());
  const [selected, setSelected] = useState<string>(DEFAULT_PRESET);

  const myPresets = presets.filter((p) => p.toolId === toolId);
  const selectedPreset = myPresets.find((p) => p.name === selected);

  const apply = (name: string) => {
    if (name === DEFAULT_PRESET) {
      onChange(defaultParamsFor(toolId as ToolId));
      return;
    }
    const p = myPresets.find((x) => x.name === name);
    if (p) onChange({ ...params, ...p.params });
  };

  const save = () => {
    const name = window.prompt(
      t("pm.presetName"),
      `${t(`tool.${toolId}.name`)} ${t("pm.presetName")}`
    );
    if (!name) return;
    setPresets(addPreset({ name, toolId, params }));
    setSelected(name);
  };

  const del = (name: string) => {
    setPresets(removePreset(toolId, name));
    if (selected === name) setSelected("");
  };

  return (
    <div
      className="rounded-xl border border-neutral-200/70 bg-neutral-50/40 p-3 dark:border-neutral-700/70 dark:bg-neutral-800/40"
      data-od-id="presets-panel"
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
          {t("opt.presets")}
        </span>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-[10px] font-medium text-neutral-400 transition hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
        >
          <svg
            viewBox="0 0 16 16"
            className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
            fill="currentColor"
          >
            <path d="M4 6l4 4 4-4z" />
          </svg>
          {expanded ? t("opt.collapse") : t("opt.expand")}
        </button>
      </div>
      <div
        className={`overflow-hidden transition-all duration-200 ${
          expanded ? "max-h-[120px] opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <select
            value={selected === DEFAULT_PRESET ? "" : selected}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) {
                setSelected(DEFAULT_PRESET);
                apply(DEFAULT_PRESET);
              } else {
                setSelected(v);
                apply(v);
              }
            }}
            className="min-w-[110px] rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-700 transition focus:border-brand-400 focus:ring-1 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:focus:border-brand-500"
          >
            <option value="">{t("opt.selectPreset")}</option>
            {myPresets.map((p) => (
              <option key={p.name} value={p.name}>
                {presetDisplayName(p, t)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={save}
            className="rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-[10px] font-medium text-brand-700 transition hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
          >
            {t("opt.saveCurrent")}
          </button>
          {selected && selected !== DEFAULT_PRESET && (
            <button
              type="button"
              onClick={() => del(selected)}
              disabled={selectedPreset?.builtin}
              className="rounded-lg px-2 py-1.5 text-[10px] font-medium text-neutral-400 transition hover:text-error-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-neutral-400 dark:text-neutral-500 dark:hover:text-error-400"
            >
              {t("opt.delete")}
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            setSelected(DEFAULT_PRESET);
            apply(DEFAULT_PRESET);
          }}
          className={`rounded-lg px-2.5 py-1.5 text-[10px] font-medium transition ${
            selected === DEFAULT_PRESET
              ? "bg-brand-500 text-white dark:bg-brand-600"
              : "border border-neutral-200 bg-white text-neutral-600 hover:border-brand-200 hover:bg-brand-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:border-brand-800 dark:hover:bg-brand-950/40"
          }`}
        >
          {t("opt.defaultPreset")}
        </button>
        {myPresets.length > 0 &&
          myPresets.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => {
                setSelected(p.name);
                apply(p.name);
              }}
              className={`rounded-lg px-2.5 py-1.5 text-[10px] font-medium transition ${
                selected === p.name
                  ? "bg-brand-500 text-white dark:bg-brand-600"
                  : "border border-neutral-200 bg-white text-neutral-600 hover:border-brand-200 hover:bg-brand-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:border-brand-800 dark:hover:bg-brand-950/40"
              }`}
            >
              {presetDisplayName(p, t)}
            </button>
          ))}
        {myPresets.length > 0 && (
          <button
            type="button"
            onClick={save}
            className="rounded-lg border border-dashed border-neutral-300 px-2.5 py-1.5 text-[10px] font-medium text-neutral-500 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-600 dark:border-neutral-600 dark:text-neutral-400 dark:hover:border-brand-700 dark:hover:bg-brand-950/30 dark:hover:text-brand-300"
          >
            + {t("opt.savePlus")}
          </button>
        )}
      </div>
    </div>
  );
}
