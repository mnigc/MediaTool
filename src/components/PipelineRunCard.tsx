import type { PipelineRunTask } from "../workflow/types";
import { openOutputFolder } from "../lib/engine";
import { canRevealInFolder } from "../lib/shell";
import { useI18n } from "../i18n";
import { FilmIcon, FolderIcon, SpinnerIcon, XIcon } from "./icons";

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1);
}

/** Task-center card for a pipeline-center run (workflow page batches). The
 *  run keeps executing when the workflow page is closed; this card is its
 *  global handle: progress, cancel, retry, remove. */
export default function PipelineRunCard({
  run,
  onCancel,
  onRetry,
  onRemove,
}: {
  run: PipelineRunTask;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useI18n();
  const total = run.files.length;
  const done = run.files.filter((f) => f.status === "done" || f.status === "skipped").length;
  const failed = run.files.filter((f) => f.status === "error").length;
  const runningFile = run.files.find((f) => f.status === "running");
  const lastOutput = [...run.files].reverse().find((f) => f.output)?.output ?? null;

  const badge = (() => {
    switch (run.phase) {
      case "running":
        return "bg-brand-50 text-brand-600 dark:bg-brand-950/40 dark:text-brand-400";
      case "done":
        return "bg-success-50 text-success-600 dark:bg-success-950/40 dark:text-success-400";
      case "error":
        return "bg-error-50 text-error-600 dark:bg-error-950/40 dark:text-error-400";
      default:
        return "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400";
    }
  })();
  const badgeLabel = (() => {
    switch (run.phase) {
      case "running":
        return t("dl.phase.running");
      case "done":
        return t("dl.phase.done");
      case "error":
        return t("dl.phase.error");
      default:
        return t("dl.phase.cancelled");
    }
  })();

  const firstError = run.files.find((f) => f.status === "error" && f.error)?.error;

  const statusBar =
    run.phase === "running"
      ? "status-bar-running"
      : run.phase === "done"
        ? "status-bar-done"
        : run.phase === "error"
          ? "status-bar-error"
          : "status-bar-cancelled";

  return (
    <div className={`pop rounded-2xl bg-white p-5 shadow-card ring-1 ring-neutral-200 transition-all duration-200 ${statusBar} hover:shadow-card-hover dark:bg-neutral-900 dark:ring-neutral-800`}>
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 ring-1 ring-brand-200 dark:bg-brand-950 dark:text-brand-300 dark:ring-brand-800">
          <FilmIcon className="h-6 w-6 text-brand-600 dark:text-brand-300" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="shrink-0 whitespace-nowrap rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium ring-1 ring-brand-200 dark:bg-brand-950 dark:text-brand-300 dark:ring-brand-800">
              {t("module.tasks.pipelineTag")}
            </span>
            <h3 className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100" title={run.name}>
              {run.name}
            </h3>
            <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge}`}>
              {run.phase === "running" && (
                <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500 dark:bg-brand-400" />
              )}
              {badgeLabel}
            </span>
          </div>
          <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
            {t("workflow.run.fileOf", { i: Math.min(done + (runningFile ? 1 : 0), total), n: total })}
            {run.phase === "done" && ` · ${t("workflow.run.done")}`}
            {failed > 0 && ` · ${t("workflow.run.failedCount", { n: failed })}`}
            {run.steps.length > 0 &&
              ` · ${run.steps.map((s) => t(`tool.${s.toolId}.name`)).join(" + ")}`}
          </p>
        </div>

        <div className="flex shrink-0 items-start gap-1.5">
          {run.phase === "running" && (
            <button
              onClick={() => onCancel(run.id)}
              className="rounded-lg border border-neutral-200 px-2.5 py-1 text-[11px] font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              {t("confirm.cancel")}
            </button>
          )}
          {(run.phase === "error" || run.phase === "cancelled") && (
            <button
              onClick={() => onRetry(run.id)}
              className="rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-[11px] font-medium text-brand-700 transition hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
            >
              {t("workflow.run.retry")}
            </button>
          )}
          {lastOutput && run.phase !== "running" && canRevealInFolder && (
            <button
              onClick={() => void openOutputFolder(lastOutput)}
              className="flex h-6 w-6 items-center justify-center rounded-lg border border-neutral-200 text-neutral-500 transition hover:border-brand-200 hover:bg-brand-50 hover:text-brand-600 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-brand-800 dark:hover:bg-brand-950/40 dark:hover:text-brand-400"
              title={t("dl.openFolder")}
              aria-label={t("dl.openFolder")}
            >
              <FolderIcon className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={() => onRemove(run.id)}
            className="rounded-lg p-1.5 text-neutral-300 transition hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            title={t("job.remove")}
            aria-label={t("job.remove")}
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {run.phase === "running" && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
            <div
              className="h-full rounded-full bg-brand-500 transition-all duration-300"
              style={{ width: `${Math.max(Math.round(runningFile?.percent ?? 0), 2)}%` }}
            />
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-400 dark:text-neutral-500">
            <span className="flex items-center gap-1.5">
              <SpinnerIcon className="h-3 w-3 animate-spin text-brand-500" />
              {basename(runningFile?.input ?? "")}
            </span>
            <span className="ml-auto tabular-nums">
              {t("workflow.run.step", {
                name: t(
                  `tool.${run.steps[runningFile?.stepIndex ?? 0]?.toolId ?? run.steps[0]?.toolId ?? ""}.name`
                ),
              })}
            </span>
          </div>
        </div>
      )}

      {run.phase !== "running" && lastOutput && (
        <p className="mt-2 truncate text-[11px] text-neutral-400 dark:text-neutral-500" title={lastOutput}>
          {lastOutput}
        </p>
      )}

      {firstError && (
        <p className="mt-2 truncate text-[11px] text-error-500 dark:text-error-400" title={firstError}>
          {firstError}
        </p>
      )}
    </div>
  );
}
