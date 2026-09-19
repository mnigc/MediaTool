import type { ReactNode } from "react";
import { useI18n } from "../../i18n";

export const sel =
  "w-full select-text rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-700 transition focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:focus:border-brand-500";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-xs font-medium text-neutral-600 dark:text-neutral-300">
        {label}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

/** Inline hint shown when a tool's required file has not been picked yet. */
export function RequiredHint({ missing }: { missing: boolean }) {
  const { t } = useI18n();
  if (!missing) return null;
  return (
    <p className="text-[11px] font-medium text-error-500" role="alert">
      {t("opt.requiredMissing")}
    </p>
  );
}

export function NumInput({
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}) {
  const handleChange = (raw: string) => {
    if (raw === "") {
      onChange(undefined);
      return;
    }
    let v = Number(raw);
    if (!Number.isFinite(v)) {
      onChange(undefined);
      return;
    }
    // Integer fields (step >= 1): reject decimals like 100.5 — the backend
    // deserializes them as u32 and the whole start_job call would fail.
    if ((step ?? 1) >= 1) v = Math.round(v);
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    onChange(v);
  };

  return (
    <input
      type="number"
      className={sel}
      min={min}
      max={max}
      step={step ?? 1}
      placeholder={placeholder}
      value={value ?? ""}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => handleChange(e.target.value)}
    />
  );
}

export function Checkbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="h-3.5 w-3.5 cursor-pointer rounded border-neutral-300 accent-brand-600 dark:border-neutral-600"
    />
  );
}
