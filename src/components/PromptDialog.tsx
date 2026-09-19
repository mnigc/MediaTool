import { useCallback, useEffect, useState } from "react";
import { XIcon } from "./icons";
import { useI18n } from "../i18n";

interface PromptDialogProps {
  open: boolean;
  title: string;
  initialValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function usePrompt() {
  const { t } = useI18n();
  const [state, setState] = useState<{
    open: boolean;
    title: string;
    initialValue: string;
    placeholder: string;
    resolve: ((value: string | null) => void) | null;
  }>({ open: false, title: "", initialValue: "", placeholder: "", resolve: null });

  const prompt = useCallback(
    (opts: { title: string; initialValue?: string; placeholder?: string }) => {
      return new Promise<string | null>((resolve) => {
        setState({
          open: true,
          title: opts.title,
          initialValue: opts.initialValue ?? "",
          placeholder: opts.placeholder ?? "",
          resolve,
        });
      });
    },
    []
  );

  const handleSubmit = useCallback(
    (value: string) => {
      const v = value.trim();
      if (!v) return;
      state.resolve?.(v);
      setState((s) => ({ ...s, open: false, resolve: null }));
    },
    [state.resolve]
  );

  const handleCancel = useCallback(() => {
    state.resolve?.(null);
    setState((s) => ({ ...s, open: false, resolve: null }));
  }, [state.resolve]);

  return {
    prompt,
    dialog: (
      <PromptDialog
        open={state.open}
        title={state.title}
        initialValue={state.initialValue}
        placeholder={state.placeholder}
        confirmLabel={t("confirm.ok")}
        cancelLabel={t("confirm.cancel")}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
      />
    ),
  };
}

/** A Promise-based text input dialog. Used instead of `window.prompt`, which
 *  is unreliable in Tauri webviews (silently returns null on some platforms)
 *  and shows a non-native, unbrandable dialog elsewhere. */
export default function PromptDialog({
  open,
  title,
  initialValue = "",
  confirmLabel,
  cancelLabel,
  placeholder,
  onSubmit,
  onCancel,
}: PromptDialogProps) {
  const { t } = useI18n();
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  if (!open) return null;

  const invalid = value.trim().length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-title"
    >
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onCancel}
      />
      <div className="relative z-10 w-full max-w-sm min-w-0 rounded-2xl bg-white p-6 shadow-popover ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-700 animate-pop">
        <button
          onClick={onCancel}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-neutral-300 transition hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          aria-label={t("a11y.close")}
        >
          <XIcon className="h-4 w-4" />
        </button>
        <h3
          id="prompt-title"
          className="break-words text-base font-semibold text-neutral-900 dark:text-neutral-100"
        >
          {title}
        </h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(value);
          }}
        >
          <input
            autoFocus
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="mt-4 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm text-neutral-800 transition focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:border-brand-500"
          />
          {invalid && (
            <p className="mt-1.5 text-xs text-error-500">{t("pm.nameRequired")}</p>
          )}
          <div className="mt-6 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              {cancelLabel}
            </button>
            <button
              type="submit"
              disabled={invalid}
              className="rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 active:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
