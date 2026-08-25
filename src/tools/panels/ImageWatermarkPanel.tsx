import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getThumbnail } from "../../lib/tauri";
import { useI18n } from "../../i18n";
import type { ImageWatermarkParams } from "../../types";
import { Field, FieldRow, NumInput, sel } from "./ui";

const POSITIONS = ["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"] as const;

export default function ImageWatermarkPanel({
  params,
  onChange,
}: {
  params: ImageWatermarkParams;
  onChange: (p: ImageWatermarkParams) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<ImageWatermarkParams>) => onChange({ ...params, ...patch });
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setThumb(null);
    if (params.imagePath) {
      getThumbnail(params.imagePath, "image")
        .then((x) => !cancelled && setThumb(x))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [params.imagePath]);

  const pick = async () => {
    const s = await open({
      multiple: false,
      title: t("opt.wmImagePick"),
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (s && !Array.isArray(s)) set({ imagePath: s });
  };

  return (
    <div className="space-y-3">
      <Field label={t("opt.wmMode")}>
        <select
          className={sel}
          value={params.mode}
          onChange={(e) => set({ mode: e.target.value as ImageWatermarkParams["mode"] })}
        >
          <option value="text">{t("opt.wmMode.text")}</option>
          <option value="image">{t("opt.wmMode.image")}</option>
        </select>
      </Field>

      {params.mode === "text" ? (
        <FieldRow>
          <Field label={t("opt.wmText")}>
            <input
              className={sel}
              value={params.text ?? ""}
              onChange={(e) => set({ text: e.target.value })}
            />
          </Field>
          <Field label={t("opt.wmFontSize")}>
            <NumInput value={params.fontSize} min={8} max={400} onChange={(v) => set({ fontSize: v ?? 36 })} />
          </Field>
          <Field label={t("opt.wmColor")}>
            <input
              type="color"
              className={sel}
              value={params.color ?? "#ffffff"}
              onChange={(e) => set({ color: e.target.value })}
            />
          </Field>
        </FieldRow>
      ) : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={pick}
            className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition hover:border-brand-200 hover:bg-brand-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            {params.imagePath ? t("opt.changeFile") : t("opt.wmImagePick")}
          </button>
          {thumb && (
            <img
              src={thumb}
              alt=""
              className="h-9 w-9 rounded-lg object-contain ring-1 ring-neutral-200 dark:ring-neutral-700"
            />
          )}
        </div>
      )}

      <Field label={t("opt.wmPosition")}>
        <select
          className={sel}
          value={params.position}
          onChange={(e) => set({ position: e.target.value as ImageWatermarkParams["position"] })}
        >
          {POSITIONS.map((p) => (
            <option key={p} value={p}>
              {t(`opt.pos.${p}`)}
            </option>
          ))}
        </select>
      </Field>

      <FieldRow>
        <Field label={t("opt.wmScale")}>
          <NumInput value={params.scalePercent} min={1} max={100} onChange={(v) => set({ scalePercent: v ?? 25 })} />
        </Field>
        <Field label={t("opt.wmOpacity")}>
          <NumInput value={params.opacity} min={0} max={1} step={0.05} onChange={(v) => set({ opacity: v ?? 1 })} />
        </Field>
        <Field label={t("opt.wmMargin")}>
          <NumInput value={params.marginPercent} min={0} max={30} onChange={(v) => set({ marginPercent: v ?? 3 })} />
        </Field>
      </FieldRow>
    </div>
  );
}
