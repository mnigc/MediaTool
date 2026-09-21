import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { useDownloads } from "../contexts/DownloadCenter";
import { cookiesList } from "../lib/engine";
import type { PlatformCookies } from "../types";
import {
  pipelineById,
  pipelineDisplayName,
  usePipelines,
} from "../workflow/pipelines";
import { Button } from "../components/ui";

/** Right-hand configuration rail shared by the download & record pages:
 *  one card, sections separated by dividers. Secondary sections collapse so
 *  the rail stays short and the link input keeps first-screen dominance. */
export function ConfigSidebar({ children }: { children: ReactNode }) {
  return (
    <aside className="w-full shrink-0 lg:sticky lg:top-5 lg:w-64">
      <div className="divide-y divide-neutral-100 rounded-2xl bg-white shadow-card ring-1 ring-neutral-200 dark:divide-neutral-800 dark:bg-neutral-900 dark:ring-neutral-800">
        {children}
      </div>
    </aside>
  );
}

export function SidebarSection({
  title,
  children,
  collapsible = false,
  defaultOpen = true,
  summary,
}: {
  title: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Short text shown next to a collapsed section's title. */
  summary?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const body = <div className="space-y-2.5">{children}</div>;

  if (!collapsible) {
    return (
      <div className="px-4 py-3.5">
        <p className="mb-2 text-xs font-semibold text-neutral-600 dark:text-neutral-300">
          {title}
        </p>
        {body}
      </div>
    );
  }

  return (
    <div className="px-4 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 py-1 text-left"
      >
        <span className="text-xs font-semibold text-neutral-600 dark:text-neutral-300">
          {title}
        </span>
        {!open && summary && (
          <span className="min-w-0 flex-1 truncate text-xs text-neutral-400 dark:text-neutral-500">
            {summary}
          </span>
        )}
        <svg
          viewBox="0 0 16 16"
          className={`ml-auto h-3 w-3 shrink-0 text-neutral-400 transition-transform ${
            open ? "rotate-180" : ""
          }`}
          fill="currentColor"
        >
          <path d="M4 6l4 4 4-4z" />
        </svg>
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="space-y-2.5 pt-1.5 pb-1">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** Label-left / control-right row sized for the narrow sidebar. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-neutral-600 dark:text-neutral-300">
      <span className="shrink-0">{label}</span>
      {children}
    </label>
  );
}

/** Read-only Cookies/proxy summary; editing lives in the global settings
 *  page since both downloads and recordings share these values. */
export function NetworkSection({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  const dl = useDownloads();
  const [platforms, setPlatforms] = useState<PlatformCookies[]>([]);
  useEffect(() => {
    let active = true;
    cookiesList()
      .then((list) => {
        if (active) setPlatforms(list);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const value = "min-w-0 truncate text-xs text-neutral-600 dark:text-neutral-300";
  const manualCookies = dl.settings.cookiesFile || dl.settings.cookiesText;
  const configured = manualCookies || dl.settings.proxy || platforms.length;
  const platformHosts = platforms.map((p) => p.host).join("、");
  return (
    <SidebarSection
      title={t("settings.network")}
      collapsible
      defaultOpen={false}
      summary={configured ? "·" : t("dl.notSet")}
    >
      <Field label={t("dl.cookies")}>
        <span className={value} title={dl.settings.cookiesFile || undefined}>
          {manualCookies ? t("dl.cookiesManual") : t("dl.notSet")}
        </span>
      </Field>
      {platforms.length > 0 && (
        <Field label={t("settings.platformCookies")}>
          <span className={value} title={platformHosts}>
            {platformHosts}
          </span>
        </Field>
      )}
      <Field label={t("dl.proxy")}>
        <span className={value} title={dl.settings.proxy || undefined}>
          {dl.settings.proxy || t("dl.notSet")}
        </span>
      </Field>
      <Button size="sm" className="w-full" onClick={onOpenSettings}>
        {t("settings.open")}
      </Button>
    </SidebarSection>
  );
}

export function PipelineChips({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  const pipelines = usePipelines();
  const nameOf = (id: string) => {
    const p = pipelineById(id);
    return p ? pipelineDisplayName(p, t) : id;
  };
  const detailOf = (id: string) => {
    const p = pipelineById(id);
    if (!p) return "";
    if (p.descKey) return t(p.descKey);
    return p.steps.map((s) => t(`tool.${s.toolId}.name`)).join(" → ");
  };
  // One flat list: builtin atoms and the user's workflow-builder pipelines
  // are the same kind of thing — a complete chain to run when finished.
  // Single-select; combos live on the workflow page as saved pipelines.
  const selectedSet = new Set(selected);

  const chip = (active: boolean, label: string, title: string, onClick: () => void) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
        active
          ? "bg-brand-500 text-white dark:bg-brand-600"
          : "border border-neutral-200 bg-white text-neutral-600 hover:border-brand-200 hover:text-brand-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:text-brand-400"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {chip(
          selected.length === 0,
          t("dl.pipeline.noTreatment"),
          t("dl.pipeline.noTreatment.desc"),
          () => onChange([])
        )}
        {pipelines.map((p) =>
          chip(
            selectedSet.has(p.id),
            pipelineDisplayName(p, t),
            detailOf(p.id),
            () => onChange(selectedSet.has(p.id) ? [] : [p.id])
          )
        )}
      </div>
      {selected.length > 0 && (
        <div className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          <div>{selected.map(nameOf).join(" → ")}</div>
          {selected.map((id) => {
            const d = detailOf(id);
            return d ? <div key={id}>{d}</div> : null;
          })}
        </div>
      )}
    </div>
  );
}
