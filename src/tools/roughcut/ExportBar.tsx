//! Export controls for the rough-cut editor: lossless concat vs. precise
//! re-encode, target container, and (encode mode) codec / quality / GPU.
//! Copy-mode caveats surface here before the job ever reaches the queue:
//! keyframe-aligned cuts, no per-clip audio/speed tweaks, and the concat
//! compatibility pre-check.

import { useState } from "react";
import { useI18n } from "../../i18n";
import Select from "../../components/Select";
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
  const [mode, setMode] = useState<"copy" | "encode">("copy");
  const [container, setContainer] = useState<"mp4" | "mkv">("mp4");
  const [codec, setCodec] = useState<"libx264" | "libx265">("libx264");
  const [crf, setCrf] = useState<number>(CRF.balanced);
  const [gpu, setGpu] = useState<string>("");
  const [compat, setCompat] = useState<CompatResult | null>(null);
  const [checking, setChecking] = useState(false);

  const total = totalDuration(clips, sources);
  const tweaked = clips.some(
    (c) => c.mute || (c.speed ?? 1) !== 1 || Math.abs((c.volume ?? 1) - 1) > 1e-9
  );

  const runCompat = async () => {
    setChecking(true);
    try {
      setCompat(await checkConcatCompat(clips.map((c) => c.path)));
    } catch {
      setCompat(null);
    } finally {
      setChecking(false);
    }
  };

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

  return (
    <div className="px-3 py-2.5">
      <div className="flex flex-wrap items-end gap-2.5">
        <label className="min-w-32 flex-1">
          <span className="mb-0.5 block text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
            {t("rc.mode")}
          </span>
          <Select className="w-full" value={mode} onChange={(v) => setMode(v as typeof mode)}>
            <option value="copy">{t("rc.modeCopy")}</option>
            <option value="encode">{t("rc.modeEncode")}</option>
          </Select>
        </label>

        <label className="w-20">
          <span className="mb-0.5 block text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
            {t("rc.container")}
          </span>
          <Select
            className="w-full"
            value={container}
            onChange={(v) => setContainer(v as typeof container)}
          >
            <option value="mp4">MP4</option>
            <option value="mkv">MKV</option>
          </Select>
        </label>

        {mode === "encode" && (
          <>
            <label className="w-28">
              <span className="mb-0.5 block text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                {t("rc.codec")}
              </span>
              <Select className="w-full" value={codec} onChange={(v) => setCodec(v as typeof codec)}>
                <option value="libx264">H.264</option>
                <option value="libx265">H.265</option>
              </Select>
            </label>
            <label className="w-32">
              <span className="mb-0.5 block text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                {t("rc.quality")}
              </span>
              <Select className="w-full" value={String(crf)} onChange={(v) => setCrf(Number(v))}>
                {QUALITY_TIERS.map((tier) => (
                  <option key={tier.id} value={tier.id}>
                    {t(`rc.crf.${tier.key}`)} (CRF {tier.id})
                  </option>
                ))}
              </Select>
            </label>
            {gpuInfo.available && gpuInfo.backends.length > 0 && (
              <label className="w-28">
                <span className="mb-0.5 block text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                  {t("rc.gpu")}
                </span>
                <Select className="w-full" value={gpu} onChange={(v) => setGpu(v)}>
                  <option value="">{t("gpu.cpu")}</option>
                  {gpuInfo.backends.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </>
        )}

        <button
          type="button"
          onClick={exportNow}
          disabled={disabled || clips.length === 0}
          className="ml-auto rounded-lg bg-brand-500 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-brand-600"
        >
          {t("rc.export")}
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
        <span>
          {t("rc.summary", {
            n: clips.length,
            time: `${total.toFixed(1)}s`,
          })}
        </span>
        {mode === "copy" && (
          <>
            <span>{t("rc.modeCopyHint")}</span>
            {tweaked && <span className="text-warning-600 dark:text-warning-400">{t("rc.copyTweakWarn")}</span>}
            <button
              type="button"
              onClick={runCompat}
              disabled={checking || clips.length === 0}
              className="text-brand-600 underline-offset-2 transition hover:underline dark:text-brand-400 disabled:opacity-40"
            >
              {checking ? t("rc.compatChecking") : t("rc.compatCheck")}
            </button>
          </>
        )}
        {mode === "encode" && <span>{t("rc.modeEncodeHint")}</span>}
      </div>

      {compat && mode === "copy" && (
        <div
          className={`mt-1.5 rounded-md px-2.5 py-1.5 text-[11px] leading-relaxed ${
            compat.ok
              ? "bg-success-50 text-success-700 dark:bg-success-950/40 dark:text-success-400"
              : "bg-warning-50 text-warning-700 dark:bg-warning-950/40 dark:text-warning-400"
          }`}
        >
          {compat.ok ? (
            t("rc.compatOk")
          ) : (
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
          )}
        </div>
      )}
    </div>
  );
}
