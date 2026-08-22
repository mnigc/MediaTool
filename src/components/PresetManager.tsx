import { useState } from "react";
import type { AudioParams, ImageParams, JobParams, MediaType } from "../types";
import {
  addPreset,
  blankPreset,
  loadPresets,
  removePreset,
  type Preset,
} from "../lib/presets";
import {
  AudioOptionsCompact,
  ImageOptionsCompact,
  VideoOptionsCompact,
} from "./OptionsPanel";
import { XIcon } from "./icons";
import { useI18n } from "../i18n";

const MEDIA_TYPES: MediaType[] = ["video", "image", "audio"];
const MEDIA_LABEL: Record<MediaType, string> = {
  video: "video",
  image: "image",
  audio: "audio",
  unknown: "other",
};

interface PresetManagerProps {
  open: boolean;
  onClose: () => void;
}

export default function PresetManager({ open, onClose }: PresetManagerProps) {
  const [presets, setPresets] = useState<Preset[]>(() => loadPresets());
  const [editing, setEditing] = useState<Preset | null>(null);
  const [isNew, setIsNew] = useState(false);

  if (!open) return null;
  const { t } = useI18n();

  const startNew = () => {
    setEditing(blankPreset("video"));
    setIsNew(true);
  };

  const startEdit = (p: Preset) => {
    setEditing({ ...p });
    setIsNew(false);
  };

  const handleDelete = (p: Preset) => {
    setPresets(removePreset(p.mediaType, p.name));
  };

  const handleSave = () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) return;
    setPresets(addPreset({ ...editing, name, builtin: false }));
    setEditing(null);
  };

  const handleMediaTypeChange = (mt: MediaType) => {
    if (!editing) return;
    setEditing({ ...blankPreset(mt), name: editing.name });
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
              onMediaTypeChange={handleMediaTypeChange}
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

              {MEDIA_TYPES.map((mt) => {
                const list = presets.filter((p) => p.mediaType === mt);
                if (list.length === 0) return null;
                return (
                  <div key={mt}>
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                       {t("pm.media." + MEDIA_LABEL[mt])}
                     </div>
                    <div className="space-y-1.5">
                      {list.map((p) => (
                        <div
                          key={p.name}
                          className="flex items-center justify-between rounded-lg border border-neutral-200 bg-neutral-50/40 px-3 py-2 dark:border-neutral-700/60 dark:bg-neutral-800/40"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-neutral-700 dark:text-neutral-200">
                              {p.name}
                            </div>
                             <div className="text-[10px] text-neutral-400 dark:text-neutral-500">
                               {p.builtin ? t("pm.builtin") : t("pm.custom")}
                             </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              onClick={() => startEdit(p)}
                              className="rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                            >
                               {t("pm.edit")}
                             </button>
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
  onMediaTypeChange: (mt: MediaType) => void;
  onParamsChange: (p: JobParams) => void;
  onSave: () => void;
  onCancel: () => void;
}

function PresetEditor({
  preset,
  isNew,
  onNameChange,
  onMediaTypeChange,
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
            {t("pm.mediaType")}
          </span>
          <select
            value={preset.mediaType}
            onChange={(e) => onMediaTypeChange(e.target.value as MediaType)}
            disabled={!isNew}
            className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700 shadow-sm focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-100 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
          >
            {MEDIA_TYPES.map((mt) => (
              <option key={mt} value={mt}>
                {t("pm.media." + MEDIA_LABEL[mt])}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="rounded-xl border border-neutral-100 bg-neutral-50/40 p-3 dark:border-neutral-700/60 dark:bg-neutral-800/30">
        {preset.mediaType === "video" && (
          <VideoOptionsCompact params={preset.params} onChange={onParamsChange} />
        )}
        {preset.mediaType === "image" && (
          <ImageOptionsCompact
            params={preset.params as ImageParams}
            onChange={onParamsChange}
          />
        )}
        {preset.mediaType === "audio" && (
          <AudioOptionsCompact
            params={preset.params as AudioParams}
            onChange={onParamsChange}
          />
        )}
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
