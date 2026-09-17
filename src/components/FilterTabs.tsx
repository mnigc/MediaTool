import type { Job } from "../types";
import { useI18n } from "../i18n";

export type FilterStatus = "all" | "queued" | "running" | "done" | "error" | "cancelled" | "skipped";

interface FilterTabsProps {
  jobs: Job[];
  active: FilterStatus;
  onChange: (filter: FilterStatus) => void;
}

const TABS: { value: FilterStatus; key: string }[] = [
  { value: "all", key: "app.filter.all" },
  { value: "queued", key: "app.filter.queued" },
  { value: "running", key: "app.filter.running" },
  { value: "done", key: "app.filter.done" },
  { value: "error", key: "app.filter.error" },
  { value: "cancelled", key: "app.filter.cancelled" },
  { value: "skipped", key: "app.filter.skipped" },
];

export default function FilterTabs({ jobs, active, onChange }: FilterTabsProps) {
  const { t } = useI18n();
  // Terminal-but-uninteresting phases only get a tab when they exist,
  // otherwise the bar overflows for the common all-queued/all-done cases.
  const tabs = TABS.filter(
    (tab) =>
      !["cancelled", "skipped"].includes(tab.value) ||
      jobs.some((j) => j.phase === tab.value)
  );
  return (
    <nav
      data-od-id="filter-tabs"
      className="flex items-center gap-1 rounded-xl bg-neutral-100 p-1 dark:bg-neutral-800"
      role="tablist"
      aria-label={t("app.filter.aria")}
    >
      {tabs.map((tab) => {
        const count =
          tab.value === "all"
            ? jobs.length
            : jobs.filter((j) => j.phase === tab.value).length;
        const isActive = active === tab.value;
        return (
          <button
            key={tab.value}
            role="tab"
            aria-selected={isActive}
            aria-controls="job-list"
            onClick={() => onChange(tab.value)}
            className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
              isActive
                ? "bg-white shadow-sm text-neutral-900 dark:bg-neutral-700 dark:text-white"
                : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
            }`}
          >
            <span>{t(tab.key)}</span>
            <span
              className={`min-w-[18px] rounded-full px-1 text-center text-xs ${
                isActive
                  ? "bg-neutral-100 text-neutral-600 dark:bg-neutral-600 dark:text-neutral-300"
                  : "bg-neutral-200/50 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400"
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
