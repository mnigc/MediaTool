import { useCallback, useState } from "react";
import { XIcon } from "./icons";
import { useI18n } from "../i18n";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function useConfirm() {
  const { t } = useI18n();
  const [state, setState] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    danger: boolean;
    resolve: ((confirmed: boolean) => void) | null;
  }>({
    open: false,
    title: "",
    message: "",
    confirmLabel: t("confirm.ok"),
    cancelLabel: t("confirm.cancel"),
    danger: false,
    resolve: null,
  });

  const confirm = useCallback(
    (opts: {
      title: string;
      message: string;
      confirmLabel?: string;
      cancelLabel?: string;
      danger?: boolean;
    }) => {
      return new Promise<boolean>((resolve) => {
        setState({
          open: true,
          title: opts.title,
          message: opts.message,
          confirmLabel: opts.confirmLabel ?? t("confirm.ok"),
          cancelLabel: opts.cancelLabel ?? t("confirm.cancel"),
          danger: opts.danger ?? false,
          resolve,
        });
      });
    },
    [t]
  );

  const handleConfirm = useCallback(() => {
    state.resolve?.(true);
    setState((s) => ({ ...s, open: false, resolve: null }));
  }, [state.resolve]);

  const handleCancel = useCallback(() => {
    state.resolve?.(false);
    setState((s) => ({ ...s, open: false, resolve: null }));
  }, [state.resolve]);

  return {
    confirm,
    dialog: (
      <ConfirmDialog
        open={state.open}
        title={state.title}
        message={state.message}
        confirmLabel={state.confirmLabel}
        cancelLabel={state.cancelLabel}
        danger={state.danger}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    ),
  };
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onCancel}
      />
      <div className="relative z-10 w-full max-w-sm rounded-2xl bg-white p-6 shadow-popover ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-700 animate-pop">
        <button
          onClick={onCancel}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-neutral-300 transition hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          aria-label="Close"
        >
          <XIcon className="h-4 w-4" />
        </button>
        <h3
          id="confirm-title"
          className="text-base font-semibold text-neutral-900 dark:text-neutral-100"
        >
          {title}
        </h3>
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          {message}
        </p>
        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-sm transition ${
              danger
                ? "bg-error-500 hover:bg-error-600 active:bg-error-700"
                : "bg-brand-500 hover:bg-brand-600 active:bg-brand-700"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}