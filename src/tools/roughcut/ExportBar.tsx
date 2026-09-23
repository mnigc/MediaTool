//! Export controls for the rough-cut editor: lossless concat vs. precise
//! re-encode, target container, and (encode mode) codec / quality / GPU.
//! Copy-mode caveats surface here before the job ever reaches the queue:
//! keyframe-aligned cuts, no per-clip audio/speed tweaks, and the concat
//! compatibility pre-check.

import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { useTasks } from "../../contexts/TaskCenter";
import Select from "../../components/Select";
import { Field } from "../panels/ui";
import { CRF } from "../../lib/quality";
import type { GpuInfo, RoughCutClip, RoughCutParams, VideoParams } from "../../types";
import { checkConcatCompat, type CompatResult } from "./compat";
import { totalDuration, type SourceInfo } from "./model";

const QUALITY_TIERS: Array<{ id: number; key: string }> = [
  { id: CRF.vlossless, key: "vlossless" },
  { id: CRF.high, key: "high" },
  { id: CRF.balanced, key: "balanced" },
  { id: CRF.social, key: "social" },
  { id: CRF.compact, key: "compact" },
];

export default function ExportBar({
  clips,
  sources,
  gpuInfo,
  disabled,
  onExport,
}: {
  clips: RoughCutClip[];
  sources: Map<string, SourceInfo>;
  gpuInfo: GpuInfo;
  disabled: boolean;
  onExport: (params: RoughCutParams) => void;
}) {
  const { t } = useI18n();
  const { settings, chooseOutput } = useTasks();
  const [mode, setMode] = useState<"copy" | "encode">("copy");
  const [container, setContainer] = useState<"mp4" | "mkv">("mp4");
  const [codec, setCodec] = useState<"libx264" | "libx265">("libx264");
  const [crf, setCrf] = useState<number>(CRF.balanced);
  const [gpu, setGpu] = useState<string>("");
  const [compat, setCompat] = useState<CompatResult | null>(null);
  const [checking, setChecking] = useState(false);
  const compatToken = useRef(0);

  const total = totalDuration(clips, sources);

  // Mirror the backend's output_path(): the configured output dir — or the
  // first clip's folder when none is set. Only the folder is shown; the file
  // name follows the first clip and would just duplicate it.
  const firstPath = clips[0]?.path ?? "";
  const sepIdx = Math.max(firstPath.lastIndexOf("\\"), firstPath.lastIndexOf("/"));
  const destDir = settings.outputDir || (sepIdx >= 0 ? firstPath.slice(0, sepIdx) : "");

  const tweaked = clips.some(
    (c) => c.mute || (c.speed ?? 1) !== 1 || Math.abs((c.volume ?? 1) - 1) > 1e-9
  );

  // Key the auto-check on the unique source set only: trims, reorders and
  // splits keep that set (and the result) unchanged, so only adding, removing
  // or replacing sources re-runs it.
  const sourceSig =
    mode === "copy" ? Array.from(new Set(clips.map((c) => c.path))).sort().join("\n") : "";

  useEffect(() => {
    if (!sourceSig) {
      setCompat(null);
      setChecking(false);
      return;
    }
    const token = ++compatToken.current;
    const timer = setTimeout(async () => {
      setChecking(true);
      try {
        const result = await checkConcatCompat(sourceSig.split("\n"));
        if (compatToken.current === token) setCompat(result);
      } catch {
        if (compatToken.current === token) setCompat(null);
      } finally {
        if (compatToken.current === token) setChecking(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [sourceSig]);

  const exportNow = () => {
    const encode: VideoParams | undefined =
      mode === "encode"
        ? {
            videoCodec: codec,
            qualityMode: "crf",
            crf,
            resolution: "original",
            audioCodec: "aac",
            audioBitrateKbps: 192,
            format: container,
            preset: "medium",
            fps: undefined,
            gpu: gpu || undefined,
          }
        : undefined;
    onExport({
      mode,
      clips,
      container,
      encode,
    });
  };

  /** One-word verdict for the status line; the detail block below still
   *  spells out every mismatch. */
  const compatBadge = () => {
    if (checking)
      return (
        <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500">
          {t("rc.compatChecking")}
        </span>
      );
    if (!compat) return null;
    return compat.ok ? (
      <span className="rounded-full bg-success-50 px-1.5 py-0.5 font-medium text-success-600 dark:bg-success-950/30 dark:text-success-400">
        {t("rc.compatOkShort")}
      </span>
    ) : (
      <span className="rounded-full bg-warning-50 px-1.5 py-0.5 font-medium text-warning-600 dark:bg-warning-950/30 dark:text-warning-400">
        {t("rc.compatIssueShort", {
          n: compat.problems.length + compat.unreadable.length,
        })}
      </span>
    );
  };

  return (
    <div className="px-3 py-2.5">
      {/* labels left, controls right — the same field grid as the clip panel
          above, so the two sections read as one form */}
      <div className="grid grid-cols-2 items-center gap-x-4 gap-y-2 md:grid-cols-3">
        <Field label={t("rc.mode")}>
          <Select className="w-full" value={mode} onChange={(v) => setMode(v as typeof mode)}>
            <option value="copy">{t("rc.modeCopy")}</option>
            <option value="encode">{t("rc.modeEncode")}</option>
          </Select>
        </Field>

        <Field label={t("rc.container")}>
          <Select
            className="w-full"
            value={container}
            onChange={(v) => setContainer(v as typeof container)}
          >
            <option value="mp4">MP4</option>
            <option value="mkv">MKV</option>
          </Select>
        </Field>

        {mode === "encode" && (
          <>
            <Field label={t("rc.codec")}>
              <Select className="w-full" value={codec} onChange={(v) => setCodec(v as typeof codec)}>
                <option value="libx264">H.264</option>
                <option value="libx265">H.265</option>
              </Select>
            </Field>
            <Field label={t("rc.quality")}>
              <Select className="w-full" value={String(crf)} onChange={(v) => setCrf(Number(v))}>
                {QUALITY_TIERS.map((tier) => (
                  <option key={tier.id} value={tier.id}>
                    {t(`rc.crf.${tier.key}`)} (CRF {tier.id})
                  </option>
                ))}
              </Select>
            </Field>
            {gpuInfo.available && gpuInfo.backends.length > 0 && (
              <Field label={t("rc.gpu")}>
                <Select className="w-full" value={gpu} onChange={(v) => setGpu(v)}>
                  <option value="">{t("gpu.cpu")}</option>
                  {gpuInfo.backends.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </>
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          onClick={exportNow}
          disabled={disabled || clips.length === 0}
          className="shrink-0 rounded-lg bg-brand-500 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-brand-600"
        >
          {t("rc.export")}
        </button>

        {clips.length > 0 && destDir && (
          <div className="flex min-w-0 items-center gap-1 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
            <span className="shrink-0">{t("rc.exportTo")}</span>
            <span className="min-w-0 truncate" title={destDir}>
              {destDir}
            </span>
            <button
              type="button"
              onClick={() => void chooseOutput()}
              className="shrink-0 text-brand-600 underline-offset-2 transition hover:underline dark:text-brand-400"
            >
              {t("rc.exportToChange")}
            </button>
          </div>
        )}

        {/* the whole verdict on one line: the trade-off prose lives in the ⓘ
            note by the page title, so the hints here stay three words each */}
        {clips.length > 0 && (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
            <span>
              {t("rc.summary", { n: clips.length, time: `${total.toFixed(1)}s` })}
            </span>
            <span aria-hidden>·</span>
            <span>{t(mode === "copy" ? "rc.modeCopyHintShort" : "rc.modeEncodeHintShort")}</span>
            {mode === "copy" && compatBadge()}
          </div>
        )}
      </div>

      {/* actionable, so it keeps its own line: copy mode silently drops tweaks */}
      {mode === "copy" && tweaked && (
        <p className="mt-1 text-[11px] leading-relaxed text-warning-600 dark:text-warning-400">
          {t("rc.copyTweakWarn")}
        </p>
      )}

      {compat && !compat.ok && mode === "copy" && (
        <div className="mt-1.5 rounded-md bg-warning-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-warning-700 dark:bg-warning-950/40 dark:text-warning-400">
          <div className="space-y-0.5">
            {compat.unreadable.map((p) => (
              <div key={p}>{t("rc.compatUnreadable", { file: p.split(/[\\/]/).pop() ?? p })}</div>
            ))}
            {compat.problems.slice(0, 6).map((p, i) => (
              <div key={`${p.source}-${p.field}-${i}`}>
                {t("rc.compatIssue", {
                  file: p.source.split(/[\\/]/).pop() ?? p.source,
                  field: t(`rc.field.${p.field}`),
                  a: p.first,
                  b: p.other,
                })}
              </div>
            ))}
            {compat.problems.length > 6 && (
              <div>{t("rc.compatMore", { n: compat.problems.length - 6 })}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
