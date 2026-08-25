import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useTasks } from "../contexts/TaskCenter";
import { extOk } from "./FilePicker";
import { getTool, type WorkbenchId } from "./registry";
import { MergeIcon } from "../components/icons";
import { openOutputFolder } from "../lib/tauri";

export default function MergeWorkbench({
  tool,
  onBack,
}: {
  tool: WorkbenchId;
  onBack?: () => void;
}) {
  const { t } = useI18n();
  const tasks = useTasks();
  const meta = getTool(tool)!;
  const accepts = meta.accepts;
  const [files, setFiles] = useState<string[]>([]);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    tasks.registerDropHandler((paths) => {
      const valid = paths.filter((p) => extOk(p, accepts));
      if (valid.length) setFiles((prev) => Array.from(new Set([...prev, ...valid])));
    });
    return () => tasks.registerDropHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  const job = useMemo(() => {
    return tasks.jobs
      .filter((j) => j.toolId === tool && (j.phase === "running" || j.phase === "done" || j.phase === "error"))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  }, [tasks.jobs, tool]);

  const pick = async () => {
    const mod = await import("@tauri-apps/plugin-dialog");
    const selected = await mod.open({
      multiple: true,
      title: t("merge.select"),
      filters: [{ name: t(`dz.filter.${meta.mediaType}`), extensions: accepts }],
    });
    if (Array.isArray(selected)) {
      setFiles((prev) => Array.from(new Set([...prev, ...selected])));
    } else if (typeof selected === "string") {
      setFiles((prev) => Array.from(new Set([...prev, selected])));
    }
  };

  const removeAt = (i: number) => setFiles((prev) => prev.filter((_, idx) => idx !== i));

  const run = () => {
    if (files.length >= 2) tasks.mergeAndStart(tool as never, files);
  };

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-5">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="mb-3 flex items-center gap-1 rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            <span className="h-3 w-3" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </span>
            {t("module.back")}
          </button>
        )}
        <h2 className="flex items-center gap-2 text-lg font-semibold text-neutral-800 dark:text-neutral-100">
          <MergeIcon className="h-5 w-5 text-brand-500" />
          {t(`tool.${tool}.name`)}
        </h2>
        <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
          {t(`tool.${tool}.desc`)}
        </p>
      </div>

      <div
        ref={dropRef}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const paths = (e.dataTransfer as unknown as { files?: unknown }).files
            ? Array.from(e.dataTransfer.files).map((f) => (f as unknown as { path: string }).path)
            : [];
          const valid = paths.filter((p) => extOk(p, accepts));
          if (valid.length) setFiles((prev) => Array.from(new Set([...prev, ...valid])));
        }}
        className="rounded-2xl border-2 border-dashed border-neutral-200 bg-neutral-50/40 p-6 text-center dark:border-neutral-700 dark:bg-neutral-800/40"
      >
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{t("merge.hint")}</p>
        <button
          type="button"
          onClick={pick}
          className="mt-3 rounded-xl bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 dark:bg-brand-600"
        >
          {t("merge.add")}
        </button>
      </div>

      {files.length > 0 && (
        <ul className="mt-4 space-y-2">
          {files.map((f, i) => (
            <li
              key={f + i}
              className="flex items-center justify-between rounded-xl bg-white px-3 py-2 text-sm ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800"
            >
              <span className="truncate text-neutral-700 dark:text-neutral-200">{f.split(/[\\/]/).pop()}</span>
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="ml-3 shrink-0 rounded p-1 text-neutral-400 hover:text-error-500"
                aria-label={t("job.remove")}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={run}
        disabled={files.length < 2}
        className="mt-4 w-full rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-brand-600"
      >
        {t("merge.run", { n: files.length })}
      </button>

      {job && (
        <div className="mt-4 rounded-2xl bg-white p-5 ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
          {job.phase === "running" && (
            <div>
              <div className="mb-1.5 flex items-center gap-2 text-sm text-brand-600 dark:text-brand-400">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
                {t("merge.merging")} {job.percent.toFixed(0)}%
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${job.percent}%` }} />
              </div>
            </div>
          )}
          {job.phase === "done" && job.output && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-success-700 dark:text-success-400">{t("merge.done")}</span>
              <button
                onClick={() => openOutputFolder(job.output!)}
                className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-brand-700 ring-1 ring-brand-200 dark:bg-neutral-800 dark:text-brand-300 dark:ring-neutral-700"
              >
                {t("job.open")}
              </button>
            </div>
          )}
          {job.phase === "error" && (
            <span className="text-sm text-error-600 dark:text-error-400">{job.error}</span>
          )}
        </div>
      )}
    </div>
  );
}
