/** localStorage helpers that transparently migrate values stored under the
 *  pre-rename `mediapress.*` key prefix into the current `mediatool.*` prefix,
 *  so existing presets / jobs / settings / theme / language survive the rename. */
const OLD_PREFIX = "mediapress.";
const NEW_PREFIX = "mediatool.";

/** Read a value by its full storage key. If the key is empty but a value exists
 *  under the legacy `mediapress.*` counterpart, it is copied over (and the old
 *  key removed) before returning, i.e. a one-shot migration on first read. */
export function readStorage(key: string): string | null {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return v;
    if (!key.startsWith(NEW_PREFIX)) return null;
    const legacy = OLD_PREFIX + key.slice(NEW_PREFIX.length);
    const ov = localStorage.getItem(legacy);
    if (ov !== null) {
      localStorage.setItem(key, ov);
      localStorage.removeItem(legacy);
      return ov;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist a value to its storage key (writes to the current prefix only). */
export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore quota / private-mode failures
  }
}
