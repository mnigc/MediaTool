//! Rough-cut project persistence — the same external-store pattern the
//! workflow pipelines use: one localStorage key, JSON payloads shape-checked
//! on read, and a `useSyncExternalStore` hook for the named-project list.
//!
//! The timeline being edited autosaves to its own key on every change; named
//! projects exist so a cut can be set aside and reopened later. Clips hold
//! absolute source paths, so a project is only meaningful on the machine that
//! made it — in-app storage (not files on disk) matches that lifetime.

import { useSyncExternalStore } from "react";
import type { RoughCutClip } from "../../types";

export interface RoughCutProject {
  id: string;
  name: string;
  clips: RoughCutClip[];
  savedAt: number;
}

const CURRENT_KEY = "mediatool.roughcut.current";
const PROJECTS_KEY = "mediatool.roughcut.projects";

/* ── current (autosaved) timeline ──────────────────────────────── */

function isClipArray(v: unknown): v is RoughCutClip[] {
  return (
    Array.isArray(v) &&
    v.every(
      (c) =>
        !!c &&
        typeof c === "object" &&
        typeof (c as RoughCutClip).path === "string" &&
        typeof (c as RoughCutClip).startTime === "number"
    )
  );
}

export function loadCurrent(): RoughCutClip[] | null {
  try {
    const raw = localStorage.getItem(CURRENT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isClipArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function saveCurrent(clips: RoughCutClip[]): void {
  try {
    localStorage.setItem(CURRENT_KEY, JSON.stringify(clips));
  } catch {
    // quota errors: the timeline survives in memory only
  }
}

export function clearCurrent(): void {
  try {
    localStorage.removeItem(CURRENT_KEY);
  } catch {
    // ignore
  }
}

/* ── source bin ────────────────────────────────────────────────── */

const BIN_KEY = "mediatool.roughcut.bin";

/** Staged source paths. A source with no clip on the timeline yet appears in
 *  nothing else, so the bin needs its own key to survive a restart. */
export function loadBin(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(BIN_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveBin(paths: string[]): void {
  try {
    localStorage.setItem(BIN_KEY, JSON.stringify(paths));
  } catch {
    // quota errors: the bin survives in memory only
  }
}

/* ── named projects ────────────────────────────────────────────── */

let cache: RoughCutProject[] | null = null;
const listeners = new Set<() => void>();

function loadProjects(): RoughCutProject[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = (Array.isArray(parsed) ? parsed.filter((p) => isProject(p)) : []).sort(
      (a, b) => b.savedAt - a.savedAt
    );
  } catch {
    cache = [];
  }
  return cache;
}

function isProject(p: unknown): p is RoughCutProject {
  return (
    !!p &&
    typeof p === "object" &&
    typeof (p as RoughCutProject).id === "string" &&
    typeof (p as RoughCutProject).name === "string" &&
    isClipArray((p as RoughCutProject).clips)
  );
}

function write(projects: RoughCutProject[]) {
  cache = projects.sort((a, b) => b.savedAt - a.savedAt);
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(cache));
  } catch {
    // ignore quota errors
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const EMPTY: RoughCutProject[] = [];

/** Live list of saved projects, newest first. The snapshot must be a stable
 *  reference between writes — sorting happens once, in `write` / load. */
export function useRoughCutProjects(): RoughCutProject[] {
  return useSyncExternalStore(subscribe, loadProjects, () => EMPTY);
}

export function saveProject(name: string, clips: RoughCutClip[]): RoughCutProject {
  const projects = loadProjects();
  const existing = projects.find((p) => p.name === name);
  const project: RoughCutProject = {
    id: existing?.id ?? `rc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    clips,
    savedAt: Date.now(),
  };
  write([...projects.filter((p) => p.id !== project.id), project]);
  return project;
}

export function removeProject(id: string): void {
  write(loadProjects().filter((p) => p.id !== id));
}
