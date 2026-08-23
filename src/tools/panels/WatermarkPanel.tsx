import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getThumbnail } from "../../lib/tauri";
import { useI18n } from "../../i18n";
import type { WatermarkParams } from "../../types";
import { Field, FieldRow, NumInput } from "./ui";

const POSITIONS = ["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"] as const;

export default function WatermarkPanel({
  params,
  onChange,
}: {
  params: WatermarkParams;
  onChange: (p: WatermarkParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<WatermarkParams>) => onChange({ ...params, ...patch });
  const [wmThumb, setWmThumb] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setWmThumb(null);
    if (params.imagePath) {
      getThumbnail(params.imagePath, "image")
        .then((t) => !cancelled && setWmThumb(t))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [params.imagePath]);

  const pickImage = async () => {
    const sel2 = await open({
      multiple: false,
      title: t("tool.wm.pickImage"),
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (sel2 && !Array.isArray(sel2)) set({ imagePath: sel2 });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={pickImage}
          className="shrink-0 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition hover:border-brand-200 hover:bg-brand-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
        >
          {params.imagePath ? t("tool.wm.changeImage") : t("tool.wm.pickImage")}
        </button>
        {wmThumb && (
          <img src={wmThumb} alt="" className="h-9 w-9 rounded-lg object-contain ring-1 ring-neutral-200 dark:ring-neutral-700" />
        )}
        {params.imagePath && (
          <span className="min-w-0 flex-1 truncate text-xs text-neutral-500 dark:text-neutral-400" title={params.imagePath}>
            {params.imagePath.replace(/\\/g, "/").split("/").pop()}
          </span>
        )}
      </div>

      <Field label={t("tool.wm.position")}>
        <div className="grid w-[72px] grid-cols-3 gap-1">
          {POSITIONS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => set({ position: p })}
              className={`h-6 w-6 rounded transition ${
                params.position === p
                  ? "bg-brand-600 dark:bg-brand-500"
                  : "bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-700 dark:hover:bg-neutral-600"
              }`}
              title={p}
            />
          ))}
        </div>
      </Field>

      <Field label={t("tool.wm.scale")}>
        <input
          type="range"
          min={5}
          max={60}
          value={params.scalePercent}
          onChange={(e) => set({ scalePercent: Number(e.target.value) })}
          className="mp-range flex-1"
        />
      </Field>
      <FieldRow>
        <Field label={t("tool.wm.opacity")}>
          <NumInput
            value={Math.round(params.opacity * 100)}
            min={5}
            max={100}
            step={5}
            onChange={(v) => set({ opacity: (v ?? 100) / 100 })}
          />
        </Field>
        <Field label={t("tool.wm.margin")}>
          <NumInput
            value={params.marginPercent}
            min={0}
            max={30}
            step={1}
            onChange={(v) => set({ marginPercent: v ?? 3 })}
          />
        </Field>
      </FieldRow>
    </div>
  );
}
