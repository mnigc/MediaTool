import type { PipelineRun } from "../workflow/types";
import { useI18n, type TranslationKey } from "../i18n";

/** Inline sub-progress for a bound post-processing pipeline, rendered on the
 *  card of the task it is attached to (job cards and download cards alike).
 *  The two copies it replaces had drifted apart in layout; this is the job
 *  card's shape (step label above the bar, percent at the right edge). */
export default function PipelineMiniProgress({
  run,
  stepName,
  labelKey = "job.pipeline.step",
}: {
  run: PipelineRun;
  /** Display name of the running step, already resolved by the caller. */
  stepName: string;
  /** i18n key of the label template; each domain keeps its own copy. */
  labelKey?: TranslationKey;
}) {
  const { t } = useI18n();
  const pct = Math.round(run.percent);
  return (
    <div className="mt-2.5">
      <div className="mb-1 flex items-center justify-between text-[11px] text-neutral-400 dark:text-neutral-500">
        <span className="font-medium text-neutral-600 dark:text-neutral-300">
          {t(labelKey, { name: stepName })}
        </span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
        <div
          className="h-full rounded-full bg-brand-500 transition-all duration-300"
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>
    </div>
  );
}
