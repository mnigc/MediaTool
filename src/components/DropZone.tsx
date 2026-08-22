import { UploadIcon } from "./icons";
import { useI18n } from "../i18n";

interface DropZoneProps {
  dragOver: boolean;
  compact?: boolean;
  jobCount?: number;
  onClick: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}

export default function DropZone({
  dragOver,
  compact = false,
  jobCount = 0,
  onClick,
  onDragOver,
  onDragLeave,
  onDrop,
}: DropZoneProps) {
  const { t } = useI18n();
  if (compact) {
    return (
      <button
        onClick={onClick}
        className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand-300 bg-brand-50/50 px-3 py-3 text-sm font-medium text-brand-700 transition hover:border-brand-400 hover:bg-brand-100 dark:border-brand-700 dark:bg-brand-950/30 dark:text-brand-300 dark:hover:border-brand-500 dark:hover:bg-brand-900/50"
        aria-label={t("dz.aria", { n: jobCount })}
      >
        <UploadIcon className="h-4 w-4" />
        <span>+ {t("dz.addMany", { n: jobCount })}</span>
      </button>
    );
  }

  return (
    <div
      onClick={onClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`relative flex cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed px-6 py-20 text-center transition-all duration-200 ${
        dragOver
          ? "border-brand-400 bg-brand-50/60 dark:border-brand-500/70 dark:bg-brand-950/40"
          : "border-neutral-300/60 bg-white/40 hover:border-brand-300/80 hover:bg-brand-50/30 dark:border-neutral-600/60 dark:bg-neutral-800/40 dark:hover:border-brand-600/60 dark:hover:bg-brand-950/20"
      }`}
    >
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl brand-gradient shadow-md shadow-brand-200/40 dark:shadow-brand-900/20">
        <UploadIcon className="h-8 w-8 text-white" />
      </div>
      <p className="text-lg font-medium text-neutral-800 dark:text-neutral-100">
        {t("dz.click")}
      </p>
      <p className="mt-1.5 text-sm text-neutral-400 dark:text-neutral-500">
        {t("dz.support")}
      </p>
    </div>
  );
}
