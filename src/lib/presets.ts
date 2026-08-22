import type { JobParams, MediaType } from "../types";

export interface Preset {
  name: string;
  mediaType: MediaType;
  params: JobParams;
}

const KEY = "mediapress.presets";

export function loadPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Preset[]) : [];
  } catch {
    return [];
  }
}

export function savePresets(presets: Preset[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(presets));
  } catch {
    // ignore quota / serialization errors
  }
}

export function addPreset(preset: Preset): Preset[] {
  const all = loadPresets().filter(
    (p) => !(p.mediaType === preset.mediaType && p.name === preset.name)
  );
  all.push(preset);
  savePresets(all);
  return all;
}

export function removePreset(mediaType: MediaType, name: string): Preset[] {
  const all = loadPresets().filter(
    (p) => !(p.mediaType === mediaType && p.name === name)
  );
  savePresets(all);
  return all;
}
