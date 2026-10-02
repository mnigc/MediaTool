// Unit tests for the project store's pure read core (shape checking and
// ordering). The localStorage side of the store is not covered here — zero DOM.

import { describe, expect, it } from "vitest";
import type { RoughCutProject } from "./store";
import { parseProjects } from "./store";

const project = (name: string, savedAt: number): RoughCutProject => ({
  id: `id-${name}`,
  name,
  clips: [{ path: "a.mp4", startTime: 0, endTime: 10 }],
  savedAt,
});

describe("parseProjects", () => {
  it("treats a non-array payload as no projects", () => {
    expect(parseProjects(null)).toEqual([]);
    expect(parseProjects("nope")).toEqual([]);
    expect(parseProjects({ name: "x" })).toEqual([]);
  });

  it("drops malformed entries and keeps well-shaped ones", () => {
    const kept = project("good", 1);
    const parsed = parseProjects([
      kept,
      null,
      { name: "no-id", clips: [], savedAt: 2 },
      { id: "no-name", clips: [], savedAt: 3 },
      { id: "bad-clips", name: "x", clips: ["nope"], savedAt: 4 },
      { id: "no-start", name: "y", clips: [{ path: "a.mp4" }], savedAt: 5 },
    ]);
    expect(parsed).toEqual([kept]);
  });

  it("orders newest first by savedAt", () => {
    const parsed = parseProjects([project("old", 100), project("new", 300), project("mid", 200)]);
    expect(parsed.map((p) => p.name)).toEqual(["new", "mid", "old"]);
  });

  it("accepts a project whose clip list is empty (shape check only)", () => {
    const empty = { id: "e", name: "empty", clips: [], savedAt: 1 };
    expect(parseProjects([empty])).toEqual([empty]);
  });
});
