import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ComponentType } from "react";
import type { ThemeMode } from "../hooks/useTheme";
import { AutoIcon, DownloadIcon, LogoIcon, MaximizeIcon, MinimizeIcon, MoonIcon, SpinnerIcon, SunIcon, XIcon, GlobeIcon } from "./icons";
import { useI18n } from "../i18n";
import { LOCALES, LOCALE_NAMES } from "../i18n/translations";
import type { UpdaterPhase } from "../hooks/useUpdater";

interface HeaderProps {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  updatePhase: UpdaterPhase;
  hasUpdate: boolean;
  onCheckUpdates: () => void;
}

const THEME_ICONS: Record<ThemeMode, ComponentType<{ className?: string }>> = {
  light: SunIcon,
  auto: AutoIcon,
  dark: MoonIcon,
};

export default function Header({
  themeMode,
  onThemeChange,
  updatePhase,
  hasUpdate,
  onCheckUpdates,
}: HeaderProps) {
  const appWindow = getCurrentWindow();
  const { t, locale, setLocale } = useI18n();

  return (
    <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/80 dark:border-neutral-800 dark:bg-neutral-950/80 backdrop-blur-md">
      <div className="flex w-full items-center gap-3 px-4 py-3">
        <div
          data-tauri-drag-region
          onDoubleClick={() => appWindow.toggleMaximize()}
          className="flex min-w-0 flex-1 cursor-default items-center gap-3"
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-xl brand-gradient shadow-sm">
            <LogoIcon className="h-6 w-6" />
          </div>
          <div className="leading-tight">
            <div className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
              MediaTool
            </div>
            <div className="text-xs text-neutral-500 dark:text-neutral-400">
              {t("header.subtitle")}
            </div>
          </div>
        </div>

        <span className="hidden rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700 dark:border-brand-800 dark:bg-brand-950/50 dark:text-brand-300 sm:inline">
          {t("header.tagline")}
        </span>

        {/* Language selector */}
        <div className="relative hidden sm:block">
          <select
            value={locale}
            onChange={(e) => setLocale(e.target.value as typeof locale)}
            title={t("header.language")}
            className="appearance-none h-9 rounded-xl border border-neutral-200 bg-white px-3 pr-10 text-xs text-neutral-700 transition hover:border-brand-300 focus:border-brand-400 focus:ring-1 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:border-brand-700 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDE2IDE2IiBmaWxsPSJub25lIj48cGF0aCBkPSJNNCA4bDQtNCA0IDQiIHN0cm9rZT0iIzk5OSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48L3N2Zz4=')] bg-[right_8px_center] bg-no-repeat"
          >
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {LOCALE_NAMES[l]}
              </option>
            ))}
          </select>
          <GlobeIcon className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400 pointer-events-none" />
        </div>

        {/* Update check */}
        <div className="flex items-center rounded-xl border border-neutral-200 bg-neutral-50/50 p-1 dark:border-neutral-700 dark:bg-neutral-800/50">
          <button
            onClick={onCheckUpdates}
            disabled={updatePhase === "checking" || updatePhase === "installing"}
            title={t("updater.check")}
            aria-label={t("updater.check")}
            className={`relative flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-200 disabled:opacity-50 ${
              hasUpdate
                ? "bg-brand-100/70 text-brand-700 dark:bg-brand-900/70 dark:text-brand-200"
                : "text-neutral-500 hover:text-neutral-700 hover:bg-neutral-200/50 dark:text-neutral-400 dark:hover:text-neutral-200 dark:hover:bg-neutral-700/50"
            }`}
          >
            {updatePhase === "checking" || updatePhase === "installing" ? (
              <SpinnerIcon className="h-4.5 w-4.5 animate-spin" />
            ) : (
              <DownloadIcon className="h-4.5 w-4.5" />
            )}
            {hasUpdate && updatePhase !== "checking" && updatePhase !== "installing" && (
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-error-500 ring-2 ring-white dark:ring-neutral-900" />
            )}
          </button>
        </div>

        {/* Theme toggle */}
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
                    : "text-neutral-500 hover:text-neutral-700 hover:bg-neutral-200/50 dark:text-neutral-400 dark:hover:text-neutral-200 dark:hover:bg-neutral-700/50"
                }`}
              >
                <Icon className="h-4.5 w-4.5" />
              </button>
            );
          })}
        </div>

        {/* Window controls */}
        <div className="flex items-center gap-1 pl-1">
          <button
            onClick={() => appWindow.minimize()}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-brand-50 hover:text-brand-600 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
            title={t("header.minimize")}
            aria-label={t("header.minimize")}
          >
            <MinimizeIcon className="h-4.5 w-4.5" />
          </button>
          <button
            onClick={() => appWindow.toggleMaximize()}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-brand-50 hover:text-brand-600 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
            title={t("header.maximize")}
            aria-label={t("header.maximize")}
          >
            <MaximizeIcon className="h-4.5 w-4.5" />
          </button>
          <button
            onClick={() => appWindow.close()}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-error-50 hover:text-error-600 dark:text-neutral-300 dark:hover:bg-error-900/30 dark:hover:text-error-400"
            title={t("header.close")}
            aria-label={t("header.close")}
          >
            <XIcon className="h-4.5 w-4.5" />
          </button>
        </div>
      </div>
    </header>
  );
}