import type { ToastItem } from "../hooks/useToasts";
import { XIcon } from "./icons";

interface ToastContainerProps {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}

export default function ToastContainer({
  toasts,
  onDismiss,
}: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-3 rounded-xl px-4 py-3 text-sm shadow-lg slide-up ring-1 ${
            t.type === "success"
              ? "bg-success-500 text-white ring-success-600"
              : t.type === "error"
                ? "bg-error-50 border border-error-100 text-error-700 ring-error-100 dark:border-error-900/50 dark:bg-error-950/60 dark:text-error-400"
                : "bg-brand-600 text-white ring-brand-700"
          }`}
        >
          <span className="flex-1">{t.msg}</span>
          <button
            onClick={() => onDismiss(t.id)}
            className="shrink-0 opacity-60 transition hover:opacity-100"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
