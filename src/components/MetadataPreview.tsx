import { useEffect, useRef, useState } from "react";
import { formatBytes, inspectMedia } from "../lib/tauri";
import { useI18n } from "../i18n";
import type { MediaReport } from "../types";

interface Entry {
  report: MediaReport | null;
  error?: string;
}

/** Tags that commonly leak private info, highlighted so users can spot them. */
const PRIVACY_RE = /gps|location|exif|latitude|longitude|geolocation|\bmake\b|\bmodel\b|imei|coordinates|device|camera/i;

function tagEntries(tags: unknown): [string, string][] {
  if (!tags || typeof tags !== "object") return [];
  return Object.entries(tags as Record<string, unknown>).map(([k, v]) => [
    k,
    typeof v === "string" ? v : JSON.stringify(v),
  ]);
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function TagRow({ k, v }: { k: string; v: string }) {
  const { t } = useI18n();
  const priv = PRIVACY_RE.test(k);
  return (
    <div className="flex items-start justify-between gap-3 py-0.5">
      <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {k}
        {priv && (
          <span className="rounded bg-error-100 px-1 py-0.5 text-[9px] font-semibold text-error-700 dark:bg-error-900/40 dark:text-error-300">
            {t("stripmd.privacy")}
          </span>
        )}
      </span>
      <span className="min-w-0 break-all text-right text-xs text-neutral-700 dark:text-neutral-200">
        {v}
      </span>
    </div>
  );
}

function FileCard({
  path,
  entry,
}: {
  path: string;
  entry: Entry;
}) {
  const { t } = useI18n();
  const r = entry.report;

  if (entry.error) {
    return (
      <div className="rounded-xl border border-error-100 bg-error-50 p-3 dark:border-error-900/40 dark:bg-error-950/20">
        <div className="text-xs font-medium text-error-700 dark:text-error-300">
          {fileName(path)}
        </div>
        <div className="mt-1 text-[11px] text-error-600/80 dark:text-error-400">
          {t("stripmd.error")}
        </div>
      </div>
    );
  }

  if (!r) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-neutral-50/40 p-3 dark:border-neutral-700/60 dark:bg-neutral-800/40">
        <div className="text-xs text-neutral-500 dark:text-neutral-400">
          {fileName(path)}
        </div>
        <div className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
          {t("stripmd.loading")}
        </div>
      </div>
    );
  }

  const global = tagEntries(r.tags);
  const chapterCount = r.chapterCount ?? 0;
  const streamsWithTags = r.streams.filter((s) => tagEntries(s.tags).length > 0);
  const hasAnything = global.length > 0 || streamsWithTags.length > 0 || chapterCount > 0;

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-700/60 dark:bg-neutral-800/40">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-semibold text-neutral-800 dark:text-neutral-100">
          {fileName(r.path)}
        </span>
        <span className="shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500">
          {formatBytes(r.sizeBytes)}
        </span>
      </div>
      {!hasAnything ? (
        <div className="mt-1.5 text-[11px] text-neutral-400 dark:text-neutral-500">
          {t("stripmd.empty")}
        </div>
      ) : (
        <>
          {chapterCount > 0 && (
            <div className="mt-1.5 rounded-md bg-error-100/70 px-2 py-1 text-[11px] font-medium text-error-700 dark:bg-error-900/30 dark:text-error-300">
              {t("stripmd.chapters", { n: chapterCount })}
            </div>
          )}
          {global.length > 0 && (
            <div className="mt-2 space-y-0.5">
              {global.map(([k, v]) => (
                <TagRow key={k} k={k} v={v} />
              ))}
            </div>
          )}
          {r.streams.map((s) => {
            const st = tagEntries(s.tags);
            if (st.length === 0) return null;
            return (
              <div
                key={`${s.kind}-${s.index}`}
                className="mt-2 rounded-md bg-neutral-50/60 px-2 py-1.5 dark:bg-neutral-900/40"
              >
                <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                  {t("stripmd.stream", { i: s.index, kind: s.kind })}
                  {s.language ? ` · ${s.language}` : ""}
                </div>
                <div className="mt-0.5">
                  {st.map(([k, v]) => (
                    <TagRow key={k} k={k} v={v} />
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

/** Lists the metadata that will be stripped per file. Auto-inspects inputs on
 *  mount and when the path list changes. Cards are derived from `paths`, so dups
 *  are impossible even under StrictMode's double-invoked effects. */
export default function MetadataPreview({ paths }: { paths: string[] }) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const inspected = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const path of paths) {
      if (inspected.current.has(path)) continue;
      inspected.current.add(path);
      setEntries((prev) => (prev[path] ? prev : { ...prev, [path]: { report: null } }));
      inspectMedia(path)
        .then((report) => setEntries((prev) => ({ ...prev, [path]: { report } })))
        .catch(() =>
          setEntries((prev) => ({ ...prev, [path]: { report: null, error: "failed" } }))
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths.join("|")]);

  if (paths.length === 0) return null;

  return (
    <div className="mt-4 space-y-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
        {t("stripmd.title")}
      </div>
      <div className="space-y-2">
        {paths.map((p) => (
          <FileCard key={p} path={p} entry={entries[p] ?? { report: null }} />
        ))}
      </div>
    </div>
  );
}
