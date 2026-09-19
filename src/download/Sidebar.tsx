import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { useDownloads } from "../contexts/DownloadCenter";
import { PIPELINE_PRESETS, presetById } from "./pipelines";

/** Right-hand configuration rail shared by the download & record pages:
 *  one card, sections separated by dividers. */
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
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="px-4 py-3.5">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {title}
      </p>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

/** Label-left / control-right row sized for the narrow sidebar. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
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
  const value = "min-w-0 truncate text-xs text-neutral-600 dark:text-neutral-300";
  return (
    <SidebarSection title={t("settings.network")}>
      <Field label={t("dl.cookies")}>
        <span className={value} title={dl.settings.cookiesBrowser || undefined}>
          {dl.settings.cookiesBrowser || t("dl.notSet")}
        </span>
      </Field>
      <Field label={t("dl.proxy")}>
        <span className={value} title={dl.settings.proxy || undefined}>
          {dl.settings.proxy || t("dl.notSet")}
        </span>
      </Field>
      <button
        onClick={onOpenSettings}
        className="w-full rounded-lg border border-neutral-200 px-2.5 py-1 text-[11px] font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {t("settings.open")}
      </button>
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
  const treatment = selected.find((id) => presetById(id)?.role === "treatment");
  const addon = selected.find((id) => presetById(id)?.role === "addon");
  // Steps chain each output into the next, so the order is fixed:
  // treatment first, add-on second. "None" simply drops the slot.
  const commit = (treatmentId: string | null, addonId: string | null) =>
    onChange([...(treatmentId ? [treatmentId] : []), ...(addonId ? [addonId] : [])]);

  const chip = (active: boolean, label: string, title: string, onClick: () => void) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
        active
          ? "bg-brand-500 text-white dark:bg-brand-600"
          : "border border-neutral-200 bg-white text-neutral-500 hover:border-brand-200 hover:text-brand-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:text-brand-400"
      }`}
    >
      {label}
    </button>
  );

  const treatments = PIPELINE_PRESETS.filter((p) => p.role === "treatment");
  const addons = PIPELINE_PRESETS.filter((p) => p.role === "addon");
  const names = selected
    .map((id) => (presetById(id) ? t(presetById(id)!.labelKey) : id))
    .join(" → ");

  return (
    <div className="space-y-2.5">
      <div>
        <p className="mb-1 text-[10px] text-neutral-400 dark:text-neutral-500">
          {t("dl.pipeline.treatment")}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {chip(
            !treatment,
            t("dl.pipeline.noTreatment"),
            t("dl.pipeline.noTreatment.desc"),
            () => commit(null, addon ?? null)
          )}
          {treatments.map((p) =>
            chip(
              treatment === p.id,
              t(p.labelKey),
              t(p.descKey),
              () => commit(treatment === p.id ? null : p.id, addon ?? null)
            )
          )}
        </div>
      </div>
      <div>
        <p className="mb-1 text-[10px] text-neutral-400 dark:text-neutral-500">
          {t("dl.pipeline.addon")}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {chip(!addon, t("dl.pipeline.noAddon"), t("dl.pipeline.noAddon.desc"), () =>
            commit(treatment ?? null, null)
          )}
          {addons.map((p) =>
            chip(
              addon === p.id,
              t(p.labelKey),
              t(p.descKey),
              () => commit(treatment ?? null, addon === p.id ? null : p.id)
            )
          )}
        </div>
      </div>
      {selected.length > 0 && (
        <div className="text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
          <div>{names}</div>
          {treatment && <div>{t(presetById(treatment)!.descKey)}</div>}
        </div>
      )}
    </div>
  );
}
