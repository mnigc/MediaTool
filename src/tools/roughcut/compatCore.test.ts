// Unit tests for the concat-compatibility field comparison. These hit the pure
// core (compatCore) only: no probes, no DOM, no IPC mocks.

import { describe, expect, it } from "vitest";
import type { StreamReport } from "../../types";
import { compareReports, type MediaReportLike } from "./compatCore";

const vs = (over: Partial<StreamReport> = {}): StreamReport => ({
  index: 0,
  kind: "video",
  codecName: "h264",
  profile: "High",
  pixFmt: "yuv420p",
  width: 1920,
  height: 1080,
  avgFrameRate: "30/1",
  tags: null,
  ...over,
});

const as = (over: Partial<StreamReport> = {}): StreamReport => ({
  index: 1,
  kind: "audio",
  codecName: "aac",
  sampleRate: 48000,
  channels: 2,
  tags: null,
  ...over,
});

const report = (...streams: StreamReport[]): MediaReportLike => ({ streams });

describe("compareReports", () => {
  it("passes identical sources and anchors on the first readable one", () => {
    const unique = ["a.mp4", "b.mp4"];
    const reports = new Map([
      ["a.mp4", report(vs(), as())],
      ["b.mp4", report(vs(), as())],
    ]);
    const { problems, firstPath } = compareReports(unique, reports);
    expect(problems).toEqual([]);
    expect(firstPath).toBe("a.mp4");
  });

  it("reports a codec mismatch as one videoCodec problem", () => {
    const unique = ["a.mp4", "b.mp4"];
    const reports = new Map([
      ["a.mp4", report(vs())],
      ["b.mp4", report(vs({ codecName: "hevc" }))],
    ]);
    expect(compareReports(unique, reports).problems).toEqual([
      { source: "b.mp4", field: "videoCodec", first: "h264", other: "hevc" },
    ]);
  });

  it("skips the soft video fields when codecs differ, checks them when they match", () => {
    const unique = ["a.mp4", "b.mp4"];
    // same codec, different profile/pix-fmt/fps → three problems, no codec one
    const softer = new Map([
      ["a.mp4", report(vs())],
      ["b.mp4", report(vs({ profile: "Main", pixFmt: "yuv420p10le", avgFrameRate: "60/1" }))],
    ]);
    expect(compareReports(unique, softer).problems).toEqual([
      { source: "b.mp4", field: "profile", first: "High", other: "Main" },
      { source: "b.mp4", field: "pixFmt", first: "yuv420p", other: "yuv420p10le" },
      { source: "b.mp4", field: "fps", first: "30/1", other: "60/1" },
    ]);
    // different codec AND size → the codec problem plus the size one
    const sized = new Map([
      ["a.mp4", report(vs())],
      ["b.mp4", report(vs({ codecName: "hevc", width: 1280, height: 720 }))],
    ]);
    const problems = compareReports(unique, sized).problems;
    expect(problems.map((p) => p.field)).toEqual(["videoCodec", "size"]);
    expect(problems[1]).toEqual({
      source: "b.mp4",
      field: "size",
      first: "1920x1080",
      other: "1280x720",
    });
  });

  it("compares audio only when both sides carry an audio stream", () => {
    const unique = ["a.mp4", "b.mp4"];
    const differ = new Map([
      ["a.mp4", report(vs(), as())],
      ["b.mp4", report(vs(), as({ codecName: "mp3", sampleRate: 44100, channels: 1 }))],
    ]);
    expect(compareReports(unique, differ).problems.map((p) => p.field)).toEqual([
      "audioCodec",
      "sampleRate",
      "channels",
    ]);
    const silent = new Map([
      ["a.mp4", report(vs(), as())],
      ["b.mp4", report(vs())], // no audio stream: nothing to compare
    ]);
    expect(compareReports(unique, silent).problems).toEqual([]);
  });

  it("anchors on the first readable source and fails when none is readable", () => {
    // a.mp4 failed to probe: b.mp4 becomes the baseline, x is compared to it
    const partial = new Map([["b.mp4", report(vs())]]);
    const { firstPath } = compareReports(["a.mp4", "b.mp4"], partial);
    expect(firstPath).toBe("b.mp4");

    const nothing = compareReports(["a.mp4"], new Map());
    expect(nothing.firstPath).toBeUndefined();
    expect(nothing.problems).toEqual([]);
  });
});
