import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogoIcon, MaximizeIcon, MinimizeIcon, XIcon } from "./icons";
import { useI18n } from "../i18n";

export default function Header() {
  const appWindow = getCurrentWindow();
  const { t } = useI18n();

  return (
    <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/80 dark:border-neutral-800 dark:bg-neutral-950/80 backdrop-blur-md">
      <div className="flex w-full items-center gap-3 px-4 py-3">
        <div
          data-tauri-drag-region
          onDoubleClick={() => appWindow.toggleMaximize()}
          className="flex min-w-0 flex-1 cursor-default items-center gap-3"
        >
          <LogoIcon className="h-9 w-9 drop-shadow-sm" />
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