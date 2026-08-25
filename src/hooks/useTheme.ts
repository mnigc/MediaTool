import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
