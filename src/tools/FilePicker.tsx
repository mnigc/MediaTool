import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getThumbnail } from "../lib/tauri";
import { useI18n } from "../i18n";
import type { ToolMeta } from "./registry";

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1);
}

export function extOk(path: string, accepts: string[]): boolean {
  const norm = path.replace(/\\/g, "/").toLowerCase();
  const dot = norm.lastIndexOf(".");
  if (dot < 0) return false;
  return accepts.includes(norm.slice(dot + 1));
}

interface Props {
  meta: ToolMeta;
  files: string[];
  onChange: (files: string[]) => void;
}

/** File selection area for toolbox tools: click to browse; window-level
 * drag-drops are routed here by the workbench via TaskCenter. */
export default function FilePicker({ meta, files, onChange }: Props) {
  const { t } = useI18n();
  const [thumb, setThumb] = useState<string | null>(null);

  const previewPath = files[0];

  useEffect(() => {
    let cancelled = false;
    setThumb(null);
    if (previewPath && extOk(previewPath, ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"])) {
      getThumbnail(previewPath, "image")
        .then((t) => !cancelled && setThumb(t))
        .catch(() => {});
    } else if (previewPath) {
      getThumbnail(previewPath, "video")
        .then((t) => !cancelled && setThumb(t))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [previewPath]);

  const browse = async () => {
    const filterName = meta.mediaType ? t(`dz.filter.${meta.mediaType}`) : t("dz.filter.any");
    const sel = await open({
      multiple: true,
      title: t("opt.selectFiles"),
      filters: [{ name: filterName, extensions: meta.accepts }],
    });
    const arr = Array.isArray(sel) ? sel : sel ? [sel] : [];
    const valid = arr.filter((p) => extOk(p, meta.accepts));
    if (valid.length > 0 || arr.length === 0) {
      add(valid);
    }
  };

  const add = (paths: string[]) => {
    if (!meta.multiFile) {
      onChange(paths.slice(0, 1));
      return;
    }
    onChange([...files, ...paths.filter((p) => !files.includes(p))]);
  };

  const formatHint = meta.mediaType
    ? t("dz.formatHint", { exts: meta.accepts.map((e) => `.${e}`).join(", ") })
    : t("dz.formatHintAny");

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={browse}
        className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand-300 bg-brand-50/50 px-3 py-4 text-sm font-medium text-brand-700 transition hover:border-brand-400 hover:bg-brand-100 dark:border-brand-700 dark:bg-brand-950/30 dark:text-brand-300 dark:hover:border-brand-500 dark:hover:bg-brand-900/50"
      >
        + {t("tool.pickFile")}
      </button>
      <p className="text-center text-xs text-neutral-400 dark:text-neutral-500">
        {formatHint}
      </p>

      {files.map((f) => (
        <div
          key={f}
          className="flex items-center gap-3 rounded-xl bg-neutral-50 p-2 ring-1 ring-neutral-200 dark:bg-neutral-800/60 dark:ring-neutral-700"
        >
          {thumb && f === previewPath ? (
            <img src={thumb} alt="" className="h-9 w-9 rounded-lg object-cover" />
          ) : (
            <div className="h-9 w-9 rounded-lg bg-neutral-200 dark:bg-neutral-700" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-neutral-700 dark:text-neutral-200" title={f}>
            {basename(f)}
          </span>
          <button
            type="button"
            onClick={() => onChange(files.filter((x) => x !== f))}
            className="shrink-0 rounded-lg px-2 py-1 text-xs text-neutral-400 transition hover:text-error-500"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
