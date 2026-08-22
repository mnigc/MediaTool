import { useI18n } from "../i18n";

interface EmptyStateProps {
  message?: string;
}

export default function EmptyState({
  message,
}: EmptyStateProps) {
  const { t } = useI18n();
  const text = message ?? t("empty.message");
  return (
    <div className="mt-16 flex flex-col items-center justify-center text-center">
      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-brand-50 dark:bg-brand-950/40">
        <svg viewBox="0 0 48 48" fill="none" className="h-10 w-10" aria-hidden>
          <rect x="6" y="10" width="24" height="28" rx="4" stroke="#4F6BBD" strokeWidth="2" />
          <rect x="18" y="16" width="24" height="28" rx="4" stroke="#8FA2EE" strokeWidth="2" />
          <path d="M24 22v20" stroke="#4F6BBD" strokeWidth="2" strokeLinecap="round" />
          <path d="M28 28l4 4 4-4" stroke="#8FA2EE" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      </div>
      <p className="max-w-xs text-sm text-neutral-500 dark:text-neutral-400">{text}</p>
    </div>
  );
}
