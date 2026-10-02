// Unit tests for the pure display math extracted from the timeline components
// (ruler ticks, trim-drag pointer mapping, zoom slider scale). Zero DOM.

import { describe, expect, it } from "vitest";
import { dragToSourceSecs, rulerStep, rulerTicks, sliderToZoom, zoomToSlider } from "./viewMath";

describe("rulerStep", () => {
  it("picks the coarsest step keeping ticks at least 56px apart", () => {
    expect(rulerStep(1)).toBe(60); // 30s would be 30px, 60s is 60px
    expect(rulerStep(200)).toBe(0.5); // 0.2s would be 40px
    expect(rulerStep(0.05)).toBe(1800); // 600s would be 30px
  });

  it("falls back to one hour below the coarsest step", () => {
    expect(rulerStep(0.01)).toBe(3600); // 3600 * 0.01 = 36px < 56
  });
});

describe("rulerTicks", () => {
  it("walks from zero to one step past the end", () => {
    expect(rulerTicks(30, 10)).toEqual([0, 10, 20, 30, 40]);
    expect(rulerTicks(0, 5)).toEqual([0, 5]);
  });
});

describe("dragToSourceSecs", () => {
  it("maps pointer travel into source seconds through speed", () => {
    expect(dragToSourceSecs(5, 100, 10, 1)).toBe(15); // 100px at 10px/s = 10s
    expect(dragToSourceSecs(5, 100, 10, 2)).toBe(25); // 2× clip burns source faster
    expect(dragToSourceSecs(5, -50, 10, 2)).toBe(-5); // clamping is trimEdge's job
  });
});

describe("zoom slider scale", () => {
  it("pins the extremes to the slider's ends", () => {
    expect(zoomToSlider(0.05)).toBe(0);
    expect(zoomToSlider(200)).toBe(100);
    expect(sliderToZoom(0)).toBeCloseTo(0.05);
    expect(sliderToZoom(100)).toBeCloseTo(200);
  });

  it("round-trips intermediate zooms and centers 1 px/s mid-slider", () => {
    expect(zoomToSlider(1)).toBeCloseTo(36.1, 1);
    for (const pxPerSec of [0.08, 0.5, 3, 25, 140]) {
      expect(sliderToZoom(zoomToSlider(pxPerSec))).toBeCloseTo(pxPerSec, 5);
    }
  });
});
