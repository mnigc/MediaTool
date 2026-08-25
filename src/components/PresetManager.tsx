import { useState } from "react";
import type { JobParams, ToolId } from "../types";
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
import PresetParamsEditor from "./PresetParamsEditor";
import { XIcon } from "./icons";
import { useI18n } from "../i18n";

const PRESET_TOOLS: ToolId[] = [
  "video-compress",
  "audio-compress",
  "image-compress",
  "extract-audio",
];

interface PresetManagerProps {
  open: boolean;
  onClose: () => void;
}

export default function PresetManager({ open, onClose }: PresetManagerProps) {
  const { t } = useI18n();
  const [presets, setPresets] = useState<Preset[]>(() => loadPresets());
  const [editing, setEditing] = useState<Preset | null>(null);
  const [isNew, setIsNew] = useState(false);

  if (!open) return null;

  const startNew = () => {
    const toolId = PRESET_TOOLS[0];
    setEditing({
      name: "",
      toolId,
      params: defaultParamsFor(toolId),
      builtin: false,
    });
    setIsNew(true);
  };

  const startEdit = (p: Preset) => {
    setEditing({ ...p });
    setIsNew(false);
  };

  const handleDelete = (p: Preset) => {
    setPresets(removePreset(p.toolId, p.name));
  };

  const handleSave = () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) return;
    setPresets(
      editing.builtin
        ? saveBuiltinOverride(editing.toolId, name, editing.params)
        : addPreset({ ...editing, name, builtin: false })
    );
    setEditing(null);
  };

  const handleRestore = (p: Preset) => {
    setPresets(restoreBuiltin(p.toolId, p.name));
  };

  const handleToolChange = (toolId: ToolId) => {
    if (!editing) return;
    setEditing({ ...editing, toolId, params: defaultParamsFor(toolId) });
  };

  const handleParamsChange = (p: JobParams) => {
    if (editing) setEditing({ ...editing, params: p });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-700 slide-up">
        <div className="flex items-center justify-between border-b border-neutral-100 px-5 py-4 dark:border-neutral-700/60">
          <h2 className="text-base font-semibold text-neutral-800 dark:text-neutral-100">
             {t("pm.title")}
           </h2>
          <button
             onClick={onClose}
             className="rounded-lg p-1.5 text-neutral-300 transition hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
             aria-label={t("pm.close")}
           >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {editing ? (
            <PresetEditor
              preset={editing}
              isNew={isNew}
              onNameChange={(name) => setEditing({ ...editing, name })}
              onToolChange={handleToolChange}
              onParamsChange={handleParamsChange}
              onSave={handleSave}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <div className="space-y-4">
              <button
                onClick={startNew}
                className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand-300 bg-brand-50/50 px-3 py-2.5 text-sm font-medium text-brand-700 transition hover:border-brand-400 hover:bg-brand-100 dark:border-brand-700 dark:bg-brand-950/30 dark:text-brand-300 dark:hover:border-brand-500 dark:hover:bg-brand-900/50"
              >
                {t("pm.new")}
              </button>

              {PRESET_TOOLS.map((toolId) => {
                const list = presets.filter((p) => p.toolId === toolId);
                if (list.length === 0) return null;
                return (
                  <div key={toolId}>
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                       {t(`tool.${toolId}.name`)}
                     </div>
                    <div className="space-y-1.5">
                      {list.map((p) => (
                        <div
                          key={`${p.toolId}::${p.name}`}
                          className="flex items-center justify-between rounded-lg border border-neutral-200 bg-neutral-50/40 px-3 py-2 dark:border-neutral-700/60 dark:bg-neutral-800/40"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-neutral-700 dark:text-neutral-200">
                              {presetDisplayName(p, t)}
                            </div>
                             <div
                               className={
                                 p.builtin && p.modified
                                   ? "text-[10px] font-medium text-brand-600 dark:text-brand-400"
                                   : "text-[10px] text-neutral-400 dark:text-neutral-500"
                               }
                             >
                               {p.builtin
                                 ? p.modified
                                   ? t("pm.modified")
                                   : t("pm.builtin")
                                 : t("pm.custom")}
                             </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              onClick={() => startEdit(p)}
                              className="rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                            >
                               {t("pm.edit")}
                             </button>
                             {p.builtin && p.modified && (
                               <button
                                 onClick={() => handleRestore(p)}
                                 className="rounded-md border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-600 transition hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950/30 dark:text-brand-300 dark:hover:bg-brand-900/50"
                               >
                                 {t("pm.restore")}
                               </button>
                             )}
                             {!p.builtin && (
                               <button
                                 onClick={() => handleDelete(p)}
                                 className="rounded-md border border-error-200 bg-error-50 px-2.5 py-1 text-xs font-medium text-error-600 transition hover:bg-error-100 dark:border-error-800 dark:bg-error-950/30 dark:text-error-400 dark:hover:bg-error-900/50"
                               >
                                 {t("pm.delete")}
                               </button>
                             )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface PresetEditorProps {
  preset: Preset;
  isNew: boolean;
  onNameChange: (name: string) => void;
  onToolChange: (toolId: ToolId) => void;
  onParamsChange: (p: JobParams) => void;
  onSave: () => void;
  onCancel: () => void;
}

function PresetEditor({
  preset,
  isNew,
  onNameChange,
  onToolChange,
  onParamsChange,
  onSave,
  onCancel,
}: PresetEditorProps) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
            {t("pm.name")}
          </span>
          <input
            value={preset.name}
            onChange={(e) => onNameChange(e.target.value)}
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
            value={preset.toolId}
            onChange={(e) => onToolChange(e.target.value as ToolId)}
            disabled={!isNew}
            className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700 shadow-sm focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-100 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
          >
            {PRESET_TOOLS.map((toolId) => (
              <option key={toolId} value={toolId}>
                {t(`tool.${toolId}.name`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="rounded-xl border border-neutral-100 bg-neutral-50/40 p-3 dark:border-neutral-700/60 dark:bg-neutral-800/30">
        <PresetParamsEditor
          toolId={preset.toolId}
          params={preset.params}
          onChange={onParamsChange}
        />
      </div>

      <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            {t("pm.cancel")}
          </button>
          <button
            onClick={onSave}
            className="rounded-lg bg-brand-500 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 dark:bg-brand-600 dark:hover:bg-brand-700"
          >
            {t("pm.save")}
          </button>
      </div>
    </div>
  );
}
