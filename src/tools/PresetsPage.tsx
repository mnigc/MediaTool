import { useEffect, useMemo, useRef, useState } from "react";
import { tKey, useI18n } from "../i18n";
import {
  presetDisplayName,
  presetSummary,
  removePreset,
  restoreBuiltin,
  usePresets,
  type Preset,
} from "../lib/presets";
import { defaultParamsFor } from "../lib/defaults";
import { useConfirm } from "../components/ConfirmDialog";
import PresetEditModal from "../components/PresetEditModal";
import { isWorkbenchId, type WorkbenchId } from "./registry";
import type { PresetToolId } from "./kinds";

interface Group {
  toolId: string;
  presets: Preset[];
}

// Tools that own presets, in display order. All support the param editor.
const ORDER: PresetToolId[] = [
  "video-compress",
  "audio-compress",
  "watermark",
  "extract-audio",
  "video-contact",
];

const secId = (toolId: string) => `presets-sec-${toolId}`;

export default function PresetsPage({ onOpenTool }: { onOpenTool?: (tool: WorkbenchId) => void }) {
  const { t } = useI18n();
  const all = usePresets();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [editing, setEditing] = useState<Preset | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [activeSec, setActiveSec] = useState<string>("");
  // Set while a nav click scrolls to its section, so the observer doesn't
  // bounce the highlight back to the section still in view mid-scroll.
  const scrollIntent = useRef<string | null>(null);

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

  const navItems = useMemo(
    () =>
      groups.map((g) => ({
        id: secId(g.toolId),
        // Preset.toolId is persisted, so the group key is runtime data.
        label: t(tKey(`tool.${g.toolId}.name`)),
        count: g.presets.length,
      })),
    [groups, t]
  );

  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        if (scrollIntent.current) return;
        for (const e of entries)
          if (e.isIntersecting) setActiveSec(e.target.id);
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: 0 }
    );
    for (const item of navItems) {
      const el = document.getElementById(item.id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, [navItems]);

  const jumpTo = (id: string) => {
    setActiveSec(id);
    scrollIntent.current = id;
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => {
      scrollIntent.current = null;
    }, 600);
  };

  const del = async (toolId: string, name: string) => {
    const ok = await confirm({
      title: t("pm.deleteTitle"),
      message: t("pm.deleteMsg", { name }),
      confirmLabel: t("pm.delete"),
      cancelLabel: t("confirm.cancel"),
      danger: true,
    });
    if (ok) removePreset(toolId, name);
  };

  const restore = (toolId: string, name: string) => {
    restoreBuiltin(toolId, name);
  };

  const startNew = () => {
    const toolId = ORDER[0];
    setEditing({ name: "", toolId, params: defaultParamsFor(toolId), builtin: false });
    setIsNew(true);
  };

  const startEdit = (p: Preset) => {
    setEditing({ ...p });
    setIsNew(false);
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">
            {t("module.presets.title")}
          </h2>
        </div>
        <button
          type="button"
          onClick={startNew}
          className="shrink-0 rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700 transition hover:border-brand-300 hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900/50"
        >
          {t("pm.new")}
        </button>
      </div>

      <div className="flex items-start gap-5">
        <nav className="sticky top-0 flex w-36 shrink-0 flex-col gap-0.5 self-start pt-1">
          {navItems.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => jumpTo(n.id)}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                activeSec === n.id
                  ? "bg-brand-50 text-brand-600 dark:bg-brand-950/40 dark:text-brand-400"
                  : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-200"
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-left">{n.label}</span>
              <span className="shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500">
                {n.count}
              </span>
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1 space-y-5">
          {groups.map((g) => (
            <div key={g.toolId} id={secId(g.toolId)} className="scroll-mt-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                  {t(tKey(`tool.${g.toolId}.name`))}
                </span>
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  {g.presets.length}
                </span>
              </div>
              <div className="divide-y divide-neutral-100 overflow-hidden rounded-xl bg-white ring-1 ring-neutral-200 dark:divide-neutral-800/70 dark:bg-neutral-900 dark:ring-neutral-800">
                {g.presets.map((p) => (
                  <div
                    key={`${g.toolId}::${p.name}`}
                    role={onOpenTool ? "button" : undefined}
                    tabIndex={onOpenTool ? 0 : undefined}
                    onClick={() => {
                      // Runtime guard instead of a cast: stored tool ids are
                      // plain strings and must not reach the router unchecked.
                      if (isWorkbenchId(g.toolId)) onOpenTool?.(g.toolId);
                    }}
                    onKeyDown={(e) => {
                      if (onOpenTool && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        if (isWorkbenchId(g.toolId)) onOpenTool(g.toolId);
                      }
                    }}
                    className="group flex items-center gap-2 px-3 py-2.5 transition hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-neutral-800 dark:text-neutral-100">
                        {presetDisplayName(p, t)}
                      </div>
                      {presetSummary(p, t) && (
                        <div className="truncate text-[11px] text-neutral-400 dark:text-neutral-500">
                          {presetSummary(p, t)}
                        </div>
                      )}
                    </div>
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
                    {!p.locked && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEdit(p);
                        }}
                        className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                      >
                        {t("pm.edit")}
                      </button>
                    )}
                    {p.builtin && p.modified && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          restore(g.toolId, p.name);
                        }}
                        className="rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 transition hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
                        title={t("pm.restore")}
                      >
                        {t("pm.restore")}
                      </button>
                    )}
                    {!p.builtin && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void del(g.toolId, p.name);
                        }}
                        className="rounded-lg px-2.5 py-1 text-xs font-medium text-neutral-400 transition hover:bg-error-50 hover:text-error-500 dark:text-neutral-500 dark:hover:bg-error-950/30 dark:hover:text-error-400"
                        title={t("pm.delete")}
                      >
                        {t("pm.delete")}
                      </button>
                    )}
                    {onOpenTool && (
                      <span className="shrink-0 text-neutral-300 opacity-0 transition group-hover:opacity-100 dark:text-neutral-600" aria-hidden>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                          <path d="m9 18 6-6-6-6" />
                        </svg>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {editing && (
        <PresetEditModal
          key={isNew ? "new" : `${editing.toolId}::${editing.name}`}
          preset={editing}
          isNew={isNew}
          onSaved={() => setEditing(null)}
          onCancel={() => setEditing(null)}
          onRestore={(p) => {
            restore(p.toolId, p.name);
            setEditing(null);
          }}
        />
      )}
      {confirmDialog}
    </div>
  );
}
