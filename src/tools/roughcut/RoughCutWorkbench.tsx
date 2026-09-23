//! The rough-cut editor: a source bin, a preview player, a single-track
//! timeline, and the export bar. State is one reducer (`model.ts`) with
//! undo/redo; the timeline autosaves so a half-finished cut survives a
//! restart. Export submits through the shared task queue — progress, cancel
//! and output handling come for free from the existing job machinery.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { canRevealInFolder, pickPaths } from "../../lib/shell";
import { getThumbnail, openOutputFolder, probeFile } from "../../lib/engine";
import { useI18n } from "../../i18n";
import { useTasks } from "../../contexts/TaskCenter";
import { useConfirm } from "../../components/ConfirmDialog";
import { extOk } from "../FilePicker";
import { getTool } from "../registry";
import { TimelineIcon, PlayIcon, SpinnerIcon, MuteIcon, VolumeIcon } from "../../components/icons";
import { Checkbox, Field, NumInput } from "../panels/ui";
import Select from "../../components/Select";
import type { RoughCutClip, RoughCutParams } from "../../types";
import {
  clipForSource,
  formatTime,
  locate,
  MIN_SLICE,
  moveClip,
  removeClip,
  sourceEnd,
  splitAt,
  timelineReducer,
  totalDuration,
  trimEdge,
  type SourceInfo,
  type TimelineState,
} from "./model";
import { clearCurrent, loadBin, loadCurrent, removeProject, saveBin, saveCurrent, saveProject, useRoughCutProjects } from "./store";
import Timeline from "./Timeline";
import Player from "./Player";
import ExportBar from "./ExportBar";

const TOOL = "roughcut" as const;

function sourceName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

const ZOOM_MIN = 4;
const ZOOM_MAX = 200;

/** Zoom level <-> slider position on a geometric scale: the track's pixels are
 *  seconds-per-unit, so a linear slider would crowd the whole useful range into
 *  its first few percent. */
function zoomToSlider(pxPerSec: number): number {
  return (Math.log(pxPerSec / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * 100;
}

function sliderToZoom(pos: number): number {
  return ZOOM_MIN * Math.exp((pos / 100) * Math.log(ZOOM_MAX / ZOOM_MIN));
}

/** Tells `mp-range` where the thumb sits so it can paint the filled part. */
function rangeFill(value: number, min: number, max: number): React.CSSProperties {
  return { "--mp-fill": `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties;
}

export default function RoughCutWorkbench({ onBack }: { onBack?: () => void }) {
  const { t } = useI18n();
  const tasks = useTasks();
  const { confirm, dialog } = useConfirm();
  const meta = getTool(TOOL)!;
  const accepts = meta.accepts;

  const [state, dispatch] = useReducer(timelineReducer, {
    clips: [],
    past: [],
    future: [],
    tag: null,
  } satisfies TimelineState);
  const clips = state.clips;
  const [sources, setSources] = useState<Map<string, SourceInfo>>(new Map());
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pxPerSec, setPxPerSec] = useState(40);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [projectName, setProjectName] = useState("");
  const projects = useRoughCutProjects();

  // Pointer-drag handlers lag a render, so edits reach through refs and always
  // build on the latest timeline rather than the one they closed over.
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  /** Apply an edit as one undo step. `tag` folds consecutive commits from the
   *  same gesture (a trim drag, a slider sweep) into a single step. */
  const edit = useCallback(
    (
      fn: (clips: RoughCutClip[], sources: Map<string, SourceInfo>) => RoughCutClip[],
      tag?: string
    ) => dispatch({ type: "commit", clips: fn(clipsRef.current, sourcesRef.current), tag }),
    []
  );

  /* ── restore + autosave ──────────────────────────────────────── */

  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const saved = loadCurrent();
    const bin = loadBin();
    if (!saved && bin.length === 0) return;
    (async () => {
      const map = new Map<string, SourceInfo>();
      for (const path of new Set([...bin, ...(saved ?? []).map((c) => c.path)])) {
        try {
          const info = await probeFile(path);
          map.set(path, {
            path,
            durationSecs: info.durationSecs ?? 0,
            mediaType: info.mediaType,
          });
        } catch {
          // Keep the row even when the probe fails: a staged source lives only in
          // the bin, and dropping it here would silently delete the user's shelf.
          // Its clips stay on the timeline as zero-length until the file returns.
          map.set(path, { path, durationSecs: 0, mediaType: "video" });
        }
      }
      setSources(map);
      if (saved) dispatch({ type: "reset", clips: saved });
    })();
  }, []);

  // Autosave trails the edit stream — a trim drag commits on every pointer
  // move — and flushes on unmount so the debounce never eats the last edit.
  useEffect(() => {
    const id = setTimeout(() => saveCurrent(clips), 250);
    return () => clearTimeout(id);
  }, [clips]);

  // The bin is staged material: a source nobody has cut into the timeline yet
  // exists nowhere else, so it is saved on its own.
  useEffect(() => {
    saveBin(Array.from(sources.keys()));
  }, [sources]);

  // An unmount can land mid-debounce; write the latest timeline out then.
  useEffect(() => () => saveCurrent(clipsRef.current), []);

  /* ── sources ─────────────────────────────────────────────────── */

  const addSources = useCallback(
    async (paths: string[]) => {
      const valid = paths.filter((p) => extOk(p, accepts));
      if (valid.length === 0) return;
      setError(null);
      const fresh: SourceInfo[] = [];
      const seen = new Set(sourcesRef.current.keys());
      for (const path of valid) {
        // Picks can repeat a path within one batch, and the sources map only
        // catches up on the next render.
        if (seen.has(path)) continue;
        seen.add(path);
        try {
          const info = await probeFile(path);
          fresh.push({
            path,
            durationSecs: info.durationSecs ?? 0,
            mediaType: info.mediaType,
          });
        } catch (err) {
          setError(t("err.read", { error: String(err) }));
        }
      }
      if (fresh.length === 0) return;
      setSources((prev) => {
        const next = new Map(prev);
        for (const s of fresh) next.set(s.path, s);
        return next;
      });
    },
    [accepts, t]
  );

  useEffect(() => {
    tasks.registerDropHandler((paths) => void addSources(paths));
    return () => tasks.registerDropHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addSources]);

  // Poster thumbnails for the source bin (best effort, one per source).
  useEffect(() => {
    for (const path of sources.keys()) {
      if (thumbs.has(path)) continue;
      const dur = sources.get(path)?.durationSecs ?? null;
      getThumbnail(path, "video", dur)
        .then((url) => {
          if (url) setThumbs((prev) => new Map(prev).set(path, url));
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  /** Cut a whole-file clip out of a bin source and append it to the timeline;
   *  the inspector's buttons then move it wherever it belongs. */
  const insertSource = (path: string) => {
    const src = sources.get(path);
    // A source whose probe never came back has no length to cut a clip from.
    if (!src || src.durationSecs <= 0) return;
    edit((cs) => [...cs, clipForSource(src)]);
    setSelected(clipsRef.current.length);
  };

  const removeSource = async (path: string) => {
    const clipsOfSource = clips.filter((c) => c.path === path).length;
    if (clipsOfSource > 0) {
      const ok = await confirm({
        title: t("rc.removeSourceTitle"),
        message: t("rc.removeSourceMsg", { n: clipsOfSource }),
        danger: true,
      });
      if (!ok) return;
    }
    setSources((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
    setThumbs((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
    edit((cs) => cs.filter((c) => c.path !== path));
    setSelected(null);
  };

  const pick = () =>
    pickPaths({
      multiple: true,
      title: t("rc.addSource"),
      filterName: t("dz.filter.video"),
      extensions: accepts,
    }).then((sel) => void addSources(sel));

  /* ── transport / edit actions ────────────────────────────────── */

  const total = totalDuration(clips, sources);
  const seek = useCallback((secs: number) => setPlayhead(Math.max(0, Math.min(secs, total))), [total]);

  const doSplit = () => {
    const next = splitAt(clips, sources, playhead);
    if (!next) return;
    const at = locate(next, sources, playhead);
    edit(() => next);
    setSelected(at ? at.index : null);
  };

  const doDelete = () => {
    const idx = selected ?? locate(clips, sources, playhead)?.index ?? null;
    if (idx === null) return;
    edit((cs) => removeClip(cs, idx));
    setSelected(null);
  };

  const selectedClip = selected !== null ? clips[selected] : null;
  const patchSelected = (patch: Partial<RoughCutClip>, tag?: string) => {
    if (selected === null) return;
    const idx = selected;
    edit(
      (cs) => (cs[idx] ? cs.map((c, i) => (i === idx ? { ...c, ...patch } : c)) : cs),
      tag
    );
  };

  /** Move the selected clip one slot along the track (see Timeline's note on why
   *  reordering is not a drag). */
  const moveSelected = (delta: number) => {
    if (selected === null) return;
    const to = selected + delta;
    if (to < 0 || to >= clips.length) return;
    edit((cs) => moveClip(cs, selected, to));
    setSelected(to);
  };

  // Keyboard: space play/pause, S split, Del remove, arrows step, Ctrl+Z/Y.
  // The body reads fresh state through a ref so the listener is attached once
  // rather than re-bound on every frame of playback.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  onKeyRef.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
    if (e.key === " ") {
      e.preventDefault();
      setPlaying((p) => !p);
    } else if (e.key === "s" || e.key === "S") {
      doSplit();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      doDelete();
    } else if (e.key === "ArrowLeft") {
      seek(playhead - (e.shiftKey ? 5 : 0.5));
    } else if (e.key === "ArrowRight") {
      seek(playhead + (e.shiftKey ? 5 : 0.5));
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      dispatch({ type: e.shiftKey ? "redo" : "undo" });
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      dispatch({ type: "redo" });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ── export ──────────────────────────────────────────────────── */

  const doExport = (params: RoughCutParams) => void tasks.startRoughCut(params);

  const job = useMemo(() => {
    return tasks.jobs
      .filter(
        (j) =>
          j.toolId === TOOL &&
          (j.phase === "running" || j.phase === "queued" || j.phase === "done" || j.phase === "error")
      )
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  }, [tasks.jobs]);

  const canEdit = clips.length > 0;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-2.5">
      {/* header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-neutral-800 dark:text-neutral-100">
            <TimelineIcon className="h-4.5 w-4.5 text-brand-500" />
            {t("tool.roughcut.name")}
          </h2>
          <p className="text-xs text-neutral-400 dark:text-neutral-500">{t("tool.roughcut.desc")}</p>
        </div>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            <span className="h-3 w-3" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </span>
            {t("module.back")}
          </button>
        )}
      </div>

      {/* source bin and preview share one row: the bin is a column, and the
          preview only takes the width left over, so it never letterboxes */}
      <div className="flex items-stretch gap-2.5">
        <div className="flex w-52 shrink-0 flex-col gap-1 rounded-lg bg-white p-1.5 ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
          <div className="flex min-h-0 flex-1 flex-col divide-y divide-neutral-100 overflow-y-auto dark:divide-neutral-800">
            {sources.size === 0 && (
              <p className="px-1 py-2 text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">
                {t("rc.binEmpty")}
              </p>
            )}
            {Array.from(sources.values()).map((s) => (
              <div
                key={s.path}
                className="flex shrink-0 items-center gap-1.5 py-1 pl-1"
              >
                {thumbs.get(s.path) ? (
                  <img src={thumbs.get(s.path)} alt="" className="h-7 w-12 shrink-0 rounded-sm object-cover" />
                ) : (
                  <div className="h-7 w-12 shrink-0 rounded-sm bg-neutral-200 dark:bg-neutral-700" />
                )}
                <div className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-[11px] text-neutral-700 dark:text-neutral-200">
                    {sourceName(s.path)}
                  </span>
                  <span className="text-[10px] tabular-nums text-neutral-400">
                    {formatTime(s.durationSecs)}
                  </span>
                </div>
                <button
                  type="button"
                  title={t("rc.addToTimeline")}
                  aria-label={t("rc.addToTimeline")}
                  disabled={s.durationSecs <= 0}
                  onClick={() => insertSource(s.path)}
                  className="shrink-0 rounded p-0.5 text-neutral-400 transition hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-brand-400"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => void removeSource(s.path)}
                  className="shrink-0 rounded p-0.5 text-neutral-400 transition hover:text-error-500"
                  aria-label={t("job.remove")}
                >
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={pick}
            className="shrink-0 rounded-md border border-dashed border-neutral-300 px-2 py-1.5 text-xs font-medium text-neutral-500 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-600 dark:border-neutral-600 dark:text-neutral-400 dark:hover:border-brand-700 dark:hover:bg-brand-950/30 dark:hover:text-brand-300"
          >
            + {t("rc.addSource")}
          </button>
        </div>

        <div className="relative aspect-video max-h-[46vh] min-w-0 flex-1 overflow-hidden rounded-lg bg-black ring-1 ring-neutral-200 dark:ring-neutral-800">
          <Player
            clips={clips}
            sources={sources}
            playhead={playhead}
            playing={playing}
            muted={muted}
            onPlayhead={setPlayhead}
            onPlayState={setPlaying}
          />
          {clips.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
              <p className="text-sm text-neutral-300">{t("rc.empty")}</p>
              <p className="text-xs text-neutral-500">{t("rc.emptyHint")}</p>
            </div>
          )}
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-error-50 px-3 py-1.5 text-xs text-error-600 dark:bg-error-950/40 dark:text-error-400">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1">
        <TransportButton
          label={playing ? t("rc.pause") : t("rc.play")}
          onClick={() => setPlaying((p) => !p)}
          disabled={!canEdit}
        >
          {playing ? (
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <PlayIcon className="h-3.5 w-3.5" />
          )}
        </TransportButton>
        <span className="mx-1 min-w-28 text-center text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
          {formatTime(playhead)} / {formatTime(total)}
        </span>
        <TransportButton label={t("rc.split")} onClick={doSplit} disabled={!canEdit}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M12 3v18" />
            <path d="m8 7-4 5 4 5M16 7l4 5-4 5" />
          </svg>
        </TransportButton>
        <TransportButton label={t("rc.delete")} onClick={doDelete} disabled={!canEdit}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
          </svg>
        </TransportButton>
        <TransportButton
          label={t("rc.undo")}
          onClick={() => dispatch({ type: "undo" })}
          disabled={state.past.length === 0}
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h11a5 5 0 0 1 0 10h-4" />
          </svg>
        </TransportButton>
        <TransportButton
          label={t("rc.redo")}
          onClick={() => dispatch({ type: "redo" })}
          disabled={state.future.length === 0}
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 14 5-5-5-5" />
            <path d="M20 9H9a5 5 0 0 0 0 10h4" />
          </svg>
        </TransportButton>
        <div className="ml-auto flex items-center gap-2">
          {/* mp-range pins width:100%, so the fixed width lives on the wrapper */}
          <span className="w-24">
            <input
              type="range"
              min={0}
              max={100}
              step={0.5}
              value={zoomToSlider(pxPerSec)}
              onChange={(e) => setPxPerSec(sliderToZoom(Number(e.target.value)))}
              style={rangeFill(zoomToSlider(pxPerSec), 0, 100)}
              title={t("rc.zoom")}
              aria-label={t("rc.zoom")}
              className="mp-range"
            />
          </span>
          <TransportButton
            label={muted ? t("rc.unmutePreview") : t("rc.mutePreview")}
            onClick={() => setMuted((m) => !m)}
          >
            {muted ? <MuteIcon className="h-3.5 w-3.5" /> : <VolumeIcon className="h-3.5 w-3.5" />}
          </TransportButton>
        </div>
      </div>

      <Timeline
        clips={clips}
        sources={sources}
        playhead={playhead}
        pxPerSec={pxPerSec}
        selected={selected}
        onSeek={seek}
        onSelect={setSelected}
        onTrim={(idx, edge, secs) =>
          edit((cs, ss) => trimEdge(cs, ss, idx, edge, secs), `trim:${idx}:${edge}`)
        }
      />

      {/* one card, divided: clip inspector, export controls, projects, status */}
      <div className="divide-y divide-neutral-100 rounded-lg bg-white ring-1 ring-neutral-200 dark:divide-neutral-800 dark:bg-neutral-900 dark:ring-neutral-800">
        {selectedClip && (
          <div className="flex flex-col gap-2 px-3 py-2.5">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-neutral-700 dark:text-neutral-200">
                {t("rc.clipN", { n: (selected ?? 0) + 1 })} · {sourceName(selectedClip.path)}
              </span>
              <TransportButton
                label={t("rc.moveLeft")}
                onClick={() => moveSelected(-1)}
                disabled={(selected ?? 0) === 0}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m14 6-6 6 6 6" />
                </svg>
              </TransportButton>
              <TransportButton
                label={t("rc.moveRight")}
                onClick={() => moveSelected(1)}
                disabled={selected === null || selected >= clips.length - 1}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m10 6 6 6-6 6" />
                </svg>
              </TransportButton>
            </div>
            {/* one row for the clip, the rest for its parameters — the fields
                share grid columns so labels and controls line up */}
            <div className="grid grid-cols-2 items-center gap-x-4 gap-y-2 md:grid-cols-3">
              <Field label={t("rc.inPoint")}>
                <NumInput
                  value={Number(selectedClip.startTime.toFixed(2))}
                  min={0}
                  step={0.1}
                  onChange={(v) =>
                    patchSelected({
                      // Never let the two points cross: the backend rejects an
                      // empty window, and the timeline would invert.
                      startTime: Math.min(
                        Math.max(v ?? 0, 0),
                        Math.max(0, sourceEnd(selectedClip, sources) - MIN_SLICE)
                      ),
                    })
                  }
                />
              </Field>
              <Field label={t("rc.outPoint")}>
                <NumInput
                  value={Number(sourceEnd(selectedClip, sources).toFixed(2))}
                  min={0}
                  step={0.1}
                  onChange={(v) => {
                    const srcDur = sources.get(selectedClip.path)?.durationSecs ?? 0;
                    patchSelected({
                      endTime: Math.max(
                        Math.min(v ?? 0, srcDur || (v ?? 0)),
                        selectedClip.startTime + MIN_SLICE
                      ),
                    });
                  }}
                />
              </Field>
              <Field label={t("rc.speed")}>
                <Select
                  className="w-full"
                  value={String(selectedClip.speed ?? 1)}
                  onChange={(v) => patchSelected({ speed: Number(v) })}
                >
                  {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((r) => (
                    <option key={r} value={r}>
                      {r}×
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("rc.volume")}>
                {/* a muted clip exports no audio at all, so its level is dead weight */}
                <span
                  className={`flex items-center gap-1.5 ${
                    selectedClip.mute ? "opacity-40" : ""
                  }`}
                >
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={selectedClip.volume ?? 1}
                    disabled={!!selectedClip.mute}
                    style={rangeFill(selectedClip.volume ?? 1, 0, 2)}
                    onChange={(e) =>
                      patchSelected({ volume: Number(e.target.value) }, `vol:${selected}`)
                    }
                    className="mp-range min-w-0 flex-1"
                  />
                  <span className="shrink-0 text-xs tabular-nums text-neutral-400">
                    {(selectedClip.volume ?? 1).toFixed(1)}×
                  </span>
                </span>
              </Field>
              <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
                <Checkbox
                  checked={!!selectedClip.mute}
                  onChange={(v) => patchSelected({ mute: v })}
                />
                {t("rc.mute")}
              </label>
            </div>
          </div>
        )}

        <ExportBar clips={clips} sources={sources} gpuInfo={tasks.gpuInfo} disabled={false} onExport={doExport} />

        {/* project save / load */}
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
          <input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder={t("rc.projectName")}
            className="w-36 rounded-md bg-neutral-50 px-2 py-1 text-xs text-neutral-700 ring-1 ring-neutral-200 focus:outline-none focus:ring-brand-400 dark:bg-neutral-800 dark:text-neutral-200 dark:ring-neutral-700"
          />
          <button
            type="button"
            disabled={!projectName.trim() || clips.length === 0}
            onClick={() => {
              saveProject(projectName.trim(), clips);
              setProjectName("");
            }}
            className="rounded-md border border-neutral-200 px-2 py-1 font-medium text-neutral-600 transition hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {t("rc.projectSave")}
          </button>
          {projects.map((p) => (
            <span key={p.id} className="flex items-center gap-1 rounded-md bg-neutral-50 py-0.5 pl-2 pr-0.5 ring-1 ring-neutral-200 dark:bg-neutral-800 dark:ring-neutral-700">
              <button
                type="button"
                title={t("rc.projectLoad")}
                onClick={() => {
                  // Register placeholders for unknown sources immediately, then
                  // probe each one in the background for its real duration.
                  const missing = Array.from(
                    new Set(p.clips.map((c) => c.path))
                  ).filter((path) => !sources.has(path));
                  if (missing.length > 0) {
                    setSources((prev) => {
                      const next = new Map(prev);
                      for (const path of missing) {
                        next.set(path, { path, durationSecs: 0, mediaType: "video" });
                      }
                      return next;
                    });
                    for (const path of missing) {
                      probeFile(path)
                        .then((info) =>
                          setSources((m) => {
                            const mm = new Map(m);
                            mm.set(path, {
                              path,
                              durationSecs: info.durationSecs ?? 0,
                              mediaType: info.mediaType,
                            });
                            return mm;
                          })
                        )
                        .catch(() => {});
                    }
                  }
                  dispatch({ type: "reset", clips: p.clips });
                  setPlayhead(0);
                  setSelected(null);
                }}
                className="font-medium text-neutral-600 transition hover:text-brand-600 dark:text-neutral-300 dark:hover:text-brand-400"
              >
                {p.name}
              </button>
              <button
                type="button"
                onClick={() => removeProject(p.id)}
                className="rounded p-0.5 text-neutral-400 transition hover:text-error-500"
                aria-label={t("rc.projectDelete")}
              >
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </span>
          ))}
        </div>

        {/* export status */}
        {job && (
          <div className="px-3 py-2.5">
            {job.phase === "running" && (
              <div>
                <div className="mb-1.5 flex items-center gap-2 text-sm text-brand-600 dark:text-brand-400">
                  <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                  {t("rc.exporting")} {job.percent.toFixed(0)}%
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                  <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${job.percent}%` }} />
                </div>
                <button
                  type="button"
                  onClick={() => job.rustId && tasks.cancelOne(job.uiId)}
                  className="mt-1.5 text-xs text-neutral-400 underline-offset-2 hover:text-error-500 hover:underline"
                >
                  {t("confirm.cancel")}
                </button>
              </div>
            )}
            {job.phase === "done" && job.output && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-success-700 dark:text-success-400">{t("rc.exportDone")}</span>
                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      clearCurrent();
                      dispatch({ type: "reset", clips: [] });
                      setPlayhead(0);
                      setSelected(null);
                      setSources(new Map());
                      setThumbs(new Map());
                    }}
                    className="rounded-md bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700"
                  >
                    {t("rc.newTimeline")}
                  </button>
                  {canRevealInFolder && (
                    <button
                      onClick={() => openOutputFolder(job.output!)}
                      className="rounded-md bg-white px-2.5 py-1 text-xs font-medium text-brand-700 ring-1 ring-brand-200 dark:bg-neutral-800 dark:text-brand-300 dark:ring-neutral-700"
                    >
                      {t("job.open")}
                    </button>
                  )}
                </span>
              </div>
            )}
            {job.phase === "error" && (
              <span className="text-sm text-error-600 dark:text-error-400">{job.error}</span>
            )}
          </div>
        )}
      </div>

      {/* Encoding rationale reads as a footnote, so it sits under the whole
          workbench rather than pushing the preview down. */}
      <div className="space-y-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        <p className="font-medium text-neutral-600 dark:text-neutral-300">{t("rc.whyTitle")}</p>
        <p>{t("rc.whyLead")}</p>
        <p>· {t("rc.whyCopy")}</p>
        <p>· {t("rc.whyEncode")}</p>
        <p>{t("rc.whyTail")}</p>
      </div>
      {dialog}
    </div>
  );
}

function TransportButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-md bg-white text-neutral-500 ring-1 ring-neutral-200 transition hover:bg-neutral-50 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-900 dark:text-neutral-400 dark:ring-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-brand-400"
    >
      {children}
    </button>
  );
}
