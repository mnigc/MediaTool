import type { ReactNode } from "react";

export const sel =
  "w-full select-text rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-700 transition focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:focus:border-brand-500";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {label}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
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
      onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
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
