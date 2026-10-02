//! The playhead as a tiny external store.
//!
//! Playback advances the playhead once per animation frame. Held in React
//! state that re-rendered the whole workbench shell (sidebar, source bin,
//! transport bar, timeline card) at 60fps for a value only two widgets paint.
//! This is the standard three-piece `useSyncExternalStore` contract —
//! subscribe / getSnapshot / hook — so the only render-time subscribers are
//! the timeline's playhead line and the transport timecode. Logic that needs
//! the current value (split, delete, seeks, the player's video sync) reads it
//! synchronously through `getPlayhead`, which also removes any stale-closure
//! risk around drags and the attach-once keyboard handler.

import { useSyncExternalStore } from "react";

let current = 0;
const listeners = new Set<() => void>();

/** Current playhead position in timeline seconds. Safe to call outside React —
 *  event handlers, rAF ticks, effects — that is the point. */
export function getPlayhead(): number {
  return current;
}

/** Write the playhead. A write of the value already stored is dropped, so a
 *  redundant seek or a paused player notifies nobody. */
export function setPlayhead(secs: number): void {
  if (Object.is(secs, current)) return;
  current = secs;
  listeners.forEach((l) => l());
}

export function subscribePlayhead(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Render-time subscription to the raw seconds. Only widgets that actually
 *  repaint the position (the timeline indicator, the transport timecode) may
 *  call this — every subscriber re-renders on every frame of playback. For
 *  coarser facts (which clip, which file) subscribe through a derived
 *  selector instead: `useSyncExternalStore(subscribePlayhead, () => ...)`. */
export function usePlayhead(): number {
  return useSyncExternalStore(subscribePlayhead, getPlayhead);
}
