import { useEffect, useRef, useState } from "react";
import { canRevealInFolder, pickPaths } from "../lib/shell";
import { useI18n } from "../i18n";
import { useTasks } from "../contexts/TaskCenter";
import { usePipelineRuns } from "../contexts/PipelineCenter";
import {
  addPipeline,
  pipelineDisplayName,
  removePipeline,
  renamePipeline,
  usePipelines,
} from "../workflow/pipelines";
import type { Pipeline } from "../workflow/pipelines";
import { VIDEO_EXTS } from "./registry";
import { openOutputFolder } from "../lib/engine";
import { friendlyError } from "../lib/errors";
import { defaultParamsFor } from "../lib/defaults";
import { useConfirm } from "../components/ConfirmDialog";
import UploadTargetChips from "../components/UploadTargetChips";
import JobParamsEditor from "./JobParamsEditor";
import {
  CheckIcon,
  SpinnerIcon,
  XIcon,
} from "../components/icons";
import { TERMINAL_STEP_TOOLS, WORKFLOW_STEP_TOOLS, type WorkflowStep } from "../workflow/types";
import type { JobParams, ToolId } from "../types";

let stepCounter = 0;
const newStepId = () => `step-${++stepCounter}`;

function isVideo(p: string): boolean {
  const ext = p.replace(/\\/g, "/").split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTS.includes(ext);
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1);
}

type NameModal =
  | { mode: "save"; name: string }
  | { mode: "rename"; id: string; name: string }
  | null;

export default function WorkflowPage({ onBack }: { onBack?: () => void }) {
  const { t } = useI18n();
  const tasks = useTasks();
  const runs = usePipelineRuns();
  const pipelines = usePipelines();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [files, setFiles] = useState<string[]>([]);
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [uploadTo, setUploadTo] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [nameModal, setNameModal] = useState<NameModal>(null);
  /** Pipeline the current chain was loaded from / saved as — its name labels
   *  the run; editing the chain afterwards keeps the stale label, which is
   *  fine for a display snapshot. */
  const [linkedPipeline, setLinkedPipeline] = useState<Pipeline | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const loadRef = useRef<HTMLDivElement>(null);

  const lastRun = runs.runs.find((r) => r.id === lastRunId) ?? null;

  useEffect(() => {
    tasks.registerDropHandler((paths) => {
      const v = paths.filter(isVideo);
      if (v.length > 0) {
        setFiles((prev) => {
          const seen = new Set(prev);
          return [...prev, ...v.filter((p) => !seen.has(p))];
        });
      }
    });
    return () => tasks.registerDropHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close the "add step" / "load pipeline" dropdowns on outside clicks.
  useEffect(() => {
    if (!addOpen && !loadOpen) return;
    const onClick = (e: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAddOpen(false);
      if (loadRef.current && !loadRef.current.contains(e.target as Node)) setLoadOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [addOpen, loadOpen]);

  const browse = async () => {
    const list = await pickPaths({
      multiple: true,
      title: t("opt.selectFiles"),
      filterName: t("dz.filter.video"),
      extensions: VIDEO_EXTS,
    });
    if (!list.length) return;
    setFiles((prev) => [...prev, ...list.filter((p) => isVideo(p) && !prev.includes(p))]);
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

  const loadPipeline = (p: Pipeline) => {
    setSteps(p.steps.map((s) => ({ id: newStepId(), toolId: s.toolId, params: { ...s.params } })));
    setLinkedPipeline(p);
    setLoadOpen(false);
  };

  const savePipeline = (name: string) => {
    const created = addPipeline(
      name,
      steps.map((s) => ({ toolId: s.toolId, params: s.params }))
    );
    setLinkedPipeline(created);
    setNameModal(null);
  };

  const applyRename = (id: string, name: string) => {
    renamePipeline(id, name);
    setLinkedPipeline((p) => (p && p.id === id ? { ...p, name: name.trim() } : p));
    setNameModal(null);
  };

  const deletePipeline = async (p: Pipeline) => {
    const ok = await confirm({
      title: t("workflow.pipeline.delete"),
      message: t("workflow.pipeline.deleteMsg", { name: pipelineDisplayName(p, t) }),
      confirmLabel: t("workflow.pipeline.delete"),
      cancelLabel: t("confirm.cancel"),
      danger: true,
    });
    if (!ok) return;
    removePipeline(p.id);
    setLinkedPipeline((cur) => (cur && cur.id === p.id ? null : cur));
  };

  // A terminal step (screenshot/extract-audio) emits a non-video artifact:
  // nothing can run after it, so once present no further steps can be added.
  const hasTerminal = steps.some((s) => TERMINAL_STEP_TOOLS.includes(s.toolId));
  const runName =
    linkedPipeline?.name ??
    steps.map((s) => t(`tool.${s.toolId}.name`)).join(" + ");

  const canRun = files.length > 0 && steps.length > 0 && lastRun?.phase !== "running";

  const start = () => {
    if (!canRun) return;
    setLastRunId(
      runs.startRun({
        name: runName,
        steps: steps.map((s) => ({ id: s.id, toolId: s.toolId, params: s.params })),
        files,
        uploadTo,
      })
    );
  };

  const doneCount = lastRun?.files.filter((f) => f.status === "done" || f.status === "skipped").length ?? 0;
  const runningFile = lastRun?.files.find((f) => f.status === "running");

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

      {/* Input files */}
      <div className="rounded-xl bg-neutral-50 p-3 ring-1 ring-neutral-200 dark:bg-neutral-900/50 dark:ring-neutral-800">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void browse()}
            disabled={lastRun?.phase === "running"}
            className="shrink-0 rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700 transition hover:bg-brand-100 disabled:opacity-40 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
          >
            {t("workflow.addFiles")}
          </button>
          {files.length > 0 && (
            <>
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                {t("workflow.filesCount", { n: files.length })}
              </span>
              <button
                type="button"
                onClick={() => setFiles([])}
                disabled={lastRun?.phase === "running"}
                className="ml-auto rounded-lg px-2 py-1 text-xs text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-40 dark:hover:bg-neutral-800"
              >
                {t("workflow.clearFiles")}
              </button>
            </>
          )}
        </div>
        {files.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {files.map((f) => (
              <span
                key={f}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs text-neutral-700 ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:ring-neutral-700"
                title={f}
              >
                <span className="max-w-[220px] truncate">{basename(f)}</span>
                {lastRun?.phase !== "running" && (
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}
                    className="text-neutral-300 transition hover:text-error-500 dark:text-neutral-500"
                    aria-label={t("job.remove")}
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                )}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
            {t("workflow.dragHint")}
          </p>
        )}
      </div>

      {/* Pipeline save / load */}
      <div className="mt-3 flex items-center gap-2">
        <div className="relative" ref={loadRef}>
          <button
            type="button"
            onClick={() => setLoadOpen((v) => !v)}
            disabled={lastRun?.phase === "running"}
            className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            {t("workflow.pipeline.load")}
          </button>
          {loadOpen && (
            <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-64 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1.5 shadow-card dark:border-neutral-700 dark:bg-neutral-900 animate-slide-up">
              {pipelines.length === 0 && (
                <p className="px-2.5 py-2 text-xs text-neutral-400 dark:text-neutral-500">
                  {t("workflow.pipeline.none")}
                </p>
              )}
              {pipelines.map((p) => (
                <div key={p.id} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => loadPipeline(p)}
                    title={p.descKey ? t(p.descKey) : undefined}
                    className="min-w-0 flex-1 truncate rounded-lg px-2.5 py-2 text-left text-xs text-neutral-700 transition hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
                  >
                    {pipelineDisplayName(p, t)}
                    {p.builtin && (
                      <span className="ml-1.5 text-[10px] text-neutral-400 dark:text-neutral-500">
                        {t("preset.builtin")}
                      </span>
                    )}
                  </button>
                  {!p.builtin && (
                    <>
                      <button
                        type="button"
                        onClick={() => setNameModal({ mode: "rename", id: p.id, name: p.name })}
                        className="rounded px-1 py-1 text-[10px] text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800"
                        title={t("workflow.pipeline.rename")}
                      >
                        {t("workflow.pipeline.rename")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void deletePipeline(p)}
                        className="rounded px-1 py-1 text-[10px] text-neutral-400 transition hover:bg-error-50 hover:text-error-500 dark:hover:bg-error-950/30"
                        title={t("workflow.pipeline.delete")}
                      >
                        {t("workflow.pipeline.delete")}
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setNameModal({ mode: "save", name: linkedPipeline?.name ?? "" })}
          disabled={steps.length === 0}
          className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
        >
          {t("workflow.pipeline.save")}
        </button>
        {linkedPipeline && (
          <span className="min-w-0 truncate text-xs text-neutral-400 dark:text-neutral-500">
            {t("workflow.pipeline.loaded", { name: linkedPipeline.name })}
          </span>
        )}
      </div>

      {/* Upload targets: the run's products go here when finished. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="shrink-0 text-xs font-medium text-neutral-500 dark:text-neutral-400">
          {t("upload.pick.title")}
        </span>
        <UploadTargetChips selected={uploadTo} onChange={setUploadTo} />
      </div>

      {/* Steps */}
      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold text-neutral-600 dark:text-neutral-300">
            {t("workflow.steps")} · {steps.length}
          </span>
          <div className="relative" ref={addRef}>
            <button
              type="button"
              onClick={() => setAddOpen((v) => !v)}
              disabled={lastRun?.phase === "running"}
              className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              {t("workflow.addStep")}
            </button>
            {addOpen && (
              <div className="absolute right-0 top-full z-30 mt-1 max-h-72 w-56 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1.5 shadow-card dark:border-neutral-700 dark:bg-neutral-900 animate-slide-up">
                {hasTerminal && (
                  <p className="px-2.5 py-1.5 text-[10px] text-neutral-400 dark:text-neutral-500">
                    {t("workflow.terminalHint")}
                  </p>
                )}
                {WORKFLOW_STEP_TOOLS.map((toolId) => (
                  <button
                    key={toolId}
                    type="button"
                    onClick={() => addStep(toolId)}
                    disabled={hasTerminal}
                    title={hasTerminal ? t("workflow.terminalHint") : undefined}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-neutral-700 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:text-neutral-200 dark:hover:bg-neutral-800"
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
              const locked = lastRun?.phase === "running";
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
                    {!locked && (
                      <>
                        <button
                          type="button"
                          disabled={i === 0 || TERMINAL_STEP_TOOLS.includes(st.toolId)}
                          onClick={() => moveStep(i, -1)}
                          className="rounded p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-30 dark:hover:bg-neutral-800"
                          aria-label={t("workflow.moveUp")}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={
                            i === steps.length - 1 ||
                            (i + 1 < steps.length && TERMINAL_STEP_TOOLS.includes(steps[i + 1].toolId))
                          }
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

                  {!locked && (
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

      {/* Run */}
      <div className="mt-4 flex items-center gap-2">
        {lastRun?.phase === "running" ? (
          <button
            type="button"
            onClick={() => runs.cancelRun(lastRun.id)}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-error-200 bg-error-50 px-4 py-2.5 text-sm font-medium text-error-600 transition hover:bg-error-100 dark:border-error-800 dark:bg-error-950/30 dark:text-error-400"
          >
            {t("confirm.cancel")}
          </button>
        ) : (
          <button
            type="button"
            onClick={start}
            disabled={!canRun}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-brand-600 dark:hover:bg-brand-700"
          >
            {t("workflow.run.start")}
          </button>
        )}
      </div>

      {/* Run progress */}
      {lastRun && (
        <div className="mt-4 rounded-xl bg-white p-4 ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-800 dark:text-neutral-100">
              {lastRun.name}
            </span>
            <span className="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">
              {t("workflow.run.fileOf", { i: Math.min(doneCount + (runningFile ? 1 : 0), lastRun.files.length), n: lastRun.files.length })}
            </span>
          </div>

          {lastRun.phase === "running" && (
            <>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                <div
                  className="h-full rounded-full bg-brand-500 transition-all duration-300"
                  style={{ width: `${Math.max(Math.round(runningFile?.percent ?? 0), 2)}%` }}
                />
              </div>
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-neutral-400 dark:text-neutral-500">
                <SpinnerIcon className="h-3 w-3 animate-spin text-brand-500" />
                {t("workflow.run.step", {
                  name: t(
                    `tool.${lastRun.steps[runningFile?.stepIndex ?? 0]?.toolId ?? lastRun.steps[0]?.toolId ?? ""}.name`
                  ),
                })}
              </p>
            </>
          )}

          {(lastRun.phase === "done" || lastRun.phase === "error") && (
            <p
              className={`mt-2 flex items-center gap-1.5 text-xs font-medium ${
                lastRun.phase === "done"
                  ? "text-success-600 dark:text-success-400"
                  : "text-error-600 dark:text-error-400"
              }`}
            >
              {lastRun.phase === "done" ? (
                <>
                  <CheckIcon className="h-3.5 w-3.5" />
                  {t("workflow.run.done")}
                </>
              ) : (
                t("workflow.run.failed")
              )}
            </p>
          )}
          {lastRun.phase === "cancelled" && (
            <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
              {t("workflow.run.cancelled")}
            </p>
          )}

          <div className="mt-3 space-y-1.5 border-t border-neutral-100 pt-3 dark:border-neutral-700/60">
            {lastRun.files.map((f, i) => {
              const ok = f.status === "done" || f.status === "skipped";
              return (
                <div key={`${f.input}-${i}`} className="flex items-center gap-2 text-xs">
                  <span className="w-4 shrink-0 text-center">
                    {ok ? (
                      <CheckIcon className="h-3 w-3 text-success-500" />
                    ) : f.status === "running" ? (
                      <SpinnerIcon className="h-3 w-3 animate-spin text-brand-500" />
                    ) : f.status === "error" ? (
                      <span className="text-error-500">✕</span>
                    ) : f.status === "cancelled" ? (
                      <span className="text-neutral-300 dark:text-neutral-600">—</span>
                    ) : (
                      <span className="text-neutral-300 dark:text-neutral-600">·</span>
                    )}
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate ${
                      f.status === "pending"
                        ? "text-neutral-400 dark:text-neutral-500"
                        : "text-neutral-700 dark:text-neutral-200"
                    }`}
                    title={f.input}
                  >
                    {basename(f.input)}
                  </span>
                  {f.status === "error" && f.error && (
                    <span
                      className="max-w-[45%] truncate text-[11px] text-error-500 dark:text-error-400"
                      title={friendlyError(f.error, t)}
                    >
                      {friendlyError(f.error, t)}
                    </span>
                  )}
                  {ok && f.output && canRevealInFolder && (
                    <button
                      type="button"
                      onClick={() => void openOutputFolder(f.output!)}
                      className="shrink-0 text-[11px] font-medium text-brand-600 transition hover:text-brand-700 dark:text-brand-400"
                      title={f.output}
                    >
                      {t("job.open")}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {(lastRun.phase === "error" || lastRun.phase === "cancelled") && (
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => runs.retryRun(lastRun.id)}
                className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700 transition hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
              >
                {t("workflow.run.retry")}
              </button>
            </div>
          )}
        </div>
      )}

      {confirmDialog}

      {nameModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setNameModal(null)} />
          <div className="relative z-10 w-full max-w-sm min-w-0 rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-700 slide-up">
            <h3 className="break-words text-sm font-semibold text-neutral-800 dark:text-neutral-100">
              {nameModal.mode === "save" ? t("workflow.pipeline.saveTitle") : t("workflow.pipeline.rename")}
            </h3>
            <label className="mt-3 flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                {t("workflow.pipeline.nameLabel")}
              </span>
              <input
                autoFocus
                value={nameModal.name}
                onChange={(e) => setNameModal({ ...nameModal, name: e.target.value } as NameModal)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && nameModal.name.trim()) {
                    nameModal.mode === "save"
                      ? savePipeline(nameModal.name)
                      : applyRename(nameModal.id, nameModal.name);
                  }
                }}
                placeholder={t("workflow.pipeline.namePlaceholder")}
                className="rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-700 shadow-sm focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setNameModal(null)}
                className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
              >
                {t("pm.cancel")}
              </button>
              <button
                type="button"
                disabled={!nameModal.name.trim()}
                onClick={() =>
                  nameModal.mode === "save"
                    ? savePipeline(nameModal.name)
                    : applyRename(nameModal.id, nameModal.name)
                }
                className="rounded-lg bg-brand-500 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-brand-600 dark:hover:bg-brand-700"
              >
                {t("pm.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
