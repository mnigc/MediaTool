import { useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../i18n";
import { DEV_UNAVAILABLE, useUpdater } from "../hooks/useUpdater";
import { CheckCircleIcon, CheckIcon, DownloadIcon, LogoIcon, SpinnerIcon } from "../components/icons";

const GITHUB_URL = "https://github.com/mnigc/MediaTool";

const FEATURES = [
  "about.features.ffmpeg",
  "about.features.lossless",
  "about.features.privacy",
  "about.features.batch",
] as const;

interface AboutPageProps {
  currentVersion: string;
  updater: ReturnType<typeof useUpdater>;
  onToast: (type: "success" | "error" | "info", msg: string) => void;
}

export default function AboutPage({ currentVersion, updater, onToast }: AboutPageProps) {
  const { t } = useI18n();
  const { phase, update, progress, checkForUpdates, download, installAndRelaunch } =
    updater;

  const handleCheck = useCallback(async () => {
    const result = await checkForUpdates(false);
    if (result.ok) {
      if (!result.update) onToast("success", t("about.latest"));
      return;
    }
    if (result.message === DEV_UNAVAILABLE) {
      onToast("info", t("updater.dev"));
    } else {
      onToast(
        "error",
        result.message ? `${t("updater.failed")}: ${result.message}` : t("updater.failed")
      );
    }
  }, [checkForUpdates, t, onToast]);

  const handleDownload = useCallback(() => {
    download().catch(() => {});
  }, [download]);

  const handleRestart = useCallback(() => {
    installAndRelaunch().catch(() => {});
  }, [installAndRelaunch]);

  const hasUpdate = update !== null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* App identity */}
      <div className="flex items-center gap-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl brand-gradient shadow-sm">
          <LogoIcon className="h-8 w-8" />
        </div>
        <div className="min-w-0">
          <div className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            MediaTool
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
            <span>{t("header.subtitle")}</span>
            <span className="rounded-lg bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
              v{currentVersion}
            </span>
          </div>
        </div>
      </div>

      {/* Features */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          {t("about.features.title")}
        </h2>
        <ul className="mt-4 space-y-3">
          {FEATURES.map((key) => (
            <li
              key={key}
              className="flex items-start gap-3 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300"
            >
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-600 dark:bg-brand-900/60 dark:text-brand-300">
                <CheckIcon className="h-3 w-3" />
              </span>
              {t(key)}
            </li>
          ))}
        </ul>
      </section>

      {/* GitHub */}
      <section className="flex items-center justify-between gap-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
        <div>
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
            {t("about.github.hint")}
          </h2>
        </div>
        <a
          href={GITHUB_URL}
          onClick={(e) => {
            e.preventDefault();
            openUrl(GITHUB_URL).catch(() => {});
          }}
          className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 active:bg-brand-700"
        >
          <DownloadIcon className="h-4 w-4" />
          {t("about.github")}
        </a>
      </section>

      {/* Update */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
            {t("about.update.title")}
          </h2>
          <span className="rounded-lg bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            v{currentVersion}
          </span>
        </div>

        <div className="mt-4 space-y-4">
          {phase === "downloading" && (
            <div>
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-neutral-600 dark:text-neutral-300">
                  {t("updater.downloading")}
                </span>
                <span className="font-medium text-brand-600 dark:text-brand-300">
                  {progress}%
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                <div
                  className="h-full rounded-full brand-gradient transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {phase === "downloaded" && (
            <div className="flex items-start gap-3 rounded-xl bg-success-50 p-3 text-sm text-success-700 ring-1 ring-success-200 dark:bg-success-900/20 dark:text-success-300 dark:ring-success-900/40">
              <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex-1">
                <p>{t("about.downloadedHint")}</p>
                <button
                  onClick={handleRestart}
                  className="mt-3 inline-flex items-center gap-2 rounded-xl bg-success-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-success-700"
                >
                  {t("updater.restart.title")}
                </button>
              </div>
            </div>
          )}

          {phase === "installing" && (
            <div className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
              <SpinnerIcon className="h-4 w-4 animate-spin" />
              {t("updater.installing")}
            </div>
          )}

          {phase === "checking" && (
            <div className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
              <SpinnerIcon className="h-4 w-4 animate-spin" />
              {t("updater.checking")}
            </div>
          )}

          {phase === "idle" && hasUpdate && (
            <div className="flex items-center justify-between gap-4 rounded-xl bg-brand-50 p-3 ring-1 ring-brand-200 dark:bg-brand-900/20 dark:ring-brand-900/40">
              <div className="min-w-0 text-sm">
                <div className="font-semibold text-brand-700 dark:text-brand-300">
                  {t("about.newVersion")}
                </div>
                <div className="mt-0.5 text-brand-600/80 dark:text-brand-300/80">
                  {t("updater.current")} v{currentVersion} → v{update?.version}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={handleDownload}
                  className="inline-flex items-center gap-2 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 active:bg-brand-700"
                >
                  <DownloadIcon className="h-4 w-4" />
                  {t("updater.download")}
                </button>
              </div>
            </div>
          )}

          {phase === "idle" && !hasUpdate && (
            <div className="flex items-center justify-end">
              <button
                onClick={handleCheck}
                className="inline-flex items-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
              >
                <DownloadIcon className="h-4 w-4" />
                {t("updater.check")}
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
