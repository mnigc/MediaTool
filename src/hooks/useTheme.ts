import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemeMode = "light" | "dark" | "auto";

const STORAGE_KEY = "mediapress.theme";

function loadThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "auto") return v;
  } catch {
    /* ignore */
  }
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
    try {
      localStorage.setItem(STORAGE_KEY, themeMode);
    } catch {
      /* ignore */
    }

    setDark(effectiveDark(themeMode, systemPrefersDark()));

    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onMediaChange = (e: MediaQueryListEvent) => {
      setDark(effectiveDark(themeMode, e.matches));
    };
    mql.addEventListener("change", onMediaChange);

    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onThemeChanged((e) => {
        setDark(effectiveDark(themeMode, e.payload === "dark"));
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      mql.removeEventListener("change", onMediaChange);
      unlisten?.();
    };
  }, [themeMode]);

  return { themeMode, setThemeMode, dark };
}
