//! Lossless-concat compatibility pre-check for the rough-cut editor's copy
//! mode. The backend hard-fails on codec-family / resolution mismatches; this
//! check adds the softer signals ffprobe has but MediaInfo drops (fps, pixel
//! format, profile, audio rate), so the user learns about a problem before
//! encoding instead of from a glitchy output file. The field comparison
//! itself lives in `compatCore.ts`, pure and unit-tested; this module fetches
//! and caches the reports around it.

import { inspectMedia } from "../../lib/engine";
import type { MediaReport } from "../../types";
import {
  compareReports,
  type CompatField,
  type CompatProblem,
  type MediaReportLike,
} from "./compatCore";

export type { CompatField, CompatProblem };

export interface CompatResult {
  ok: boolean;
  problems: CompatProblem[];
  /** Failed probes (unreadable / non-media files). */
  unreadable: string[];
}

// Session-lifetime probe cache: the auto-check re-runs on every source-set
// change, and source files don't change underneath a running session. The
// promise (not the result) is cached so concurrent probes of the same path
// dedupe into one inspectMedia call; the cap evicts the least recently used
// so a long session can't grow the map without bound.
const REPORT_CACHE_MAX = 12;
const reportCache = new Map<string, Promise<MediaReport>>();

/** The full ffprobe report for one source, served from the cache the
 *  compatibility check already fills — so the spec panel costs no extra probe
 *  for anything on the timeline. */
export async function inspectCached(path: string): Promise<MediaReport> {
  const cached = reportCache.get(path);
  if (cached) {
    // Re-insert to refresh recency order (Map iterates oldest first).
    reportCache.delete(path);
    reportCache.set(path, cached);
    return cached;
  }
  const p = inspectMedia(path).catch((e) => {
    // A failed probe must not squat on the key: the next call retries.
    reportCache.delete(path);
    throw e;
  });
  reportCache.set(path, p);
  if (reportCache.size > REPORT_CACHE_MAX) {
    const oldest = reportCache.keys().next();
    if (!oldest.done) reportCache.delete(oldest.value);
  }
  return p;
}

/** Probe every unique source, then hand the readable reports to the pure
 *  comparison in compatCore. */
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

  const { problems, firstPath } = compareReports(unique, reports);
  return {
    ok: firstPath !== undefined && problems.length === 0 && unreadable.length === 0,
    problems,
    unreadable,
  };
}
