import { useCallback, useEffect, useState, type ComponentType } from "react";
import { useI18n } from "../i18n";
import { LOCALES, LOCALE_NAMES } from "../i18n/translations";
import { useConfirm } from "../components/ConfirmDialog";
import { cacheClean, cacheReport, formatBytes } from "../lib/tauri";
import { useDownloads } from "../contexts/DownloadCenter";
import { AutoIcon, MoonIcon, SearchIcon, SpinnerIcon, SunIcon, TrashIcon } from "../components/icons";
import Select from "../components/Select";
import type { ThemeMode } from "../hooks/useTheme";
import type { CacheCleanResult, CacheReport } from "../types";

const THEME_ICONS: Record<ThemeMode, ComponentType<{ className?: string }>> = {
  light: SunIcon,
  auto: AutoIcon,
  dark: MoonIcon,
};

interface SettingsPageProps {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
}

/** Global settings shared by the download & record pages. */
export default function SettingsPage({ themeMode, onThemeChange }: SettingsPageProps) {
  const { t, locale, setLocale } = useI18n();
  const dl = useDownloads();

  const row =
    "flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3";
  const labelCls = "shrink-0 text-xs font-medium text-neutral-600 dark:text-neutral-300 sm:w-24";

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-5">
        <h2 className="text-xl font-semibold text-neutral-800 dark:text-neutral-100">
          {t("settings.title")}
        </h2>
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-card ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
        <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
          {t("settings.appearance")}
        </p>
        <div className="mt-4 space-y-4">
          <div className={row}>
            <span className={labelCls}>{t("settings.language")}</span>
            <Select
              value={locale}
              onChange={(v) => setLocale(v as typeof locale)}
              className="w-full sm:w-44"
            >
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {LOCALE_NAMES[l]}
                </option>
              ))}
            </Select>
          </div>
          <div className={row}>
            <span className={labelCls}>{t("settings.theme")}</span>
            <div className="flex items-center rounded-xl border border-neutral-200 bg-neutral-50/50 p-1 dark:border-neutral-700 dark:bg-neutral-800/50">
              {(["light", "auto", "dark"] as const).map((opt) => {
                const Icon = THEME_ICONS[opt];
                const label =
                  opt === "light"
                    ? t("header.theme.light")
                    : opt === "auto"
                    ? t("header.theme.auto")
                    : t("header.theme.dark");
                return (
                  <button
                    key={opt}
                    onClick={() => onThemeChange(opt)}
                    title={label}
                    aria-label={label}
                    className={`flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-200 ${
                      themeMode === opt
                        ? "bg-brand-100/70 text-brand-700 dark:bg-brand-900/70 dark:text-brand-200"
                        : "text-neutral-500 hover:bg-neutral-200/50 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-700/50 dark:hover:text-neutral-200"
                    }`}
                  >
                    <Icon className="h-4.5 w-4.5" />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-5 rounded-2xl bg-white p-4 shadow-card ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
        <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
          {t("settings.network")}
        </p>
        <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
          {t("settings.networkHint")}
        </p>

        <div className="mt-4 space-y-4">
          <div className={row}>
            <span className={labelCls}>{t("dl.cookies")}</span>
            <Select
              value={dl.settings.cookiesBrowser}
              onChange={(v) => dl.updateSettings({ cookiesBrowser: v })}
              className="w-full sm:w-44"
            >
              <option value="">{t("dl.cookiesNone")}</option>
              {["chrome", "edge", "firefox", "safari", "brave", "opera"].map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          </div>
          <div className={row}>
            <span className={labelCls}>{t("dl.proxy")}</span>
            <input
              value={dl.settings.proxy}
              onChange={(e) => dl.updateSettings({ proxy: e.target.value })}
              placeholder="http://127.0.0.1:7890"
              className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
            />
          </div>
        </div>
      </div>

      <CacheSection />
    </div>
  );
}

/** Cache maintenance: show how much space the app's own scratch data uses and
 *  clear what is safe to drop. User files and downloads are never reported or
 *  removed; the installed engine binary is measured but kept. */
function CacheSection() {
  const { t } = useI18n();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [report, setReport] = useState<CacheReport | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [result, setResult] = useState<CacheCleanResult | null>(null);

  const refresh = useCallback(() => {
    cacheReport().then(setReport).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleClean = useCallback(async () => {
    const removable = report?.removableBytes ?? 0;
    if (!removable || cleaning) return;
    const ok = await confirm({
      title: t("about.cache.cleanTitle"),
      message: t("about.cache.cleanMsg", { size: formatBytes(removable) }),
      confirmLabel: t("about.cache.clean"),
      cancelLabel: t("confirm.cancel"),
      danger: true,
    });
    if (!ok) return;
    setCleaning(true);
    setResult(null);
    try {
      setResult(await cacheClean());
    } catch {
      // Nothing cleared; the report below is rescaned either way.
    } finally {
      setCleaning(false);
      refresh();
    }
  }, [report, cleaning, confirm, t, refresh]);

  return (
    <section className="mt-5 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
          {t("about.cache.title")}
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          {report && (
            <span className="rounded-lg bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
              {t("about.cache.total", { size: formatBytes(report.totalBytes) })}
            </span>
          )}
          <button
            onClick={refresh}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-neutral-200 text-neutral-500 transition hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
            title={t("about.cache.refresh")}
            aria-label={t("about.cache.refresh")}
          >
            <SearchIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {report && (
        <ul className="mt-4 space-y-3">
          {report.buckets.map((b) => (
            <li key={b.key} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                  <span>{t(b.labelKey)}</span>
                  <span
                    className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
                      b.removable
                        ? "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                        : "bg-neutral-50 text-neutral-400 ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800"
                    }`}
                  >
                    {b.removable ? t("about.cache.removable") : t("about.cache.keep")}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-xs text-neutral-400 dark:text-neutral-500">
                  {b.path}
                </div>
              </div>
              <div className="shrink-0 text-right text-sm">
                <div className="font-medium text-neutral-800 dark:text-neutral-200">
                  {formatBytes(b.sizeBytes)}
                </div>
                <div className="text-xs text-neutral-400">
                  {t("about.cache.files", { n: b.fileCount })}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {result && (
        <p className="mt-3 text-xs text-success-600 dark:text-success-400">
          {t("about.cache.freed", {
            size: formatBytes(result.freedBytes),
            n: result.removed,
          })}
          {result.failed > 0 && (
            <span className="text-neutral-400 dark:text-neutral-500">
              {" "}
              {t("about.cache.skipped", { n: result.failed })}
            </span>
          )}
        </p>
      )}

      {report && report.removableBytes > 0 && (
        <div className="mt-4 flex justify-end">
          <button
            onClick={() => void handleClean()}
            disabled={cleaning}
            className="inline-flex items-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700 disabled:opacity-50"
          >
            {cleaning ? (
              <SpinnerIcon className="h-4 w-4 animate-spin" />
            ) : (
              <TrashIcon className="h-4 w-4" />
            )}
            {t("about.cache.clean")}
          </button>
        </div>
      )}

      {confirmDialog}
    </section>
  );
}
