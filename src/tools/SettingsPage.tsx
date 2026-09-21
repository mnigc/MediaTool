import { useCallback, useEffect, useState, type ComponentType } from "react";
import { pickPaths } from "../lib/shell";
import { useI18n } from "../i18n";
import { LOCALES, LOCALE_NAMES } from "../i18n/translations";
import { useConfirm } from "../components/ConfirmDialog";
import { cacheClean, cacheReport, cookiesList, cookiesRemove, cookiesSet, formatBytes } from "../lib/engine";
import { Button } from "../components/ui";
import { useDownloads } from "../contexts/DownloadCenter";
import { AutoIcon, MoonIcon, RefreshIcon, SpinnerIcon, SunIcon, TrashIcon } from "../components/icons";
import Select from "../components/Select";
import UploadSection from "./UploadSettings";
import type { ThemeMode } from "../hooks/useTheme";
import type { CacheCleanResult, CacheReport, PlatformCookies } from "../types";

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

  // Effective cookie source mirrors the backend priority: file > pasted text.
  // Dimmed inputs are being overridden (still editable).
  const fileSet = dl.settings.cookiesFile.trim() !== "";
  const textSet = dl.settings.cookiesText.trim() !== "";
  const hasCookies = fileSet || textSet;

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
            <span className={labelCls}>{t("settings.cookiesFile")}</span>
            <div className="flex min-w-0 flex-1 gap-2">
              <input
                value={dl.settings.cookiesFile}
                onChange={(e) => dl.updateSettings({ cookiesFile: e.target.value })}
                placeholder="cookies.txt"
                className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
              />
              <button
                onClick={async () => {
                  const [sel] = await pickPaths({});
                  if (sel) dl.updateSettings({ cookiesFile: sel });
                }}
                className="shrink-0 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
              >
                {t("settings.cookiesBrowse")}
              </button>
            </div>
          </div>
          <div className={row}>
            <span className={labelCls}>{t("settings.cookiesText")}</span>
            <textarea
              value={dl.settings.cookiesText}
              onChange={(e) => dl.updateSettings({ cookiesText: e.target.value })}
              rows={3}
              spellCheck={false}
              placeholder="# Netscape HTTP Cookie File"
              className={`min-w-0 flex-1 resize-y rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 font-mono text-[11px] leading-relaxed transition-opacity dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 ${fileSet ? "opacity-50" : ""}`}
            />
          </div>
          <div className="space-y-1 pl-0 sm:pl-27">
            <p className="flex items-center gap-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300">
              <span
                className={`inline-block size-1.5 rounded-full ${hasCookies ? "bg-emerald-500" : "bg-neutral-300 dark:bg-neutral-600"}`}
              />
              {fileSet
                ? t("settings.cookiesEffectiveFile")
                : textSet
                  ? t("settings.cookiesEffectiveText")
                  : t("settings.cookiesEffectiveNone")}
            </p>
            <p className="text-xs text-neutral-400 dark:text-neutral-500">
              {t("settings.cookiesHint")}
            </p>
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

      <PlatformCookiesSection />

      <UploadSection />

      <CacheSection />
    </div>
  );
}

/** Cookies per live platform, keyed by the room URL's host. Recording probes
 *  with these before the global cookies above, since one global file cannot
 *  sign in to several sites at once. */
function PlatformCookiesSection() {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirm();
  const [entries, setEntries] = useState<PlatformCookies[]>([]);
  const [draft, setDraft] = useState<PlatformCookies | null>(null);
  /** Host of the entry being edited; a new entry may name any host. */
  const [editingOf, setEditingOf] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    cookiesList()
      .then(setEntries)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await cookiesSet(draft);
      setDraft(null);
      setEditingOf(null);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (host: string) => {
    const ok = await confirm({
      title: t("settings.platformCookies.removeTitle"),
      message: t("settings.platformCookies.removeMsg", { host }),
      confirmLabel: t("dl.monitor.delete"),
      cancelLabel: t("confirm.cancel"),
      danger: true,
    });
    if (!ok) return;
    await cookiesRemove(host).catch(() => {});
    refresh();
  };

  const draftFileSet = !!draft?.cookiesFile?.trim();

  return (
    <section className="mt-5 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
            {t("settings.platformCookies")}
          </h2>
          <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
            {t("settings.platformCookiesHint")}
          </p>
        </div>
        {!draft && (
          <Button
            size="sm"
            onClick={() => {
              setEditingOf(null);
              setDraft({ host: "", cookiesFile: "", cookiesText: "" });
            }}
          >
            {t("settings.platformCookies.add")}
          </Button>
        )}
      </div>

      {entries.length === 0 && !draft && (
        <p className="mt-4 text-xs text-neutral-400 dark:text-neutral-500">
          {t("settings.platformCookies.empty")}
        </p>
      )}

      {entries.length > 0 && (
        <ul className="mt-4 divide-y divide-neutral-100 dark:divide-neutral-800">
          {entries.map((e) => (
            <li key={e.host} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-neutral-700 dark:text-neutral-300">
                  {e.host}
                </div>
                <div
                  className="mt-0.5 truncate text-xs text-neutral-400 dark:text-neutral-500"
                  title={e.cookiesFile || undefined}
                >
                  {e.cookiesFile
                    ? `${t("settings.platformCookies.sourceFile")} · ${e.cookiesFile}`
                    : t("settings.platformCookies.sourceText")}
                </div>
              </div>
              <button
                onClick={() => {
                  setEditingOf(e.host);
                  setDraft({
                    host: e.host,
                    cookiesFile: e.cookiesFile || "",
                    cookiesText: e.cookiesText || "",
                  });
                }}
                disabled={!!draft}
                className="shrink-0 rounded-lg border border-neutral-200 px-2.5 py-1 text-xs text-neutral-500 transition hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                {t("dl.monitor.edit")}
              </button>
              <button
                onClick={() => void remove(e.host)}
                disabled={busy}
                className="shrink-0 rounded-lg border border-neutral-200 px-2.5 py-1 text-xs text-neutral-400 transition hover:bg-error-50 hover:text-error-500 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-error-950/40"
              >
                {t("dl.monitor.delete")}
              </button>
            </li>
          ))}
        </ul>
      )}

      {draft && (
        <div className="mt-4 space-y-3 rounded-xl bg-neutral-50 p-3 ring-1 ring-neutral-200 dark:bg-neutral-800/60 dark:ring-neutral-700">
          <div className="flex flex-wrap items-center gap-2">
            <span className="shrink-0 text-xs font-medium text-neutral-600 dark:text-neutral-300">
              {t("settings.platformCookies.host")}
            </span>
            <input
              value={draft.host}
              onChange={(ev) => setDraft({ ...draft, host: ev.target.value })}
              placeholder={t("settings.platformCookies.hostPlaceholder")}
              spellCheck={false}
              disabled={editingOf !== null}
              className="min-w-0 max-w-xs flex-1 rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="shrink-0 text-xs font-medium text-neutral-600 dark:text-neutral-300">
              {t("settings.cookiesFile")}
            </span>
            <input
              value={draft.cookiesFile || ""}
              onChange={(ev) => setDraft({ ...draft, cookiesFile: ev.target.value })}
              placeholder="cookies.txt"
              className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
            />
            <button
              onClick={async () => {
                const [sel] = await pickPaths({});
                if (sel) setDraft({ ...draft, cookiesFile: sel });
              }}
              className="shrink-0 rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              {t("settings.cookiesBrowse")}
            </button>
          </div>
          <textarea
            value={draft.cookiesText || ""}
            onChange={(ev) => setDraft({ ...draft, cookiesText: ev.target.value })}
            rows={3}
            spellCheck={false}
            placeholder="# Netscape HTTP Cookie File"
            className={`min-w-0 flex-1 resize-y rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 font-mono text-[11px] leading-relaxed dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 ${draftFileSet ? "opacity-50" : ""}`}
          />
          {error && (
            <p className="rounded-lg bg-error-50 px-2.5 py-1.5 text-[11px] text-error-600 dark:bg-error-950/30 dark:text-error-400">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() => void save()}
              disabled={busy || !draft.host.trim()}
              className="rounded-lg bg-brand-500 px-3 py-1 text-xs font-medium text-white transition hover:bg-brand-600 disabled:opacity-50 dark:bg-brand-600 dark:hover:bg-brand-700"
            >
              {t("dl.monitor.save")}
            </button>
            <button
              onClick={() => {
                setDraft(null);
                setEditingOf(null);
                setError(null);
              }}
              disabled={busy}
              className="rounded-lg border border-neutral-200 px-3 py-1 text-xs text-neutral-500 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              {t("dl.monitor.cancel")}
            </button>
          </div>
        </div>
      )}
      {dialog}
    </section>
  );
}

/** Cache maintenance: show how much space the app's own scratch data uses and
 *  clear what is safe to drop. User files and downloads are never reported or
 *  removed; the installed engine binary is measured but kept. */
function CacheSection() {
  const { t } = useI18n();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [report, setReport] = useState<CacheReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [result, setResult] = useState<CacheCleanResult | null>(null);

  const refresh = useCallback(() => {
    setRefreshing(true);
    cacheReport()
      .then(setReport)
      .catch(() => {})
      .finally(() => setRefreshing(false));
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
            disabled={refreshing}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-neutral-200 text-neutral-500 transition hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
            title={t("about.cache.refresh")}
            aria-label={t("about.cache.refresh")}
          >
            {refreshing ? (
              <SpinnerIcon className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshIcon className="h-4 w-4" />
            )}
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
