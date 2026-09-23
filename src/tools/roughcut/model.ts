//! Pure timeline model for the rough-cut editor.
//!
//! The timeline is a flat, gapless list of clips — each clip is a window
//! [startTime, endTime] into a source file, and the exported video is simply
//! the clips concatenated in order. Trimming an edge therefore shortens that
//! clip and pulls everything after it left; there is no separate "track
//! position" to keep in sync. All functions here are pure so the workbench
//! drives them through a small reducer with undo/redo.

import type { RoughCutClip } from "../../types";

/** Everything the editor knows about one source file. */
export interface SourceInfo {
  path: string;
  durationSecs: number;
  mediaType: string;
}

/** Shortest slice the editor accepts, in source seconds. */
export const MIN_SLICE = 0.05;

/** Speed as the backend clamps it (0.25..=4), so the timeline's lengths match
 *  what the export will actually be. */
export function speedOf(clip: RoughCutClip): number {
  return Math.min(Math.max(clip.speed ?? 1, 0.25), 4);
}

/** Where the clip's window ends inside its source (source seconds). */
export function sourceEnd(clip: RoughCutClip, sources: Map<string, SourceInfo>): number {
  return clip.endTime ?? sources.get(clip.path)?.durationSecs ?? 0;
}

/** 1:23.4 style time labels for the ruler and transport. */
export function formatTime(secs: number): string {
  const s = Math.max(0, secs);
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const tenth = Math.floor((s * 10) % 10);
  const core =
    h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${core}.${tenth}`;
}

/** Timeline length of one clip: its source window at that clip's speed. */
export function clipDuration(clip: RoughCutClip, sources: Map<string, SourceInfo>): number {
  return Math.max(0, (sourceEnd(clip, sources) - clip.startTime) / speedOf(clip));
}

export function totalDuration(clips: RoughCutClip[], sources: Map<string, SourceInfo>): number {
  return clips.reduce((sum, c) => sum + clipDuration(c, sources), 0);
}

/** Timeline start of the clip at `index` (seconds). */
export function globalStartOf(
  clips: RoughCutClip[],
  sources: Map<string, SourceInfo>,
  index: number
): number {
  let t = 0;
  for (let i = 0; i < index && i < clips.length; i++) t += clipDuration(clips[i], sources);
  return t;
}

/** Which clip is under a global timeline position, and where inside it. */
export function locate(
  clips: RoughCutClip[],
  sources: Map<string, SourceInfo>,
  secs: number
): { index: number; local: number } | null {
  if (clips.length === 0) return null;
  let t = 0;
  for (let i = 0; i < clips.length; i++) {
    const d = clipDuration(clips[i], sources);
    if (secs < t + d || i === clips.length - 1) {
      return { index: i, local: Math.min(Math.max(0, secs - t), Math.max(0, d - 0.001)) };
    }
    t += d;
  }
  return null;
}

/** Split the clip under `secs` into two at that point. Null when the cut
 *  would leave a sliver (too close to either edge). */
export function splitAt(
  clips: RoughCutClip[],
  sources: Map<string, SourceInfo>,
  secs: number
): RoughCutClip[] | null {
  const at = locate(clips, sources, secs);
  if (!at) return null;
  const clip = clips[at.index];
  const end = sourceEnd(clip, sources);
  // The playhead reads in timeline seconds; the cut is a position in the
  // source, which a sped-up clip covers faster.
  const cut = clip.startTime + at.local * speedOf(clip);
  if (cut - clip.startTime < MIN_SLICE || end - cut < MIN_SLICE) return null;
  const left: RoughCutClip = { ...clip, endTime: cut };
  const right: RoughCutClip = { ...clip, startTime: cut, endTime: end };
  const next = [...clips];
  next.splice(at.index, 1, left, right);
  return next;
}

/** Drag one clip's in/out edge to a source second (callers convert from
 *  timeline seconds). The edge is clamped into the source's bounds and never
 *  crosses the opposite edge. An unprobed source — deleted, or still being
 *  measured — has no bounds to clamp against, so the value passes through. */
export function trimEdge(
  clips: RoughCutClip[],
  sources: Map<string, SourceInfo>,
  index: number,
  edge: "in" | "out",
  secs: number
): RoughCutClip[] {
  const clip = clips[index];
  if (!clip) return clips;
  const srcDur = sources.get(clip.path)?.durationSecs ?? 0;
  const end = sourceEnd(clip, sources);
  const next = [...clips];
  if (edge === "in") {
    const limit = end > 0 ? end - MIN_SLICE : secs;
    next[index] = { ...clip, startTime: Math.min(Math.max(secs, 0), Math.max(0, limit)) };
  } else {
    const newEnd = Math.min(Math.max(secs, clip.startTime + MIN_SLICE), srcDur || secs);
    next[index] = { ...clip, endTime: newEnd };
  }
  return next;
}

export function removeClip(clips: RoughCutClip[], index: number): RoughCutClip[] {
  return clips.filter((_, i) => i !== index);
}

/** Move a clip to a new index (the inspector's ◀ ▶ buttons). */
export function moveClip(clips: RoughCutClip[], from: number, to: number): RoughCutClip[] {
  if (from === to || from < 0 || to < 0 || from >= clips.length || to >= clips.length) return clips;
  const next = [...clips];
  const [clip] = next.splice(from, 1);
  next.splice(to, 0, clip);
  return next;
}

/** Whole-file clip for a freshly added source. */
export function clipForSource(info: SourceInfo): RoughCutClip {
  return { path: info.path, startTime: 0, endTime: info.durationSecs };
}

/* ── Reducer with undo/redo ─────────────────────────────────────── */

export interface TimelineState {
  clips: RoughCutClip[];
  past: RoughCutClip[][];
  future: RoughCutClip[][];
  /** Gesture the last commit belonged to; see `TimelineAction.tag`. */
  tag: string | null;
}

export type TimelineAction =
  /** Replace the timeline with history pushed (all edits). `tag` marks a
   *  continuous gesture — consecutive commits sharing one (a trim drag, a
   *  volume slider sweep fire per pointer event) fold into the single undo
   *  step the gesture deserves instead of flooding the stack. */
  | { type: "commit"; clips: RoughCutClip[]; tag?: string }
  /** Replace without touching history (project restore, clear-all). */
  | { type: "reset"; clips: RoughCutClip[] }
  | { type: "undo" }
  | { type: "redo" };

const HISTORY_CAP = 50;

export function timelineReducer(state: TimelineState, action: TimelineAction): TimelineState {
  switch (action.type) {
    case "commit": {
      if (action.clips === state.clips) return state;
      if (action.tag && action.tag === state.tag) return { ...state, clips: action.clips };
      const past = [...state.past, state.clips];
      if (past.length > HISTORY_CAP) past.shift();
      return { clips: action.clips, past, future: [], tag: action.tag ?? null };
    }
    case "reset":
      return { clips: action.clips, past: [], future: [], tag: null };
    case "undo": {
      if (state.past.length === 0) return state;
      const past = [...state.past];
      const clips = past.pop()!;
      return {
        clips,
        past,
        future: [state.clips, ...state.future].slice(0, HISTORY_CAP),
        tag: null,
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const [clips, ...future] = state.future;
      return { clips, past: [...state.past, state.clips], future, tag: null };
    }
  }
}
