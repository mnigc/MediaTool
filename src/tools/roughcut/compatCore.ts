//! Pure core of the lossless-concat compatibility pre-check: given one probe
//! report per unique source, compare every source against the first readable
//! one, field by field. Split from `compat.ts` — which fetches the reports
//! through the engine and cannot be imported outside a browser shell — so the
//! field logic is unit-testable with zero DOM and zero IPC.

import type { StreamReport } from "../../types";

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

export interface MediaReportLike {
  streams: StreamReport[];
}

function videoStream(report: MediaReportLike): StreamReport | null {
  return report.streams.find((s) => s.kind === "video") ?? null;
}

function audioStream(report: MediaReportLike): StreamReport | null {
  return report.streams.find((s) => s.kind === "audio") ?? null;
}

const cmp = (a: unknown, b: unknown) => String(a ?? "") !== String(b ?? "");

/** Compare every unique source against the first *readable* one (the first
 *  entry of `unique` that has a report in `reports`). Cheap fields first; all
 *  mismatches are reported so the user can decide. `firstPath` is undefined
 *  when nothing readable was probed and the check cannot pass. */
export function compareReports(
  unique: string[],
  reports: Map<string, MediaReportLike>
): { problems: CompatProblem[]; firstPath: string | undefined } {
  const problems: CompatProblem[] = [];
  const firstPath = unique.find((p) => reports.has(p));
  if (!firstPath) return { problems, firstPath };
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

  return { problems, firstPath };
}
