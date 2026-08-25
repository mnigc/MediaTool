import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { loadPresets, presetDisplayName, removePreset, type Preset } from "../lib/presets";
import type { WorkbenchId } from "./registry";

interface Group {
  toolId: string;
  presets: Preset[];
}

// Tools that own presets, in display order.
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

  const del = (toolId: string, name: string) => {
    removePreset(toolId, name);
    setVersion((v) => v + 1);
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-neutral-800 dark:text-neutral-100">
          {t("module.presets.title")}
        </h2>
        <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
          {t("module.presets.desc")}
        </p>
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
                          ? "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                          : "bg-brand-50 text-brand-600 dark:bg-brand-950/40 dark:text-brand-400"
                      }`}
                    >
                      {p.builtin ? t("preset.builtin") : t("preset.custom")}
                    </span>
                    {onOpenTool && (
                      <button
                        type="button"
                        onClick={() => onOpenTool(g.toolId as WorkbenchId)}
                        className="rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 transition hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
                      >
                        {t("preset.use")}
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
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
