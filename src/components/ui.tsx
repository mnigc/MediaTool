import type { ButtonHTMLAttributes, ReactNode } from "react";

/* Shared form primitives so every button/input/label in the app renders the
   same way. Disabled primaries go grey (not washed-out brand) so "can I
   click this?" is never ambiguous. */

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-brand-500 text-white shadow-sm hover:bg-brand-600 dark:bg-brand-600 dark:hover:bg-brand-700",
  secondary:
    "border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700",
  ghost:
    "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100",
  danger:
    "border border-error-200 bg-error-50 text-error-600 hover:bg-error-100 dark:border-error-800 dark:bg-error-950/30 dark:text-error-400 dark:hover:bg-error-900/50",
};

const DISABLED =
  "cursor-not-allowed border border-transparent bg-neutral-100 text-neutral-400 shadow-none hover:bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-500 dark:hover:bg-neutral-800";

const SIZES: Record<Size, string> = {
  sm: "rounded-lg px-2.5 py-1 text-xs",
  md: "rounded-xl px-4 py-2 text-sm",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  disabled,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
}) {
  return (
    <button
      disabled={disabled}
      className={`shrink-0 font-medium transition ${SIZES[size]} ${
        disabled ? DISABLED : VARIANTS[variant]
      } ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export const inputCls =
  "min-w-0 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm text-neutral-800 placeholder:text-neutral-400 transition focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:border-brand-500";

export const inputClsSm = `${inputCls} py-1 text-xs`;

/** Section / field label. Deliberately NOT uppercase+tracking (that English
 *  typographic convention does nothing for CJK and only shrinks contrast). */
export function FieldLabel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`text-xs font-semibold text-neutral-600 dark:text-neutral-300 ${className}`}
    >
      {children}
    </span>
  );
}
