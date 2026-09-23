//! Lossless-concat compatibility pre-check for the rough-cut editor's copy
//! mode. The backend hard-fails on codec-family / resolution mismatches; this
//! check adds the softer signals ffprobe has but MediaInfo drops (fps, pixel
//! format, profile, audio rate), so the user learns about a problem before
//! encoding instead of from a glitchy output file.

import { inspectMedia } from "../../lib/engine";
import type { MediaReport, StreamReport } from "../../types";

export type CompatField =
  | "videoCodec"
  | "profile"
  | "pixFmt"
  | "size"
  | "fps"
  | "audioCodec"
  | "sampleRate"
  | "channels";

export interface CompatProblem {
  /** Source file (unique path) that differs from the first clip's source. */
  source: string;
  field: CompatField;
  first: string;
  other: string;
}

export interface CompatResult {
  ok: boolean;
  problems: CompatProblem[];
  /** Failed probes (unreadable / non-media files). */
  unreadable: string[];
}

function videoStream(report: MediaReportLike): StreamReport | null {
  return report.streams.find((s) => s.kind === "video") ?? null;
}

function audioStream(report: MediaReportLike): StreamReport | null {
  return report.streams.find((s) => s.kind === "audio") ?? null;
}

interface MediaReportLike {
  streams: StreamReport[];
}

const cmp = (a: unknown, b: unknown) => String(a ?? "") !== String(b ?? "");

// Session-lifetime probe cache: the auto-check re-runs on every source-set
// change, and source files don't change underneath a running session.
const reportCache = new Map<string, MediaReport>();

/** The full ffprobe report for one source, served from the cache the
 *  compatibility check already fills — so the spec panel costs no extra probe
 *  for anything on the timeline. */
export async function inspectCached(path: string): Promise<MediaReport> {
  const cached = reportCache.get(path);
  if (cached) return cached;
  const report = await inspectMedia(path);
  reportCache.set(path, report);
  return report;
}

/** Compare every unique source against the first clip's source. Cheap fields
 *  first; all mismatches are reported so the user can decide. */
export async function checkConcatCompat(paths: string[]): Promise<CompatResult> {
  const unique = Array.from(new Set(paths));
  const reports = new Map<string, MediaReportLike>();
  const unreadable: string[] = [];
  await Promise.all(
    unique.map(async (p) => {
      try {
        reports.set(p, await inspectCached(p));
      } catch {
        unreadable.push(p);
      }
    })
  );

  const problems: CompatProblem[] = [];
  const firstPath = unique.find((p) => reports.has(p));
  if (!firstPath) return { ok: false, problems, unreadable };
  const first = reports.get(firstPath)!;
  const fv = videoStream(first);
  const fa = audioStream(first);

  for (const p of unique) {
    if (p === firstPath) continue;
    const report = reports.get(p);
    if (!report) continue;
    const v = videoStream(report);
    const a = audioStream(report);
    const push = (field: CompatField, other: unknown, base: unknown) =>
      problems.push({ source: p, field, first: String(base ?? ""), other: String(other ?? "") });
    if (!v || !fv) {
      push("videoCodec", v?.codecName ?? null, fv?.codecName);
      continue;
    }
    if (cmp(v.codecName, fv.codecName)) push("videoCodec", v.codecName, fv.codecName);
    else {
      if (cmp(v.profile, fv.profile)) push("profile", v.profile, fv.profile);
      if (cmp(v.pixFmt, fv.pixFmt)) push("pixFmt", v.pixFmt, fv.pixFmt);
      if (cmp(v.avgFrameRate, fv.avgFrameRate)) push("fps", v.avgFrameRate, fv.avgFrameRate);
    }
    if (v.width !== fv.width || v.height !== fv.height) {
      push("size", `${v.width ?? "?"}x${v.height ?? "?"}`, `${fv.width ?? "?"}x${fv.height ?? "?"}`);
    }
    if (fa && a) {
      if (cmp(a.codecName, fa.codecName)) push("audioCodec", a.codecName, fa.codecName);
      if (cmp(a.sampleRate, fa.sampleRate)) push("sampleRate", a.sampleRate, fa.sampleRate);
      if (cmp(a.channels, fa.channels)) push("channels", a.channels, fa.channels);
    }
  }

  return { ok: problems.length === 0 && unreadable.length === 0, problems, unreadable };
}
