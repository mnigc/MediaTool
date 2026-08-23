import { useEffect, useState } from "react";
import { inspectMedia } from "../lib/tauri";
import { useI18n } from "../i18n";
import { useTasks } from "../contexts/TaskCenter";
import { getTool, type WorkbenchId } from "./registry";
import { blankToolParams } from "./defaults";
import FilePicker from "./FilePicker";
import CompressWorkbench from "./CompressWorkbench";
import GifPanel from "./panels/GifPanel";
import ScreenshotPanel from "./panels/ScreenshotPanel";
import SpeedPanel from "./panels/SpeedPanel";
import WatermarkPanel from "./panels/WatermarkPanel";
import InspectReport from "./panels/InspectPanel";
import type {
  GifParams,
  MediaReport,
  ScreenshotParams,
  SpeedParams,
  ToolParams,
  WatermarkParams,
} from "../types";

function WorkbenchHeader({ tool }: { tool: WorkbenchId }) {
  const { t } = useI18n();
  return (
    <div className="mb-5">
      <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">
        {t(`tool.${tool}.name`)}
      </h2>
      <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
        {t(`tool.${tool}.desc`)}
      </p>
    </div>
  );
}

/** Generic single-file tool workbench: picker + params panel + queue action. */
function SimpleToolWorkbench({ tool }: { tool: Exclude<WorkbenchId, "compress" | "inspect"> }) {
  const { t } = useI18n();
  const tasks = useTasks();
  const meta = getTool(tool)!;
  const [files, setFiles] = useState<string[]>([]);
  const [params, setParams] = useState<ToolParams | null>(() => blankToolParams(tool));

  useEffect(() => {
    tasks.registerDropHandler((paths) => {
      const valid = paths.filter((p) => meta.accepts.some((e) => p.toLowerCase().endsWith(`.${e}`)));
      if (valid.length === 0) return;
      setFiles(meta.multiFile ? [...new Set([...files, ...valid])] : valid.slice(0, 1));
    });
    return () => tasks.registerDropHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  const canQueue =
    files.length > 0 && params != null && (tool !== "watermark" || !!(params as WatermarkParams).imagePath);

  return (
    <div className="mx-auto max-w-2xl">
      <WorkbenchHeader tool={tool} />
      <div className="space-y-4">
        <FilePicker
          key={tool}
          meta={meta}
          files={files}
          onChange={setFiles}
        />
        {params && tool === "gif" && (
          <GifPanel params={params as GifParams} onChange={(p) => setParams(p)} />
        )}
        {params && tool === "screenshot" && (
          <ScreenshotPanel params={params as ScreenshotParams} onChange={(p) => setParams(p)} />
        )}
        {params && tool === "speed" && (
          <SpeedPanel params={params as SpeedParams} onChange={(p) => setParams(p)} />
        )}
        {params && tool === "watermark" && (
          <WatermarkPanel params={params as WatermarkParams} onChange={(p) => setParams(p)} />
        )}

        <button
          type="button"
          disabled={!canQueue}
          onClick={() => {
            void tasks.addTasks(tool, files, params!);
            setFiles([]);
          }}
          className="w-full rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-brand-600 dark:hover:bg-brand-700"
        >
          {t("tool.addToTasks", { n: files.length })}
        </button>
      </div>
    </div>
  );
}

/** Instant ffprobe report viewer (not a queued task). */
function InspectWorkbench() {
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
    if (!file) return;
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
      <WorkbenchHeader tool="inspect" />
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

export default function ToolWorkbench({ tool }: { tool: WorkbenchId }) {
  if (tool === "compress") return <CompressWorkbench />;
  if (tool === "inspect") return <InspectWorkbench />;
  return <SimpleToolWorkbench tool={tool} />;
}
