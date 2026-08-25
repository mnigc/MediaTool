import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import {
  addPreset,
  loadPresets,
  presetDisplayName,
  removePreset,
  restoreBuiltin,
  saveBuiltinOverride,
  type Preset,
} from "../lib/presets";
import { defaultParamsFor } from "../lib/defaults";
import PresetParamsEditor from "../components/PresetParamsEditor";
import { XIcon } from "../components/icons";
import type { JobParams, ToolId } from "../types";
import type { WorkbenchId } from "./registry";

interface Group {
  toolId: string;
  presets: Preset[];
}

// Tools that own presets, in display order. All support the param editor.
const ORDER: string[] = [
  "video-compress",
  "audio-compress",
  "image-compress",
  "image-crop",
  "image-resize",
  "video-crop",
  "gif",
  "image-adjust",
  "image-watermark",
  "watermark",
  "extract-audio",
];

export default function PresetsPage({ onOpenTool }: { onOpenTool?: (tool: WorkbenchId) => void }) {
  const { t } = useI18n();
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<Preset | null>(null);
  const [isNew, setIsNew] = useState(false);
  const all = useMemo(() => loadPresets(), [version]);

  const groups: Group[] = useMemo(() => {
    const byTool = new Map<string, Preset[]>();
    for (const p of all) {
      const list = byTool.get(p.toolId) ?? [];
      list.push(p);
      byTool.set(p.toolId, list);
    }
    const ordered: Group[] = [];
    const seen = new Set<string>();
    for (const toolId of ORDER) {
      if (byTool.has(toolId)) {
        ordered.push({ toolId, presets: byTool.get(toolId)! });
        seen.add(toolId);
      }
    }
    for (const [toolId, presets] of byTool) {
      if (!seen.has(toolId)) ordered.push({ toolId, presets });
    }
    return ordered;
  }, [all]);

  const reload = () => setVersion((v) => v + 1);

  const del = (toolId: string, name: string) => {
    removePreset(toolId, name);
    reload();
  };

  const restore = (toolId: string, name: string) => {
    restoreBuiltin(toolId, name);
    reload();
  };

  const startNew = () => {
    const toolId = ORDER[0];
    setEditing({ name: "", toolId, params: defaultParamsFor(toolId as ToolId), builtin: false });
    setIsNew(true);
  };

  const startEdit = (p: Preset) => {
    setEditing({ ...p });
    setIsNew(false);
  };

  const handleToolChange = (toolId: string) => {
    if (!editing) return;
    setEditing({ ...editing, toolId, params: defaultParamsFor(toolId as ToolId) });
  };

  const handleParamsChange = (p: JobParams) => {
    if (editing) setEditing({ ...editing, params: p });
  };

  const handleSave = () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) return;
    if (editing.builtin) {
      saveBuiltinOverride(editing.toolId, name, editing.params);
    } else {
      addPreset({ ...editing, name, builtin: false });
    }
    setEditing(null);
    reload();
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-neutral-800 dark:text-neutral-100">
            {t("module.presets.title")}
          </h2>
          <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
            {t("module.presets.desc")}
          </p>
        </div>
        <button
          type="button"
          onClick={startNew}
          className="shrink-0 rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700 transition hover:border-brand-300 hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900/50"
        >
          {t("pm.new")}
        </button>
      </div>

      {groups.length === 0 ? (
        <p className="text-sm text-neutral-400 dark:text-neutral-500">{t("preset.empty")}</p>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.toolId}>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                  {t(`tool.${g.toolId}.name`)}
                </span>
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  {g.presets.length}
                </span>
              </div>
              <div className="space-y-1.5">
                {g.presets.map((p) => (
                  <div
                    key={`${g.toolId}::${p.name}`}
                    className="flex items-center gap-2 rounded-xl bg-white p-3 ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-neutral-800 dark:text-neutral-100">
                      {presetDisplayName(p, t)}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        p.builtin
                          ? p.modified
                            ? "bg-brand-50 text-brand-600 dark:bg-brand-950/40 dark:text-brand-400"
                            : "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                          : "bg-brand-50 text-brand-600 dark:bg-brand-950/40 dark:text-brand-400"
                      }`}
                    >
                      {p.builtin
                        ? p.modified
                          ? t("preset.modified")
                          : t("preset.builtin")
                        : t("preset.custom")}
                    </span>
                    <button
                      type="button"
                      onClick={() => startEdit(p)}
                      className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                    >
                      {t("pm.edit")}
                    </button>
                    {p.builtin && p.modified && (
                      <button
                        type="button"
                        onClick={() => restore(g.toolId, p.name)}
                        className="rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 transition hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
                        title={t("pm.restore")}
                      >
                        {t("pm.restore")}
                      </button>
                    )}
                    {!p.builtin && (
                      <button
                        type="button"
                        onClick={() => del(g.toolId, p.name)}
                        className="rounded-lg px-2.5 py-1 text-xs font-medium text-neutral-400 transition hover:bg-error-50 hover:text-error-500 dark:text-neutral-500 dark:hover:bg-error-950/30 dark:hover:text-error-400"
                        title={t("pm.delete")}
                      >
                        {t("pm.delete")}
                      </button>
                    )}
                    {onOpenTool && (
                      <button
                        type="button"
                        onClick={() => onOpenTool(g.toolId as WorkbenchId)}
                        className="rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 transition hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
                      >
                        {t("preset.use")}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setEditing(null)} />
          <div className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-700 slide-up">
            <div className="flex items-center justify-between border-b border-neutral-100 px-5 py-4 dark:border-neutral-700/60">
              <h2 className="text-base font-semibold text-neutral-800 dark:text-neutral-100">
                {isNew ? t("pm.new") : t("pm.edit")}
              </h2>
              <button
                onClick={() => setEditing(null)}
                className="rounded-lg p-1.5 text-neutral-300 transition hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
                aria-label={t("pm.close")}
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                      {t("pm.name")}
                    </span>
                    <input
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      placeholder={t("pm.presetName")}
                      disabled={!isNew}
                      className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700 shadow-sm focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-100 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                      {t("pm.toolType")}
                    </span>
                    <select
                      value={editing.toolId}
                      onChange={(e) => handleToolChange(e.target.value)}
                      disabled={!isNew}
                      className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700 shadow-sm focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-100 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
                    >
                      {ORDER.map((toolId) => (
                        <option key={toolId} value={toolId}>
                          {t(`tool.${toolId}.name`)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="rounded-xl border border-neutral-100 bg-neutral-50/40 p-3 dark:border-neutral-700/60 dark:bg-neutral-800/30">
                  <PresetParamsEditor
                    toolId={editing.toolId}
                    params={editing.params}
                    onChange={handleParamsChange}
                  />
                </div>

                {editing.builtin && editing.modified && (
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        restore(editing.toolId, editing.name);
                        setEditing(null);
                      }}
                      className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-600 transition hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950/30 dark:text-brand-300 dark:hover:bg-brand-900/50"
                    >
                      {t("pm.restore")}
                    </button>
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setEditing(null)}
                    className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                  >
                    {t("pm.cancel")}
                  </button>
                  <button
                    onClick={handleSave}
                    className="rounded-lg bg-brand-500 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 dark:bg-brand-600 dark:hover:bg-brand-700"
                  >
                    {t("pm.save")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
