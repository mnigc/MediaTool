import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { readStorage, writeStorage } from "../lib/storage";
import {
  LOCALES,
  translations,
  tKey,
  type Locale,
  type TranslationKey,
} from "./translations";

export { tKey };
export type { TranslationKey };

const STORAGE_KEY = "mediatool.lang";

function detectLocale(): Locale {
  const saved = readStorage(STORAGE_KEY);
  if (saved && (LOCALES as string[]).includes(saved)) return saved as Locale;
  const nav = (
    typeof navigator !== "undefined" ? navigator.language : ""
  ).toLowerCase();
  if (nav.startsWith("zh")) return "zh";
  if (nav.startsWith("en")) return "en";
  return "en";
}

type Vars = Record<string, string | number>;

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  /** Key is compile-checked against the zh table (`TranslationKey`); keys
   *  assembled at runtime go through `tKey` and arrive here pre-cast. */
  t: (key: TranslationKey, vars?: Vars) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function translate(locale: Locale, key: string, vars?: Vars): string {
  const dict = translations[locale] ?? translations.zh;
  let str = dict[key] ?? translations.zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      // split/join instead of replace(new RegExp, v): the replacement value
      // may contain `$&`-style sequences that replace() would interpolate
      // into the output, and building a RegExp per call is wasteful on this
      // hot path (t runs on every render of translated text).
      str = str.split(`{${k}}`).join(String(v));
    }
  }
  return str;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale());

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    writeStorage(STORAGE_KEY, l);
    setLocaleState(l);
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Vars) => translate(locale, key, vars),
    [locale]
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
