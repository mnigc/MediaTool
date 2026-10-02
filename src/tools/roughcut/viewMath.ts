//! Pure display math for the rough-cut timeline: ruler tick spacing, the
//! trim-drag pointer mapping, and the zoom slider's geometric scale. Extracted
//! verbatim from Timeline / RoughCutWorkbench so the conversions are
//! unit-testable with zero DOM; every function here is side-effect free.

/** Coarsest-to-finest ruler steps, in timeline seconds. */
const RULER_STEPS = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

/** Ruler tick interval: the coarsest step that still puts a tick at least 56px
 *  apart at this zoom, or one hour at the most zoomed-out levels. */
export function rulerStep(pxPerSec: number): number {
  return RULER_STEPS.find((s) => s * pxPerSec >= 56) ?? 3600;
}

/** Tick positions 0, step, 2·step … past the timeline end, so the last visible
 *  pixel always has a tick at or to the right of it. */
export function rulerTicks(total: number, step: number): number[] {
  const ticks: number[] = [];
  for (let s = 0; s <= total + step; s += step) ticks.push(s);
  return ticks;
}

/** Trim-drag mapping: how far the dragged edge moves *within its source file*
 *  for a pointer travel of `dxPx` timeline pixels from the grab point.
 *  Pixels / pxPerSec is timeline time; a sped-up clip burns source seconds
 *  faster by `speed`. Pointer distance rather than absolute position because
 *  the in-edge has no room to travel: clip 0's left edge sits at timeline 0,
 *  so an absolute mapping could only ever close it, never reopen it. */
export function dragToSourceSecs(
  grabSecs: number,
  dxPx: number,
  pxPerSec: number,
  speed: number
): number {
  return grabSecs + (dxPx / pxPerSec) * speed;
}

// 0.05 px/s = one pixel per 20s, so even hours-long footage fits the viewport
// without scrolling; the ruler coarsens its ticks (up to 30/60-min) to match.
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 200;

/** Zoom level <-> slider position on a geometric scale: the track's pixels are
 *  seconds-per-unit, so a linear slider would crowd the whole useful range into
 *  its first few percent. */
export function zoomToSlider(pxPerSec: number): number {
  return (Math.log(pxPerSec / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * 100;
}

export function sliderToZoom(pos: number): number {
  return ZOOM_MIN * Math.exp((pos / 100) * Math.log(ZOOM_MAX / ZOOM_MIN));
}
