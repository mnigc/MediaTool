import {
  Children,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  isValidElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDownIcon } from "./icons";

interface Option {
  value: string;
  label: ReactNode;
  disabled: boolean;
}

/** Extract flat options from `<option>` children so call sites keep the same
 *  markup as native selects. Values are normalized to strings — numeric
 *  `value={2}` shorthand would otherwise never strictly equal the string
 *  `value` prop and the trigger would always show the first option. */
function collectOptions(children: ReactNode): Option[] {
  const out: Option[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const props = child.props as {
      value?: string | number;
      disabled?: boolean;
      children?: ReactNode;
    };
    out.push({
      value: String(props.value ?? ""),
      label: props.children,
      disabled: props.disabled === true,
    });
  });
  return out;
}

const TRIGGER_BASE =
  "flex w-full items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-700 transition focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:focus:border-brand-500";

/** Styled replacement for native <select>: a button + floating listbox that
 *  matches the app's design system. Accepts the same <option> children and a
 *  simple `onChange(value)` callback. Width is controlled via `className` on
 *  the root (w-full / w-36 / flex-1 …), auto-sizing to content otherwise. */
export default function Select({
  value,
  onChange,
  children,
  className = "",
  triggerClassName = "",
  disabled = false,
  title,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  className?: string;
  /** Extra classes for the trigger button (e.g. header sizing). */
  triggerClassName?: string;
  disabled?: boolean;
  title?: string;
}) {
  const options = collectOptions(children);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** Viewport coordinates for the portaled listbox; recomputed while open. */
  const [pos, setPos] = useState<{
    top: number;
    left?: number;
    right?: number;
    minWidth: number;
    flipUp: boolean;
  } | null>(null);

  const selectedIdx = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );
  const selected = options[selectedIdx];

  const openMenu = () => {
    setHighlighted(selectedIdx);
    setOpen(true);
  };

  const select = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  // Close on outside click. The listbox lives in a body portal, so it is
  // checked separately from the trigger subtree.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Position the portaled listbox against the trigger; flip above / align
  // right when the menu would leave the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const estH = Math.min(240, options.length * 29 + 10);
      const flipUp =
        r.bottom + estH + 8 > window.innerHeight &&
        r.top > window.innerHeight - r.bottom;
      const overflowsRight = r.left + 320 > window.innerWidth;
      setPos({
        top: flipUp ? r.top - 4 : r.bottom + 4,
        ...(overflowsRight
          ? { right: Math.max(8, window.innerWidth - r.right), left: undefined }
          : { left: Math.max(8, r.left), right: undefined }),
        minWidth: r.width,
        flipUp,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, options.length]);

  // Keep the highlighted option visible while keyboard-navigating.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelectorAll("li")
      [highlighted]?.scrollIntoView({ block: "nearest" });
  }, [open, highlighted]);

  const commitHighlighted = () => {
    const opt = options[highlighted];
    if (opt && !opt.disabled) select(opt.value);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlighted((i) => {
          let n = i;
          do {
            n = Math.min(n + 1, options.length - 1);
          } while (options[n]?.disabled && n < options.length - 1);
          return n;
        });
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlighted((i) => {
          let n = i;
          do {
            n = Math.max(n - 1, 0);
          } while (options[n]?.disabled && n > 0);
          return n;
        });
        break;
      case "Home":
        e.preventDefault();
        setHighlighted(0);
        break;
      case "End":
        e.preventDefault();
        setHighlighted(options.length - 1);
        break;
      case "Enter":
        e.preventDefault();
        commitHighlighted();
        break;
      case "Escape":
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <div
      ref={rootRef}
      className={`relative inline-flex max-w-full ${className}`}
      onKeyDown={onKeyDown}
      title={title}
    >
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => {
          // A click on any non-interactive descendant of a wrapping <label>
          // (the option list counts) is re-dispatched to this button with
          // detail=0 after the real click already closed the menu — ignoring
          // it stops the menu from popping back open. Keyboard activation is
          // handled in onKeyDown instead, so nothing is lost.
          if (e.detail === 0) return;
          if (open) setOpen(false);
          else openMenu();
        }}
        className={`${TRIGGER_BASE} ${triggerClassName} ${
          open ? "border-brand-400 ring-1 ring-brand-100 dark:border-brand-500" : ""
        }`}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {selected?.label ?? value}
        </span>
        <ChevronDownIcon
          className={`h-3 w-3 shrink-0 text-neutral-400 transition-transform dark:text-neutral-500 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <ul
            ref={listRef}
            role="listbox"
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              right: pos.right,
              minWidth: pos.minWidth,
              transform: pos.flipUp ? "translateY(-100%)" : undefined,
            }}
            className="z-50 max-h-60 w-max max-w-80 overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg scrollbar-thin dark:border-neutral-700 dark:bg-neutral-800"
          >
          {options.map((o, i) => {
            const isSelected = o.value === value;
            const isHl = i === highlighted;
            return (
              <li
                key={o.value || i}
                role="option"
                aria-selected={isSelected}
                // Prevent blur/outside-mousedown weirdness between button and item.
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.preventDefault();
                  if (!o.disabled) select(o.value);
                }}
                onMouseEnter={() => setHighlighted(i)}
                className={`mx-1 flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs ${
                  isSelected
                    ? "font-medium text-brand-600 dark:text-brand-300"
                    : "text-neutral-700 dark:text-neutral-200"
                } ${
                  o.disabled
                    ? "cursor-not-allowed opacity-40"
                    : isHl
                      ? "bg-brand-50 dark:bg-neutral-700/60"
                      : ""
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {isSelected && (
                  <CheckIcon className="h-3 w-3 shrink-0 text-brand-500 dark:text-brand-300" />
                )}
              </li>
            );
          })}
          </ul>,
          document.body
        )}
    </div>
  );
}
