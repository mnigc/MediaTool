import { useEffect, useState } from "react";
import { inspectMedia } from "../lib/tauri";
import { useI18n } from "../i18n";
import { useTasks } from "../contexts/TaskCenter";
import { getTool, type WorkbenchId } from "./registry";
import FilePicker from "./FilePicker";
import TaskWorkbench from "./TaskWorkbench";
import WorkflowPage from "./WorkflowPage";
import InspectReport from "./panels/InspectPanel";
import MergeWorkbench from "./MergeWorkbench";
import type { MediaReport } from "../types";

function WorkbenchHeader({ tool, onBack }: { tool: WorkbenchId; onBack?: () => void }) {
  const { t } = useI18n();
  return (
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
      <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">
        {t(`tool.${tool}.name`)}
      </h2>
      <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
        {t(`tool.${tool}.desc`)}
      </p>
    </div>
  );
}

/** Instant ffprobe report viewer (not a queued task). */
function InspectWorkbench({ onBack }: { onBack?: () => void }) {
  const { t } = useI18n();
  const tasks = useTasks();
  const meta = getTool("inspect")!;
  const [file, setFile] = useState<string | null>(null);
  const [report, setReport] = useState<MediaReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    tasks.registerDropHandler((paths) => {
      const valid = paths.find((p) => meta.accepts.some((e) => p.toLowerCase().endsWith(`.${e}`)));
      if (valid) setFile(valid);
    });
    return () => tasks.registerDropHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!file) {
      setReport(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setReport(null);
    inspectMedia(file)
      .then((r) => !cancelled && setReport(r))
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [file]);

  return (
    <div className="mx-auto max-w-2xl">
      <WorkbenchHeader tool="inspect" onBack={onBack} />
      <FilePicker key="inspect" meta={meta} files={file ? [file] : []} onChange={(fs) => setFile(fs[0] ?? null)} />

      <div className="mt-4">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-neutral-400 dark:text-neutral-500">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
            {t("job.estimating")}
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-error-100 bg-error-50 px-4 py-2.5 text-sm text-error-700 dark:border-error-900/50 dark:bg-error-950/30 dark:text-error-400">
            {t("err.read", { error })}
          </div>
        )}
        {report && <InspectReport report={report} />}
      </div>
    </div>
  );
}

export default function ToolWorkbench({ tool, onBack }: { tool: WorkbenchId; onBack?: () => void }) {
  if (tool === "inspect") return <InspectWorkbench onBack={onBack} />;
  if (tool === "workflow") return <WorkflowPage onBack={onBack} />;
  if (tool === "video-merge" || tool === "audio-merge") {
    return <MergeWorkbench tool={tool} onBack={onBack} />;
  }
  return <TaskWorkbench toolId={tool} onBack={onBack} />;
}
