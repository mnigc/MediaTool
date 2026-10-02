import { useState } from "react";
import type { JobParams } from "../types";
import {
  hasCustomPreset,
  presetDisplayName,
  saveBuiltinOverride,
  saveCustomPreset,
  type Preset,
} from "../lib/presets";
import { defaultParamsFor } from "../lib/defaults";
import PresetDiffEditor from "./PresetDiffEditor";
import { useConfirm } from "./ConfirmDialog";
import Select from "./Select";
import { XIcon } from "./icons";
import { useI18n } from "../i18n";
import { PRESET_TOOLS, type PresetToolId } from "../tools/kinds";

/* The preset edit dialog shared by the preset manager (toolbox modal) and the
 * presets page: name + tool picker + the diff editor, plus the save flow with
 * its rename-conflict confirmation. This used to be two ~100-line copies that
 * had already drifted (only one had the restore button). */

interface PresetEditProps {
  /** The preset being edited, or a blank one when creating. */
  preset: Preset;
  isNew: boolean;
  /** Called after the preset was written, so the parent can leave edit mode. */
  onSaved: () => void;
  onCancel: () => void;
  /** Shown for a modified builtin when provided (presets page): restore it to
   *  stock. The parent owns the restore + close. */
  onRestore?: (preset: Preset) => void;
}

/** The editor form proper. The preset manager embeds it inside its own modal;
 *  `PresetEditModal` (below) wraps it in the standalone dialog. */
export function PresetEditForm({ preset, isNew, onSaved, onCancel, onRestore }: PresetEditProps) {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<Preset>(preset);
  /** Name the edited preset was stored under — set when a rename should move
   *  (instead of collide with) the existing entry. */
  const [origName] = useState<string | null>(isNew ? null : preset.name);
  /** The preset's stored params when editing began — the diff editor's
   *  per-field 恢复 baseline. */
  const [origParams, setOrigParams] = useState<JobParams>(preset.params);

  const handleToolChange = (toolId: PresetToolId) => {
    const params = defaultParamsFor(toolId);
    setEditing({ ...editing, toolId, params });
    setOrigParams(params);
  };

  const handleParamsChange = (p: JobParams) => {
    setEditing({ ...editing, params: p });
  };

  const handleSave = async () => {
    const name = editing.name.trim();
    if (!name) return;
    if (editing.builtin) {
      saveBuiltinOverride(editing.toolId, name, editing.params);
    } else {
      if (hasCustomPreset(editing.toolId, name) && name !== origName) {
        const ok = await confirm({
          title: t("pm.conflictTitle"),
          message: t("pm.conflictMsg", { name }),
          confirmLabel: t("pm.save"),
          cancelLabel: t("confirm.cancel"),
          danger: true,
        });
        if (!ok) return;
      }
      saveCustomPreset(editing.toolId, origName ?? name, { name, params: editing.params });
    }
    onSaved();
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
            {t("pm.name")}
          </span>
          <input
            value={editing.builtin ? presetDisplayName(editing, t) : editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            placeholder={t("pm.presetName")}
            disabled={editing.builtin}
            className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700 shadow-sm focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-100 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
            {t("pm.toolType")}
          </span>
          <Select
            value={editing.toolId}
            onChange={(v) => handleToolChange(v as PresetToolId)}
            disabled={!isNew}
            className="w-full"
            triggerClassName="text-sm py-1.5"
          >
            {PRESET_TOOLS.map((toolId) => (
              <option key={toolId} value={toolId}>
                {t(`tool.${toolId}.name`)}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <div className="rounded-xl border border-neutral-100 bg-neutral-50/40 p-3 dark:border-neutral-700/60 dark:bg-neutral-800/30">
        <PresetDiffEditor
          toolId={editing.toolId}
          params={editing.params}
          original={origParams}
          onChange={handleParamsChange}
        />
      </div>

      {onRestore && editing.builtin && editing.modified && (
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => onRestore(editing)}
            className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-600 transition hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950/30 dark:text-brand-300 dark:hover:bg-brand-900/50"
          >
            {t("pm.restore")}
          </button>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
        >
          {t("pm.cancel")}
        </button>
        <button
          onClick={() => void handleSave()}
          className="rounded-lg bg-brand-500 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 dark:bg-brand-600 dark:hover:bg-brand-700"
        >
          {t("pm.save")}
        </button>
      </div>
      {dialog}
    </div>
  );
}

/** Standalone edit dialog (presets page): the form above in the shared modal
 *  chrome, headed 新建预设 / 编辑预设. */
export default function PresetEditModal(props: PresetEditProps) {
  const { t } = useI18n();
  const { isNew, onCancel } = props;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative z-10 flex max-h-[85vh] w-full min-w-0 max-w-lg flex-col rounded-2xl bg-white shadow-2xl ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-700 slide-up">
        <div className="flex items-center justify-between border-b border-neutral-100 px-5 py-4 dark:border-neutral-700/60">
          <h2 className="break-words text-base font-semibold text-neutral-800 dark:text-neutral-100">
            {isNew ? t("pm.new") : t("pm.edit")}
          </h2>
          <button
            onClick={onCancel}
            className="rounded-lg p-1.5 text-neutral-300 transition hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            aria-label={t("pm.close")}
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <PresetEditForm {...props} />
        </div>
      </div>
    </div>
  );
}
