import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../i18n";
import { useTasks } from "../contexts/TaskCenter";
import { VIDEO_EXTS } from "./registry";
import { openOutputFolder } from "../lib/tauri";
import { friendlyError } from "../lib/errors";
import { defaultParamsFor } from "../lib/defaults";
import JobParamsEditor from "./JobParamsEditor";
import { startWorkflow } from "../workflow/engine";
import { WORKFLOW_STEP_TOOLS, type StepRun, type WorkflowStep } from "../workflow/types";
import type { JobParams, ToolId } from "../types";

let stepCounter = 0;
const newStepId = () => `step-${++stepCounter}`;

function firstVideo(paths: string[]): string | null {
  const v = paths.find((p) => {
    const ext = p.replace(/\\/g, "/").split(".").pop()?.toLowerCase() ?? "";
    return VIDEO_EXTS.includes(ext);
  });
  return v ?? null;
}

export default function WorkflowPage({ onBack }: { onBack?: () => void }) {
  const { t } = useI18n();
  const tasks = useTasks();
  const [input, setInput] = useState<string | null>(null);
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [runStates, setRunStates] = useState<StepRun[]>([]);
  const [result, setResult] = useState<{ ok: boolean; error?: string | null; output?: string | null } | null>(null);
  const handleRef = useRef<ReturnType<typeof startWorkflow> | null>(null);
  const addRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    tasks.registerDropHandler((paths) => {
      const v = firstVideo(paths);
      if (v) {
        setInput(v);
        setResult(null);
      }
    });
    return () => tasks.registerDropHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close the "add step" dropdown when clicking outside of it.
  useEffect(() => {
    if (!addOpen) return;
    const onClick = (e: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) {
        setAddOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [addOpen]);

  const browse = async () => {
    const sel = await open({
      multiple: false,
      title: t("opt.selectFiles"),
      filters: [{ name: t("dz.filter.video"), extensions: VIDEO_EXTS }],
    });
    if (sel && !Array.isArray(sel)) {
      setInput(sel);
      setResult(null);
    }
  };

  const addStep = (toolId: string) => {
    const params = defaultParamsFor(toolId as ToolId);
    setSteps((s) => [...s, { id: newStepId(), toolId, params }]);
    setAddOpen(false);
  };

  const changeParams = (id: string, params: JobParams) =>
    setSteps((s) => s.map((st) => (st.id === id ? { ...st, params } : st)));

  const removeStep = (id: string) => setSteps((s) => s.filter((st) => st.id !== id));

  const moveStep = (idx: number, dir: -1 | 1) => {
    setSteps((s) => {
      const to = idx + dir;
      if (to < 0 || to >= s.length) return s;
      const copy = [...s];
      const [m] = copy.splice(idx, 1);
      copy.splice(to, 0, m);
      return copy;
    });
  };

  const canRun = !running && !!input && steps.length > 0;

  const onUpdate = useCallback((r: StepRun) => {
    setRunStates((prev) => {
      const next = [...prev];
      next[r.index] = r;
      return next;
    });
  }, []);

  const run = async () => {
    if (!input || steps.length === 0) return;
    setRunning(true);
    setResult(null);
    setRunStates(steps.map(() => ({ index: 0, status: "idle", percent: 0 })));
    handleRef.current = startWorkflow({
      input,
      steps,
      settings: {
        outputDir: tasks.settings.outputDir ?? undefined,
        outputSuffix: tasks.settings.outputSuffix,
        gpu: tasks.settings.gpu,
        overwritePolicy: tasks.settings.overwritePolicy,
      },
      onUpdate,
      onFinish: (ok, error, output) => {
        setRunning(false);
        setResult({ ok, error, output });
      },
      t,
    });
    try {
      await handleRef.current.promise;
    } catch {
      setRunning(false);
    }
  };

  const cancel = () => handleRef.current?.cancel();

  const runningState = (i: number): StepRun | undefined => runStates[i];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">
            {t("tool.workflow.name")}
          </h2>
          <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
            {t("tool.workflow.desc")}
          </p>
        </div>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            <span className="h-3 w-3" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </span>
            {t("module.back")}
          </button>
        )}
      </div>

      {/* Input */}
      <div className="rounded-xl bg-neutral-50 p-3 ring-1 ring-neutral-200 dark:bg-neutral-900/50 dark:ring-neutral-800">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void browse()}
            disabled={running}
            className="shrink-0 rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700 transition hover:bg-brand-100 disabled:opacity-40 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
          >
            {input ? t("workflow.changeInput") : t("workflow.chooseInput")}
          </button>
          {input ? (
            <span className="min-w-0 flex-1 truncate text-sm text-neutral-700 dark:text-neutral-200" title={input}>
              {input.replace(/\\/g, "/").split("/").pop()}
            </span>
          ) : (
            <span className="text-xs text-neutral-400 dark:text-neutral-500">{t("workflow.noInputHint")}</span>
          )}
        </div>
        {!input && (
          <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">{t("workflow.dragHint")}</p>
        )}
      </div>

      {/* Steps */}
      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
            {t("workflow.steps")} · {steps.length}
          </span>
          <div className="relative" ref={addRef}>
            <button
              type="button"
              onClick={() => setAddOpen((v) => !v)}
              disabled={running}
              className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              {t("workflow.addStep")}
            </button>
            {addOpen && (
              <div className="absolute right-0 top-full z-30 mt-1 max-h-72 w-56 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1.5 shadow-card dark:border-neutral-700 dark:bg-neutral-900 animate-slide-up">
                {WORKFLOW_STEP_TOOLS.map((toolId) => (
                  <button
                    key={toolId}
                    type="button"
                    onClick={() => addStep(toolId)}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-neutral-700 transition hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
                  >
                    <span className="text-neutral-400 dark:text-neutral-500">{t(`tool.${toolId}.name`)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {steps.length === 0 ? (
          <p className="rounded-xl bg-neutral-50 px-4 py-6 text-center text-xs text-neutral-400 dark:bg-neutral-900/50 dark:text-neutral-500">
            {t("workflow.noSteps")}
          </p>
        ) : (
          <div className="space-y-2">
            {steps.map((st, i) => {
              const rs = runningState(i);
              return (
                <div
                  key={st.id}
                  className="rounded-xl bg-white p-3 ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[10px] font-semibold text-brand-600 dark:bg-brand-950/40 dark:text-brand-400">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
                      {t(`tool.${st.toolId}.name`)}
                    </span>
                    {rs && rs.status === "running" && (
                      <span className="text-[10px] text-brand-600 dark:text-brand-400">
                        {Math.round(rs.percent)}%
                      </span>
                    )}
                    {rs && rs.status === "done" && (
                      <span className="rounded-full bg-success-50 px-2 py-0.5 text-[10px] font-medium text-success-600 dark:bg-success-950/30 dark:text-success-400">
                        {t("app.doneBadge")}
                      </span>
                    )}
                    {rs && rs.status === "error" && (
                      <span className="rounded-full bg-error-50 px-2 py-0.5 text-[10px] font-medium text-error-600 dark:bg-error-950/30 dark:text-error-400">
                        {t("app.failedBadge")}
                      </span>
                    )}
                    {!running && (
                      <>
                        <button
                          type="button"
                          disabled={i === 0}
                          onClick={() => moveStep(i, -1)}
                          className="rounded p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-30 dark:hover:bg-neutral-800"
                          aria-label={t("workflow.moveUp")}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={i === steps.length - 1}
                          onClick={() => moveStep(i, 1)}
                          className="rounded p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-30 dark:hover:bg-neutral-800"
                          aria-label={t("workflow.moveDown")}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => removeStep(st.id)}
                          className="rounded p-1 text-neutral-400 transition hover:bg-error-50 hover:text-error-500 dark:hover:bg-error-950/30 dark:hover:text-error-400"
                          aria-label={t("job.remove")}
                        >
                          ✕
                        </button>
                      </>
                    )}
                  </div>

                  {rs && rs.status === "error" && rs.error && (
                    <div className="mt-2 rounded-lg bg-error-50 px-3 py-2 text-[11px] text-error-600 dark:bg-error-950/30 dark:text-error-400">
                      {rs.error}
                    </div>
                  )}

                  {!running && (
                    <div className="mt-3 border-t border-neutral-100 pt-3 dark:border-neutral-700/60">
                      <JobParamsEditor
                        toolId={st.toolId}
                        params={st.params}
                        onChange={(p) => changeParams(st.id, p)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="mt-4 flex items-center gap-2">
        {running ? (
          <button
            type="button"
            onClick={cancel}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-error-200 bg-error-50 px-4 py-2.5 text-sm font-medium text-error-600 transition hover:bg-error-100 dark:border-error-800 dark:bg-error-950/30 dark:text-error-400"
          >
            {t("confirm.cancel")}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void run()}
            disabled={!canRun}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-brand-600 dark:hover:bg-brand-700"
          >
            {t("workflow.run")}
          </button>
        )}
        {result && result.output && (
          <button
            type="button"
            onClick={() => openOutputFolder(result.output!)}
            className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            {t("job.open")}
          </button>
        )}
      </div>

      {result && (
        <div
          className={`mt-3 rounded-xl px-4 py-3 text-sm ${
            result.ok
              ? "bg-success-50 text-neutral-800 ring-1 ring-success-100 dark:bg-success-950/20 dark:ring-success-900/50"
              : "bg-error-50 text-error-700 ring-1 ring-error-100 dark:bg-error-950/30 dark:text-error-400"
          }`}
        >
          {result.ok
            ? t("workflow.finished")
            : `${t("workflow.failed")}${result.error ? ` · ${friendlyError(result.error, t)}` : ""}`}
        </div>
      )}
    </div>
  );
}
