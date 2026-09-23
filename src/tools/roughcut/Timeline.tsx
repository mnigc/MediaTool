//! The rough-cut timeline: ruler, filmstrip-backed clip blocks, playhead.
//!
//! Interactions — press a clip to select it (release moves the playhead), press
//! and drag on the ruler / empty lane to scrub, drag a clip's side handles to
//! trim its in/out point. Clip order changes through the inspector's buttons,
//! not dragging: `dragDropEnabled` must stay on for OS file drops, which kills
//! HTML5 drag and drop in the desktop build. The horizontal drag math is all
//! "pixels / pxPerSec → seconds".

import { useEffect, useRef, useState } from "react";
import { getFilmstrip } from "../../lib/engine";
import type { RoughCutClip } from "../../types";
import {
  clipDuration,
  formatTime,
  globalStartOf,
  sourceEnd,
  speedOf,
  totalDuration,
  type SourceInfo,
} from "./model";

/** One fetch per source, shared by every clip cut from it. */
const stripCache = new Map<string, string[]>();

function Filmstrip({
  path,
  sourceDur,
  startTime,
  speed,
  pxPerSec,
}: {
  path: string;
  sourceDur: number;
  startTime: number;
  speed: number;
  pxPerSec: number;
}) {
  const [frames, setFrames] = useState<string[] | null>(() => stripCache.get(path) ?? null);
  useEffect(() => {
    if (stripCache.has(path)) return;
    let alive = true;
    getFilmstrip(path, 10, 128, sourceDur > 0 ? sourceDur : null)
      .then((urls) => {
        if (urls.length === 0) return;
        stripCache.set(path, urls);
        if (alive) setFrames(urls);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path, sourceDur]);

  if (!frames || frames.length === 0 || sourceDur <= 0) return null;
  // Frames are evenly spaced across the source, so one occupies
  // (sourceDur / frames) source seconds — a sped-up clip burns through that in
  // proportionally less timeline time.
  const slotW = Math.max((sourceDur / frames.length / speed) * pxPerSec, 24);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-y-0 left-0 flex opacity-80"
        style={{ transform: `translateX(${(-startTime * pxPerSec) / speed}px)` }}
      >
        {frames.map((f, i) => (
          <img
            key={i}
            src={f}
            alt=""
            draggable={false}
            className="h-full shrink-0 object-cover"
            style={{ width: slotW }}
          />
        ))}
      </div>
    </div>
  );
}

const RULER_STEPS = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

export default function Timeline({
  clips,
  sources,
  playhead,
  pxPerSec,
  selected,
  onSeek,
  onSelect,
  onTrim,
}: {
  clips: RoughCutClip[];
  sources: Map<string, SourceInfo>;
  playhead: number;
  pxPerSec: number;
  selected: number | null;
  onSeek: (secs: number) => void;
  onSelect: (index: number | null) => void;
  /** Drag an edge to this many seconds *within the source file*. */
  onTrim: (index: number, edge: "in" | "out", sourceSecs: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const total = totalDuration(clips, sources);
  const width = Math.max(total * pxPerSec, 200);
  const step = RULER_STEPS.find((s) => s * pxPerSec >= 56) ?? 3600;
  const ticks: number[] = [];
  for (let s = 0; s <= total + step; s += step) ticks.push(s);

  // Keep the playhead in view while scrubbing / playing.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const x = playhead * pxPerSec;
    const pad = 48;
    if (x < el.scrollLeft + pad) el.scrollLeft = Math.max(0, x - pad);
    else if (x > el.scrollLeft + el.clientWidth - pad) el.scrollLeft = x - el.clientWidth + pad;
  }, [playhead, pxPerSec]);

  const secsAt = (clientX: number): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft;
    return Math.max(0, Math.min(x / pxPerSec, total));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    const edgeEl = target.closest("[data-edge]") as HTMLElement | null;
    const clipEl = target.closest("[data-clip]") as HTMLElement | null;
    const idx = clipEl ? Number(clipEl.dataset.clip) : null;

    /** Follow a press with `move` on each pointer move and `end` on release. Both
     *  `pointerup` and `pointercancel` detach the handlers — a gesture the browser
     *  claims for itself never delivers a release, so cleaning up only on one
     *  would leak the handler and keep seeking through every later gesture. */
    const trackPointer = (
      move: ((ev: PointerEvent) => void) | null,
      end?: (ev: PointerEvent) => void
    ) => {
      const onMove = (ev: PointerEvent) => move?.(ev);
      const onUp = (ev: PointerEvent) => {
        stop();
        end?.(ev);
      };
      const stop = () => {
        if (move) window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", stop);
      };
      if (move) window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", stop);
    };

    if (edgeEl && idx !== null) {
      // Trim drag: the edge follows how far the *pointer* travelled, mapped into
      // source seconds (a clip's window starts at startTime within its file, and
      // a sped-up clip burns source seconds faster than the timeline shows them).
      // Pointer distance rather than absolute position because the in-edge has no
      // room to travel: clip 0's left edge sits at timeline 0, so an absolute
      // mapping can never read a pixel left of there and the handle could only
      // ever close, never reopen.
      const edge = (edgeEl.dataset.edge === "out" ? "out" : "in") as "in" | "out";
      const clip = clips[idx];
      const speed = speedOf(clip);
      const grabX = e.clientX;
      const grabSecs = edge === "in" ? clip.startTime : sourceEnd(clip, sources);
      onSelect(idx);
      e.preventDefault();
      trackPointer((ev) =>
        onTrim(idx, edge, grabSecs + ((ev.clientX - grabX) / pxPerSec) * speed)
      );
      return;
    }

    if (idx !== null) {
      // Clicking a clip selects it on press and moves the playhead on release —
      // seeking on press jumps the preview as soon as the button goes down.
      onSelect(idx);
      trackPointer(null, (ev) => onSeek(secsAt(ev.clientX)));
      return;
    }

    // Ruler and empty lane: press there, or press and drag, to scrub.
    onSeek(secsAt(e.clientX));
    trackPointer((ev) => onSeek(secsAt(ev.clientX)));
  };

  return (
    <div className="overflow-hidden rounded-lg bg-white ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
      <div
        ref={scrollRef}
        className="overflow-x-auto overscroll-x-contain px-0 pb-1 select-none"
        onPointerDown={onPointerDown}
      >
        <div style={{ width }} className="relative">
          {/* ruler */}
          <div className="relative h-5 border-b border-neutral-100 dark:border-neutral-800">
            {ticks.map((s) => (
              <div
                key={s}
                className="absolute bottom-0 top-0 border-l border-neutral-200 dark:border-neutral-700"
                style={{ left: s * pxPerSec }}
              >
                <span className="absolute left-1 top-0.5 text-[10px] tabular-nums text-neutral-400 dark:text-neutral-500">
                  {formatTime(s)}
                </span>
              </div>
            ))}
          </div>

          {/* track */}
          <div className="relative h-14 pt-1">
            {clips.map((clip, i) => {
              const dur = clipDuration(clip, sources);
              const g0 = globalStartOf(clips, sources, i);
              const src = sources.get(clip.path);
              const name = clip.path.split(/[\\/]/).pop() ?? clip.path;
              return (
                <div
                  key={`${clip.path}-${clip.startTime}-${i}`}
                  data-clip={i}
                  className={`absolute bottom-1 top-1 overflow-hidden ring-1 transition-shadow ${
                    selected === i
                      ? "z-10 ring-2 ring-brand-500"
                      : "ring-neutral-300 dark:ring-neutral-600"
                  } bg-neutral-200 dark:bg-neutral-700`}
                  style={{ left: g0 * pxPerSec, width: Math.max(dur * pxPerSec, 6) }}
                >
                  {src && (
                    <Filmstrip
                      path={clip.path}
                      sourceDur={src.durationSecs}
                      startTime={clip.startTime}
                      speed={speedOf(clip)}
                      pxPerSec={pxPerSec}
                    />
                  )}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/60 to-transparent px-1.5 pb-0.5 pt-2 text-[10px] leading-tight text-white">
                    <span className="truncate">{name}</span>
                    <span className="flex shrink-0 items-center gap-1 tabular-nums">
                      {clip.mute && <span aria-hidden>🔇</span>}
                      {(clip.speed ?? 1) !== 1 && <span>{(clip.speed ?? 1).toFixed(2).replace(/\.?0+$/, "")}×</span>}
                      {dur > 0 && <span>{formatTime(dur)}</span>}
                    </span>
                  </div>
                  {/* trim handles sit above the filmstrip and the label */}
                  <div
                    data-edge="in"
                    className="absolute inset-y-0 left-0 z-20 w-2 cursor-ew-resize bg-brand-500/0 transition-colors hover:bg-brand-500/60"
                  />
                  <div
                    data-edge="out"
                    className="absolute inset-y-0 right-0 z-20 w-2 cursor-ew-resize bg-brand-500/0 transition-colors hover:bg-brand-500/60"
                  />
                </div>
              );
            })}

            {clips.length === 0 && (
              <div className="absolute inset-x-3 inset-y-2 flex items-center justify-center rounded-md border border-dashed border-neutral-200 text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
                {/* empty-track hint lives in the workbench above; keep the lane visible */}
              </div>
            )}

            {/* playhead */}
            <div
              className="pointer-events-none absolute bottom-0 top-0 z-30 w-0.5 bg-error-500"
              style={{ left: playhead * pxPerSec }}
            >
              <div className="absolute -left-[3px] top-0 h-2 w-2 rounded-full bg-error-500" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
