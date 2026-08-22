import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ComponentType } from "react";
import type { ThemeMode } from "../hooks/useTheme";
import { AutoIcon, LogoIcon, MaximizeIcon, MinimizeIcon, MoonIcon, SunIcon, XIcon } from "./icons";
import { useI18n } from "../i18n";
import { LOCALES, LOCALE_NAMES } from "../i18n/translations";

interface HeaderProps {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
}

const THEME_ICONS: Record<ThemeMode, ComponentType<{ className?: string }>> = {
  light: SunIcon,
  auto: AutoIcon,
  dark: MoonIcon,
};

export default function Header({ themeMode, onThemeChange }: HeaderProps) {
  const appWindow = getCurrentWindow();
  const { t, locale, setLocale } = useI18n();

  return (
    <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/95 backdrop-blur-sm dark:border-neutral-800 dark:bg-neutral-950/95">
      <div className="flex w-full items-center gap-3 px-4 py-3">
        <div
          data-tauri-drag-region
          onDoubleClick={() => appWindow.toggleMaximize()}
          className="flex min-w-0 flex-1 cursor-default items-center gap-3"
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-lg brand-gradient">
            <LogoIcon className="h-6 w-6" />
          </div>
          <div className="leading-tight">
            <div className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
              MediPress
            </div>
            <div className="text-xs text-neutral-500 dark:text-neutral-400">
              {t("header.subtitle")}
            </div>
          </div>
        </div>

        <span className="hidden rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700 dark:border-brand-800 dark:bg-brand-950/50 dark:text-brand-300 sm:inline">
          {t("header.tagline")}
        </span>

        <select
          value={locale}
          onChange={(e) => setLocale(e.target.value as typeof locale)}
          title={t("header.language")}
          className="hidden h-8 rounded-lg border border-neutral-200 bg-neutral-50 px-2 text-xs text-neutral-600 transition focus:border-brand-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 sm:inline"
        >
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {LOCALE_NAMES[l]}
            </option>
          ))}
        </select>

        <div className="flex items-center rounded-lg border border-neutral-200 bg-neutral-50 p-0.5 dark:border-neutral-700 dark:bg-neutral-800">
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
                className={`flex h-7 w-7 items-center justify-center rounded-md transition ${
                  themeMode === opt
                    ? "bg-white shadow-sm text-brand-700 ring-1 ring-brand-200 dark:bg-neutral-700 dark:text-brand-300 dark:ring-neutral-600"
                    : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
                }`}
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1 pl-1">
          <button
            onClick={() => appWindow.minimize()}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-brand-50 hover:text-brand-700 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
            title={t("header.minimize")}
          >
            <MinimizeIcon className="h-4 w-4" />
          </button>
          <button
            onClick={() => appWindow.toggleMaximize()}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-brand-50 hover:text-brand-700 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
            title={t("header.maximize")}
          >
            <MaximizeIcon className="h-4 w-4" />
          </button>
          <button
            onClick={() => appWindow.close()}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-error-50 hover:text-error-600 dark:text-neutral-300 dark:hover:bg-error-900/30 dark:hover:text-error-400"
            title={t("header.close")}
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
