import { useI18n } from "../i18n";
import { useUploads } from "../contexts/UploadCenter";

/** Multi-select chips of upload targets, shared by every "run when finished"
 *  entry (download/record sidebar, tool workbench, workflow builder). An
 *  empty selection means "don't upload" — whether to upload and where is
 *  decided here, not by a global setting. */
export default function UploadTargetChips({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  const { targets } = useUploads();

  if (targets.length === 0) {
    return (
      <p className="text-xs text-neutral-400 dark:text-neutral-500">
        {t("upload.pick.empty")}
      </p>
    );
  }

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {targets.map((x) => {
        const active = selected.includes(x.id);
        return (
          <button
            key={x.id}
            type="button"
            title={x.name}
            onClick={() => toggle(x.id)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
              active
                ? "bg-brand-500 text-white dark:bg-brand-600"
                : "border border-neutral-200 bg-white text-neutral-600 hover:border-brand-200 hover:text-brand-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:text-brand-400"
            }`}
          >
            {x.name}
          </button>
        );
      })}
    </div>
  );
}
