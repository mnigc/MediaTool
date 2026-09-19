import { useEffect, useState } from "react";
import { onSystemThemeChange } from "../lib/shell";
import { readStorage, writeStorage } from "../lib/storage";

export type ThemeMode = "light" | "dark" | "auto";

const STORAGE_KEY = "mediatool.theme";

function loadThemeMode(): ThemeMode {
  const v = readStorage(STORAGE_KEY);
  if (v === "light" || v === "dark" || v === "auto") return v;
  return "auto";
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

function effectiveDark(mode: ThemeMode, sys: boolean): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return sys;
}

export function useTheme() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadThemeMode);
  const [dark, setDark] = useState<boolean>(() =>
    effectiveDark(themeMode, systemPrefersDark())
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    writeStorage(STORAGE_KEY, themeMode);

    setDark(effectiveDark(themeMode, systemPrefersDark()));

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onSystemThemeChange((sysDark) => {
      setDark(effectiveDark(themeMode, sysDark));
    }).then((fn) => {
      if (cancelled) {
        // The effect already cleaned up before the promise resolved —
        // unregister immediately instead of leaking the listener (which
        // would keep firing with a stale themeMode closure).
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [themeMode]);

  return { themeMode, setThemeMode, dark };
}
