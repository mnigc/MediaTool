//! The rough-cut preview player: one `<video>` element walked across the
//! timeline. When the playhead crosses into the next clip the source swaps
//! and playback continues from that clip's head — the brief hiccup at the
//! seam is accepted for a rough cut. Desktop plays through the asset
//! protocol, web mode through the ranged `/api/media` endpoint (see
//! `mediaStreamUrl`), so seeking stays native in both shells.
//!
//! The element always runs in *source* time (`currentTime` is a position in
//! the file), while the playhead is *timeline* time: a clip cut from the
//! middle of a file starts at its `startTime`, and a sped-up clip walks its
//! source faster. Every mapping between the two goes through `sourceTime`.

import { useEffect, useRef } from "react";
import { mediaStreamUrl } from "../../lib/shell";
import type { RoughCutClip } from "../../types";
import {
  clipDuration,
  globalStartOf,
  locate,
  sourceEnd,
  speedOf,
  type SourceInfo,
} from "./model";

/** Timeline seconds inside a clip → seconds within its source file. */
function sourceTime(clip: RoughCutClip, local: number): number {
  return clip.startTime + local * speedOf(clip);
}

export default function Player({
  clips,
  sources,
  playhead,
  playing,
  muted,
  onPlayhead,
  onPlayState,
  onLoadError,
}: {
  clips: RoughCutClip[];
  sources: Map<string, SourceInfo>;
  playhead: number;
  playing: boolean;
  muted: boolean;
  /** Continuous playhead updates while playing, and seeks from outside. */
  onPlayhead: (secs: number) => void;
  onPlayState: (playing: boolean) => void;
  /** Load failed for good after retries (true) or recovered (false). */
  onLoadError: (failed: boolean) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  // Which clip the element is currently loaded for.
  const activeRef = useRef<number | null>(null);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  /** Per-clip tweaks, applied through native element controls. Re-applied after
   *  every `load()` because loading resets the rate. */
  const applyTweaks = (v: HTMLVideoElement, clip: RoughCutClip) => {
    const speed = speedOf(clip);
    if (v.playbackRate !== speed) v.playbackRate = speed;
    const wantMuted = mutedRef.current || !!clip.mute;
    if (v.muted !== wantMuted) v.muted = wantMuted;
    // The element ignores an out-of-range write rather than clamping it, and a
    // gain above its 1.0 ceiling is what the slider used to allow.
    const vol = Math.min(Math.max(clip.volume ?? 1, 0), 1);
    if (v.volume !== vol) v.volume = vol;
  };

  const seekTo = (v: HTMLVideoElement, clip: RoughCutClip, local: number) => {
    const s0 = clip.startTime;
    const s1 = sourceEnd(clip, sourcesRef.current);
    const t = sourceTime(clip, local);
    try {
      v.currentTime = Math.max(0, Math.min(t, Math.max(s0, s1 - 0.01)));
    } catch {
      // setting time on an empty pipeline can throw; ignore
    }
  };

  const activate = (index: number, local: number, autoplay: boolean, attempt = 0) => {
    const v = ref.current;
    const clip = clipsRef.current[index];
    if (!v || !clip) return;
    const start = () => {
      seekTo(v, clip, local);
      applyTweaks(v, clip);
      // autoplay can go stale across a retry — the user may have paused while
      // the reload was pending
      if (autoplay && playingRef.current) void v.play().catch(() => onPlayState(false));
    };
    if (activeRef.current === index) {
      start();
      return;
    }
    activeRef.current = index;
    void mediaStreamUrl(clip.path).then((url) => {
      if (activeRef.current !== index || ref.current !== v) return;
      v.src = url;
      v.load();
      const done = () => {
        v.removeEventListener("loadedmetadata", onMeta);
        v.removeEventListener("error", onErr);
      };
      const onMeta = () => {
        done();
        if (activeRef.current !== index) return;
        onLoadError(false);
        start();
      };
      // A load that fails (asset hiccup while probes and filmstrip extraction
      // crowd the same file) never fires loadedmetadata and used to wedge the
      // player: activeRef kept claiming the clip was loaded. Retry twice, then
      // forget the clip so the next play press starts a fresh load.
      const onErr = () => {
        done();
        if (activeRef.current !== index || ref.current !== v) return;
        activeRef.current = null;
        if (attempt + 1 < 3) {
          window.setTimeout(() => {
            if (activeRef.current === null && ref.current === v) {
              activate(index, local, autoplay, attempt + 1);
            }
          }, 300);
        } else {
          onPlayState(false);
          onLoadError(true);
        }
      };
      v.addEventListener("loadedmetadata", onMeta);
      v.addEventListener("error", onErr);
    });
  };

  // External seeks (timeline clicks, transport buttons): jump to the clip
  // under the playhead. During playback this effect also fires every frame
  // but the distance guard keeps it from re-seeking.
  useEffect(() => {
    const at = locate(clips, sources, playhead);
    if (!at) {
      if (activeRef.current !== null) {
        activeRef.current = null;
        const v = ref.current;
        if (v) {
          v.removeAttribute("src");
          v.load();
        }
      }
      return;
    }
    const v = ref.current;
    if (!v) return;
    const clip = clips[at.index];
    if (activeRef.current !== at.index) {
      activate(at.index, at.local, playing);
    } else if (
      v.readyState >= 1 &&
      Math.abs(v.currentTime - sourceTime(clip, at.local)) > 0.2 * speedOf(clip)
    ) {
      seekTo(v, clip, at.local);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead, clips, sources]);

  // Play/pause. A forgotten clip (failed load) gets a fresh full load for
  // whatever sits under the playhead — play() alone would just reject on an
  // empty pipeline.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (playing) {
      if (activeRef.current === null) {
        const at = locate(clipsRef.current, sourcesRef.current, playhead);
        if (at) {
          activate(at.index, at.local, true);
          return;
        }
      }
      void v.play().catch(() => onPlayState(false));
    } else {
      v.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // The transport mute toggle and any per-clip tweak the active clip carries.
  useEffect(() => {
    const v = ref.current;
    const idx = activeRef.current;
    const clip = idx !== null ? clips[idx] : null;
    if (!v || !clip) return;
    applyTweaks(v, clip);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted, clips]);

  // The playback loop: advance the global playhead from the element's own
  // clock, and swap sources at clip seams.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = ref.current;
      const cs = clipsRef.current;
      const srcs = sourcesRef.current;
      const idx = activeRef.current;
      if (v && idx !== null && cs[idx]) {
        const clip = cs[idx];
        const speed = speedOf(clip);
        const g0 = globalStartOf(cs, srcs, idx);
        // 40ms of slack before the source's out point counts as the seam, so
        // a slow last frame never stalls the hand-off.
        if (v.currentTime >= sourceEnd(clip, srcs) - 0.04 * speed) {
          if (idx + 1 < cs.length) {
            activate(idx + 1, 0, true);
            onPlayhead(globalStartOf(cs, srcs, idx + 1));
          } else {
            onPlayhead(g0 + clipDuration(clip, srcs));
            onPlayState(false);
            return; // stop the loop; the effect re-runs when playing flips
          }
        } else {
          onPlayhead(g0 + (v.currentTime - clip.startTime) / speed);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, clips, sources]);

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-black">
      <video ref={ref} className="max-h-full max-w-full" playsInline controls={false} />
    </div>
  );
}
