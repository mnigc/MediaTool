import { useCallback, useEffect, useState, type ReactNode } from "react";
import { formatBytes, fsList } from "../lib/engine";
import { isDesktop, registerFilePicker, type PickOptions } from "../lib/shell";
import type { DirListing, FsEntry } from "../types";
import { useI18n } from "../i18n";
import { Button, inputCls } from "./ui";
import {
  CheckIcon,
  ChevronUpIcon,
  FolderIcon,
  GridIcon,
  RefreshIcon,
  SpinnerIcon,
  XIcon,
} from "./icons";

/**
 * Server-side directory browser — the web mode's file dialog.
 *
 * A desktop build asks the OS for paths and the user is already inside their
 * own filesystem. Here the app runs on a NAS, so "choose a file" means
 * browsing the mounts the operator allowlisted (`fs_roots`), and every path
 * shown is a container path the engines can actually open.
 */

interface Pending {
  options: PickOptions;
  resolve: (paths: string[]) => void;
}

export function FileBrowserProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    if (isDesktop) return;
    registerFilePicker(
      (options) => new Promise<string[]>((resolve) => setPending({ options, resolve }))
    );
    return () => registerFilePicker(null);
  }, []);

  const done = useCallback(
    (paths: string[]) => {
      pending?.resolve(paths);
      setPending(null);
    },
    [pending]
  );

  return (
    <>
      {children}
      {pending && <FileBrowser options={pending.options} onDone={done} />}
    </>
  );
}

function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function FileBrowser({ options, onDone }: { options: PickOptions; onDone: (paths: string[]) => void }) {
  const { t } = useI18n();
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [attempt, setAttempt] = useState(0);

  const accepts = options.extensions?.map((e) => e.toLowerCase()) ?? [];
  const pickable = (e: FsEntry) => !accepts.length || accepts.includes(extOf(e.name));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fsList(path)
      .then((l) => !cancelled && setListing(l))
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path, attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  const toggle = (entry: FsEntry) => {
    if (options.multiple) {
      setSelected((prev) =>
        prev.includes(entry.path)
          ? prev.filter((p) => p !== entry.path)
          : [...prev, entry.path]
      );
      return;
    }
    setSelected([entry.path]);
  };

  const entries = listing?.entries ?? [];
  const visible = filter.trim()
    ? entries.filter((e) => e.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : entries;
  const confirmDisabled = options.directory ? !listing?.path : selected.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={options.title ?? t("fb.title")}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => onDone([])} />
      <div className="relative z-10 flex h-[70vh] w-full max-w-2xl flex-col rounded-2xl bg-white p-5 shadow-popover ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-700 animate-pop">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {options.title ?? t("fb.title")}
          </h3>
          <button
            onClick={() => onDone([])}
            className="rounded-lg p-1.5 text-neutral-300 transition hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            aria-label={t("a11y.close")}
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Where we are, and the two ways out of it. */}
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" onClick={() => setPath("")} title={t("fb.roots")}>
            <GridIcon className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            onClick={() => setPath(listing?.parent ?? "")}
            disabled={!listing?.parent}
            title={t("fb.up")}
          >
            <ChevronUpIcon className="h-3.5 w-3.5" />
          </Button>
          <span
            className="min-w-0 flex-1 truncate text-xs text-neutral-500 dark:text-neutral-400"
            title={listing?.path || t("fb.roots")}
          >
            {listing?.path || t("fb.roots")}
          </span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("fb.filter")}
            className={`${inputCls} w-36`}
          />
        </div>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl ring-1 ring-neutral-200 dark:ring-neutral-700">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-neutral-400">
              <SpinnerIcon className="h-4 w-4 animate-spin" />
              {t("fb.loading")}
            </div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-sm text-error-500">{error}</p>
              <Button size="sm" onClick={() => setAttempt((a) => a + 1)}>
                <RefreshIcon className="h-3.5 w-3.5" />
                {t("fb.retry")}
              </Button>
            </div>
          ) : visible.length === 0 ? (
            <p className="p-6 text-center text-sm text-neutral-400">{t("fb.empty")}</p>
          ) : (
            <ul>
              {visible.map((e) => {
                const chosen = selected.includes(e.path);
                const disabled = !e.isDir && (options.directory || !pickable(e));
                return (
                  <li key={e.path}>
                    <button
                      // A directory is always entered — in folder-picking mode
                      // that is how you reach the folder you meant to choose.
                      onClick={() =>
                        e.isDir ? setPath(e.path) : toggle(e)
                      }
                      disabled={disabled}
                      className={`flex w-full items-center gap-2.5 border-b border-neutral-100 px-3 py-2 text-left text-sm last:border-b-0 dark:border-neutral-800 ${
                        chosen
                          ? "bg-brand-50 text-brand-800 dark:bg-brand-950/40 dark:text-brand-200"
                          : "text-neutral-700 hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-800/60"
                      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
                      title={e.path}
                    >
                      {e.isDir ? (
                        <FolderIcon className="h-4 w-4 shrink-0 text-brand-500" />
                      ) : (
                        <span className="h-4 w-4 shrink-0" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{e.name}</span>
                      {!e.isDir && e.size > 0 && (
                        <span className="shrink-0 text-xs text-neutral-400">
                          {formatBytes(e.size)}
                        </span>
                      )}
                      {chosen && <CheckIcon className="h-4 w-4 shrink-0 text-brand-600" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {listing?.truncated && (
            <p className="p-3 text-center text-xs text-neutral-400">
              {t("fb.truncated", { n: entries.length })}
            </p>
          )}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-neutral-500 dark:text-neutral-400">
            {options.directory
              ? listing?.path || t("fb.roots")
              : selected.length
                ? t("fb.selected", { n: selected.length })
                : t("fb.none")}
          </span>
          <Button variant="ghost" onClick={() => onDone([])}>
            {t("confirm.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={confirmDisabled}
            onClick={() =>
              onDone(options.directory ? [listing?.path ?? ""] : selected.slice())
            }
          >
            {options.directory ? t("fb.pickFolder") : t("fb.pick")}
          </Button>
        </div>
      </div>
    </div>
  );
}
