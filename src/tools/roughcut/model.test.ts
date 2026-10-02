// Unit tests for the pure timeline model: locate/mapping, split and trim
// boundaries, reordering, and the undo/redo reducer. Zero DOM, zero IPC.

import { describe, expect, it } from "vitest";
import type { RoughCutClip } from "../../types";
import {
  clipDuration,
  clipForSource,
  formatTime,
  globalStartOf,
  locate,
  MIN_SLICE,
  moveClip,
  removeClip,
  sourceEnd,
  sourceTimeOf,
  speedOf,
  splitAt,
  timelineReducer,
  totalDuration,
  trimEdge,
  type SourceInfo,
  type TimelineState,
} from "./model";

const source = (path: string, durationSecs: number): SourceInfo => ({
  path,
  durationSecs,
  mediaType: "video",
});

const SOURCES = new Map<string, SourceInfo>([
  ["a.mp4", source("a.mp4", 10)],
  ["b.mp4", source("b.mp4", 20)],
]);

const clip = (path: string, startTime = 0, endTime?: number, speed?: number): RoughCutClip => ({
  path,
  startTime,
  ...(endTime !== undefined ? { endTime } : {}),
  ...(speed !== undefined ? { speed } : {}),
});

describe("formatTime", () => {
  it("renders m:ss.t, clamps negatives, and drops the tenth when coarse", () => {
    expect(formatTime(0)).toBe("00:00.0");
    expect(formatTime(65.34)).toBe("01:05.3");
    expect(formatTime(-3)).toBe("00:00.0");
    expect(formatTime(3661)).toBe("1:01:01.0");
    expect(formatTime(30, true)).toBe("00:30");
    expect(formatTime(3661.9, true)).toBe("1:01:01");
  });
});

describe("locate", () => {
  it("maps a global position to its clip and local offset", () => {
    // 10s from a.mp4 + 10s window of b.mp4
    const clips = [clip("a.mp4"), clip("b.mp4", 5, 15)];
    expect(locate([], SOURCES, 3)).toBeNull();
    expect(locate(clips, SOURCES, 0)).toEqual({ index: 0, local: 0 });
    expect(locate(clips, SOURCES, 9.5)).toEqual({ index: 0, local: 9.5 });
    // exactly at the seam, the next clip owns the boundary
    expect(locate(clips, SOURCES, 10)).toEqual({ index: 1, local: 0 });
    // past the end clamps into the last clip
    expect(locate(clips, SOURCES, 99)).toEqual({ index: 1, local: 10 - 0.001 });
  });
});

describe("splitAt", () => {
  it("cuts the clip under the position, scaling the point by speed", () => {
    expect(splitAt([clip("a.mp4")], SOURCES, 4)).toEqual([
      { path: "a.mp4", startTime: 0, endTime: 4 },
      { path: "a.mp4", startTime: 4, endTime: 10 },
    ]);
    // a 2× clip covers its window twice as fast: timeline 2.5 = source 5
    expect(splitAt([clip("a.mp4", 0, 10, 2)], SOURCES, 2.5)).toEqual([
      { path: "a.mp4", startTime: 0, endTime: 5, speed: 2 },
      { path: "a.mp4", startTime: 5, endTime: 10, speed: 2 },
    ]);
  });

  it("refuses slivers and empty timelines", () => {
    expect(splitAt([], SOURCES, 5)).toBeNull();
    expect(splitAt([clip("a.mp4")], SOURCES, 0.01)).toBeNull(); // < MIN_SLICE off the in edge
    expect(splitAt([clip("a.mp4")], SOURCES, 10 - MIN_SLICE / 2)).toBeNull(); // off the out edge
  });
});

describe("trimEdge", () => {
  it("clamps into the source window without crossing the opposite edge", () => {
    const clips = [clip("a.mp4", 2, 8)];
    expect(trimEdge(clips, SOURCES, 0, "in", 4)[0].startTime).toBe(4);
    expect(trimEdge(clips, SOURCES, 0, "in", -1)[0].startTime).toBe(0);
    expect(trimEdge(clips, SOURCES, 0, "in", 99)[0].startTime).toBeCloseTo(8 - MIN_SLICE);
    // the out edge never passes the source's real duration
    expect(trimEdge(clips, SOURCES, 0, "out", 99)[0].endTime).toBe(10);
    expect(trimEdge(clips, SOURCES, 0, "out", 1)[0].endTime).toBe(2 + MIN_SLICE);
  });

  it("passes values through for an unprobed source and ignores bad indexes", () => {
    const unprobed = [clip("gone.mp4", 2, 8)]; // not in SOURCES
    expect(trimEdge(unprobed, SOURCES, 0, "out", 42)[0].endTime).toBe(42);
    const clips = [clip("a.mp4", 0, 10)];
    expect(trimEdge(clips, SOURCES, 7, "in", 1)).toBe(clips);
  });
});

describe("reorder and remove", () => {
  it("moves within bounds and drops by index", () => {
    const clips = [clip("a.mp4"), clip("b.mp4"), clip("c.mp4")];
    expect(moveClip(clips, 0, 2)).toEqual([clips[1], clips[2], clips[0]]);
    expect(moveClip(clips, 1, 1)).toBe(clips);
    expect(moveClip(clips, 0, 9)).toBe(clips);
    expect(removeClip(clips, 1)).toEqual([clips[0], clips[2]]);
  });
});

describe("durations and source mapping", () => {
  it("follows the clip's speed and source windows", () => {
    const clips = [clip("a.mp4", 0, 10, 2), clip("b.mp4", 5, 15)];
    expect(speedOf(clip("a.mp4", 0, 10, 9))).toBe(4); // the backend clamps 0.25..4
    expect(speedOf(clip("a.mp4", 0, 10, 0.1))).toBe(0.25);
    expect(clipDuration(clips[0], SOURCES)).toBe(5);
    expect(totalDuration(clips, SOURCES)).toBe(15);
    expect(globalStartOf(clips, SOURCES, 0)).toBe(0);
    expect(globalStartOf(clips, SOURCES, 1)).toBe(5);
    expect(sourceEnd({ path: "a.mp4", startTime: 2 }, SOURCES)).toBe(10); // endTime undefined → source end
    expect(sourceTimeOf(clips[0], 2.5)).toBe(5); // local 2.5 timeline = source 5 at 2×
    expect(clipForSource(source("b.mp4", 20))).toEqual({ path: "b.mp4", startTime: 0, endTime: 20 });
  });
});

describe("timelineReducer", () => {
  it("folds tagged gestures into one undo step and walks undo/redo", () => {
    const initial: TimelineState = { clips: [], past: [], future: [], tag: null };
    const a = [clip("a.mp4")];
    const b = [clip("a.mp4"), clip("b.mp4")];

    // two commits sharing a tag fold: one history entry, reference kept
    const folded = timelineReducer(
      timelineReducer(initial, { type: "commit", clips: a, tag: "trim:0:in" }),
      { type: "commit", clips: b, tag: "trim:0:in" }
    );
    expect(folded.clips).toBe(b);
    expect(folded.past).toHaveLength(1);

    // an untagged commit pushes history and clears the future
    const c = [clip("c.mp4")];
    const committed = timelineReducer(folded, { type: "commit", clips: c });
    expect(committed.past).toHaveLength(2);
    expect(committed.future).toHaveLength(0);

    // undo walks back through the push points: c → b → empty (the folded `a`
    // never hit the stack, that is what the fold is for)
    const once = timelineReducer(committed, { type: "undo" });
    expect(once.clips).toEqual(b);
    const twice = timelineReducer(once, { type: "undo" });
    expect(twice.clips).toEqual(initial.clips);
    // redo replays the future in order
    const redone = timelineReducer(twice, { type: "redo" });
    expect(redone.clips).toEqual(b);
    expect(timelineReducer(redone, { type: "redo" }).clips).toEqual(c);
    // a fresh commit over undone history discards the future
    expect(timelineReducer(once, { type: "commit", clips: c }).future).toHaveLength(0);

    // reset drops the stacks; a no-op commit returns the same state object
    expect(timelineReducer(committed, { type: "reset", clips: [] })).toEqual({
      clips: [],
      past: [],
      future: [],
      tag: null,
    });
    expect(timelineReducer(committed, { type: "commit", clips: c })).toBe(committed);
  });

  it("caps the history at 50 steps, dropping the oldest", () => {
    let state: TimelineState = { clips: [], past: [], future: [], tag: null };
    for (let i = 0; i < 60; i++) {
      state = timelineReducer(state, { type: "commit", clips: [clip("a.mp4", 0, i + 1)] });
    }
    expect(state.past).toHaveLength(50);
    // the first 10 predecessors were shifted off: the oldest kept is #10's
    expect(state.past[0]).toEqual([clip("a.mp4", 0, 10)]);
    expect(timelineReducer(state, { type: "undo" }).clips).toEqual([clip("a.mp4", 0, 59)]);
  });
});
