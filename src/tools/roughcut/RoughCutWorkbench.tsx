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
import {
  TimelineIcon,
  PlayIcon,
  SpinnerIcon,
  MuteIcon,
  VolumeIcon,
  FolderIcon,
  CheckIcon,
  InfoIcon,
} from "../../components/icons";
import { ConfigSidebar, SidebarSection } from "../../download/Sidebar";
import { Checkbox, Field, NumInput } from "../panels/ui";
import InspectReport from "../panels/InspectPanel";
import Select from "../../components/Select";
import type { MediaReport, RoughCutClip, RoughCutParams } from "../../types";
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
import { inspectCached } from "./compat";
import { clearCurrent, loadBin, loadCurrent, removeProject, saveBin, saveCurrent, saveProject, useRoughCutProjects, type RoughCutProject } from "./store";
import Timeline from "./Timeline";
import Player from "./Player";
import ExportBar from "./ExportBar";

const TOOL = "roughcut" as const;

function sourceName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// 0.05 px/s = one pixel per 20s, so even hours-long footage fits the viewport
// without scrolling; the ruler coarsens its ticks (up to 30/60-min) to match.
const ZOOM_MIN = 0.05;
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
  // 1 px/s centres the thumb on the log slider (~36% between 0.05 and 200).
  const [pxPerSec, setPxPerSec] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [projectName, setProjectName] = useState("");
  // Timeline as it was last written to a named project; `null` means the
  // autosaved timeline was never saved under a name. Compared as JSON because
  // the reducer replaces the clip array on every edit.
  const [savedShape, setSavedShape] = useState<string | null>(null);
  // The finished job lingers in the task center, so "new edit" dismisses the
  // done banner locally; the next run un-dismisses it.
  const [doneDismissed, setDoneDismissed] = useState(false);
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

  /* ── projects ────────────────────────────────────────────────── */

  /** The name is a project's identity: `saveProject` upserts by it, so the field
   *  also says which chip in the list the timeline came from. */
  const trimmedName = projectName.trim();
  const namedProject = projects.find((p) => p.name === trimmedName) ?? null;
  const unsavedEdits = useMemo(
    () => clips.length > 0 && JSON.stringify(clips) !== savedShape,
    [clips, savedShape]
  );

  const commitProject = () => {
    if (!trimmedName || clips.length === 0) return;
    saveProject(trimmedName, clips);
    setSavedShape(JSON.stringify(clips));
  };

  const openProject = async (p: RoughCutProject) => {
    // `reset` drops the undo stack and the autosave overwrites the restored
    // timeline, so unsaved work is gone for good — ask before replacing it.
    if (unsavedEdits) {
      const ok = await confirm({
        title: t("rc.projectOpenTitle"),
        message: t("rc.projectOpenMsg", { name: p.name }),
        danger: true,
      });
      if (!ok) return;
    }
    // Register placeholders for unknown sources immediately, then
    // probe each one in the background for its real duration.
    const missing = Array.from(new Set(p.clips.map((c) => c.path))).filter(
      (path) => !sources.has(path)
    );
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
    setProjectName(p.name);
    setSavedShape(JSON.stringify(p.clips));
  };

  const dropProject = async (p: RoughCutProject) => {
    const ok = await confirm({
      title: t("rc.projectDeleteTitle"),
      message: t("rc.projectDeleteMsg", { name: p.name }),
      danger: true,
    });
    if (!ok) return;
    removeProject(p.id);
    if (p.name === trimmedName) setProjectName("");
  };

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

  // A fresh run brings the banner back after a dismissal.
  useEffect(() => {
    if (job?.phase === "running" || job?.phase === "queued") setDoneDismissed(false);
  }, [job?.phase]);

  const canEdit = clips.length > 0;

  /** The file the spec panel describes: the selected clip's source, else the
   *  clip under the playhead, else the lone staged source. */
  const activeIdx = selected ?? locate(clips, sources, playhead)?.index;
  const metaSource =
    (activeIdx !== undefined ? sources.get(clips[activeIdx]?.path ?? "") : undefined) ??
    (sources.size === 1 ? Array.from(sources.values())[0] : undefined) ??
    null;

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-2.5">
      {/* header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-neutral-800 dark:text-neutral-100">
            <TimelineIcon className="h-4.5 w-4.5 text-brand-500" />
            {t("tool.roughcut.name")}
            <WhyNote />
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

      <div className="flex flex-col gap-2.5 lg:flex-row lg:items-start">
        {/* Both shelves live in one rail, so the rail is only as tall as its
            content — stretching a source bin to the height of the whole editor
            left the bottom two-thirds of it empty. */}
        <ConfigSidebar>
          <SidebarSection title={t("rc.binTitle")}>
            <div className="max-h-[34vh] divide-y divide-neutral-100 overflow-y-auto dark:divide-neutral-800">
              {sources.size === 0 && (
                <p className="py-1 text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">
                  {t("rc.binEmpty")}
                </p>
              )}
              {Array.from(sources.values()).map((s) => (
                <div key={s.path} className="flex items-center gap-0.5">
                  {/* the whole row is the action: a separate ＋ beside it only
                      competed with the row itself */}
                  <button
                    type="button"
                    title={t("rc.addToTimeline")}
                    disabled={s.durationSecs <= 0}
                    onClick={() => insertSource(s.path)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-1 text-left transition hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-brand-950/30"
                  >
                    {thumbs.get(s.path) ? (
                      <img src={thumbs.get(s.path)} alt="" className="h-7 w-12 shrink-0 rounded-sm object-cover" />
                    ) : (
                      <div className="h-7 w-12 shrink-0 rounded-sm bg-neutral-200 dark:bg-neutral-700" />
                    )}
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-[11px] text-neutral-700 dark:text-neutral-200">
                        {sourceName(s.path)}
                      </span>
                      <span className="text-[10px] tabular-nums text-neutral-400">
                        {formatTime(s.durationSecs)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeSource(s.path)}
                    className="shrink-0 rounded p-1 text-neutral-400 transition hover:text-error-500"
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
              className="w-full rounded-md border border-dashed border-neutral-300 px-2 py-1.5 text-xs font-medium text-neutral-500 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-600 dark:border-neutral-600 dark:text-neutral-400 dark:hover:border-brand-700 dark:hover:bg-brand-950/30 dark:hover:text-brand-300"
            >
              {t("rc.addSource")}
            </button>
          </SidebarSection>

          <SidebarSection
            title={t("rc.projectTitle")}
            collapsible
            defaultOpen={false}
            summary={projects.length > 0 ? t("rc.projectCount", { n: projects.length }) : undefined}
          >
            {/* A ring paints outside the border box, which a collapsible
                section's overflow clips — hence the border on this field. */}
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && commitProject()}
              placeholder={t("rc.projectName")}
              className="w-full rounded-lg border border-neutral-200 bg-white px-2 py-1 text-[11px] text-neutral-700 placeholder:text-neutral-400 transition focus:border-brand-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:focus:border-brand-500"
            />
            <button
              type="button"
              disabled={!trimmedName || clips.length === 0}
              title={clips.length === 0 ? t("rc.projectSaveEmpty") : undefined}
              onClick={commitProject}
              className="w-full rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {namedProject ? t("rc.projectUpdate") : t("rc.projectSave")}
            </button>
            {projects.length > 0 && (
              <div className="max-h-44 space-y-1 overflow-y-auto">
                {projects.map((p) => (
                  /* Highlighted while the field holds its name — the project
                     the timeline was opened from, and what saving writes back. */
                  <span
                    key={p.id}
                    className={`flex items-center gap-1 rounded-md border py-0.5 pl-2 pr-0.5 text-[11px] ${
                      p.name === trimmedName
                        ? "border-brand-300 bg-brand-50 dark:border-brand-700 dark:bg-brand-950/30"
                        : "border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800"
                    }`}
                  >
                    <button
                      type="button"
                      title={t("rc.projectLoad")}
                      onClick={() => void openProject(p)}
                      className="min-w-0 flex-1 truncate text-left font-medium text-neutral-600 transition hover:text-brand-600 dark:text-neutral-300 dark:hover:text-brand-400"
                    >
                      {p.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => void dropProject(p)}
                      className="shrink-0 rounded p-0.5 text-neutral-400 transition hover:text-error-500"
                      aria-label={t("rc.projectDelete")}
                    >
                      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M6 6l12 12M18 6 6 18" />
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
            )}
          </SidebarSection>
        </ConfigSidebar>

        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          {/* A 16:9 picture capped at 42vh tall is 74.67vh wide, so the player
              keeps that as its own width instead of padding out a full-width
              card with black — plus a little, since the spec sheet reads better
              one notch narrower. The leftover width goes to that sheet; this row
              still spans the column, which keeps every card below it aligned on
              both edges. */}
          <div className="grid grid-cols-1 items-stretch gap-2.5 lg:grid-cols-[minmax(0,calc(74.67vh+2.5rem))_minmax(13.5rem,1fr)]">
            <div className="mx-auto w-full max-w-[calc(74.67vh+2.5rem)] overflow-hidden rounded-lg bg-black ring-1 ring-neutral-200 dark:ring-neutral-800">
              <div className="relative aspect-video w-full">
                <Player
                  clips={clips}
                  sources={sources}
                  playhead={playhead}
                  playing={playing}
                  muted={muted}
                  onPlayhead={setPlayhead}
                  onPlayState={setPlaying}
                  onLoadError={(f) => setError(f ? t("rc.previewError") : null)}
                />
                {clips.length === 0 && (
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
                    <p className="text-sm text-neutral-300">{t("rc.empty")}</p>
                    <p className="text-xs text-neutral-500">{t("rc.emptyHint")}</p>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 border-t border-white/10 px-1.5 py-1">
                <TransportButton tone="dark" label={t("rc.back10")} onClick={() => seek(playhead - 10)} disabled={!canEdit}>
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                    <path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z" />
                  </svg>
                </TransportButton>
                <TransportButton
                  tone="dark"
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
                <TransportButton tone="dark" label={t("rc.fwd10")} onClick={() => seek(playhead + 10)} disabled={!canEdit}>
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                    <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
                  </svg>
                </TransportButton>
                <span className="mx-1 min-w-28 text-center text-xs tabular-nums text-neutral-300">
                  {formatTime(playhead)} / {formatTime(total)}
                </span>
                <span className="ml-auto">
                  <TransportButton
                    tone="dark"
                    label={muted ? t("rc.unmutePreview") : t("rc.mutePreview")}
                    onClick={() => setMuted((m) => !m)}
                  >
                    {muted ? <MuteIcon className="h-3.5 w-3.5" /> : <VolumeIcon className="h-3.5 w-3.5" />}
                  </TransportButton>
                </span>
              </div>
            </div>

            <SourceMeta path={metaSource?.path ?? null} />
          </div>

          {error && (
            <p className="rounded-md bg-error-50 px-3 py-1.5 text-xs text-error-600 dark:bg-error-950/40 dark:text-error-400">
              {error}
            </p>
          )}

          {/* the edit toolbar rides the track it acts on, and so does zoom */}
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
            header={
              <>
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
                <span className="mx-1 h-4 w-px bg-neutral-200 dark:bg-neutral-700" aria-hidden />
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
                <span className="ml-auto flex items-center gap-1.5 pr-0.5">
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-neutral-400" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5M8 11h6M11 8v6" />
                  </svg>
                  {/* mp-range pins width:100%, so the fixed width lives on this
                      wrapper — and the wrapper has to be a flex box, or the
                      slider sits on the text baseline instead of centring on the
                      row and lands a few pixels off the icon. */}
                  <span className="flex w-24 items-center">
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
                </span>
              </>
            }
          />

          <div className="divide-y divide-neutral-100 rounded-lg bg-white ring-1 ring-neutral-200 dark:divide-neutral-800 dark:bg-neutral-900 dark:ring-neutral-800">
            {selectedClip && selected !== null && (
              <ClipInspector
                clip={selectedClip}
                index={selected}
                count={clips.length}
                sources={sources}
                onPatch={patchSelected}
                onMove={moveSelected}
              />
            )}

            <ExportBar clips={clips} sources={sources} gpuInfo={tasks.gpuInfo} disabled={false} onExport={doExport} />

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
                {job.phase === "done" && job.output && !doneDismissed && (
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-sm text-success-700 dark:text-success-400">
                        <CheckIcon className="h-4 w-4" />
                        {t("rc.exportDone")}
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                        {t("rc.exportDoneHint")}
                      </p>
                    </div>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          clearCurrent();
                          dispatch({ type: "reset", clips: [] });
                          setPlayhead(0);
                          setSelected(null);
                          setSources(new Map());
                          setThumbs(new Map());
                          setProjectName("");
                          setSavedShape(null);
                          setDoneDismissed(true);
                        }}
                        className="rounded-md bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700"
                      >
                        {t("rc.newTimeline")}
                      </button>
                      {canRevealInFolder && (
                        <button
                          type="button"
                          title={t("job.open")}
                          aria-label={t("job.open")}
                          onClick={() => openOutputFolder(job.output!)}
                          className="rounded-md bg-white p-1.5 text-neutral-600 ring-1 ring-neutral-200 transition hover:text-brand-600 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700 dark:hover:text-brand-400"
                        >
                          <FolderIcon className="h-3.5 w-3.5" />
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
        </div>
      </div>
      {dialog}
    </div>
  );
}

/** The selected clip's parameters, as a section of the card under the timeline.
 *  The fields share grid columns so labels and controls line up. */
function ClipInspector({
  clip,
  index,
  count,
  sources,
  onPatch,
  onMove,
}: {
  clip: RoughCutClip;
  index: number;
  count: number;
  sources: Map<string, SourceInfo>;
  onPatch: (patch: Partial<RoughCutClip>, tag?: string) => void;
  onMove: (delta: number) => void;
}) {
  const { t } = useI18n();
  const end = sourceEnd(clip, sources);
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-neutral-700 dark:text-neutral-200">
          {t("rc.clipN", { n: index + 1 })} · {sourceName(clip.path)}
        </span>
        <TransportButton label={t("rc.moveLeft")} onClick={() => onMove(-1)} disabled={index === 0}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m14 6-6 6 6 6" />
          </svg>
        </TransportButton>
        <TransportButton
          label={t("rc.moveRight")}
          onClick={() => onMove(1)}
          disabled={index >= count - 1}
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m10 6 6 6-6 6" />
          </svg>
        </TransportButton>
      </div>

      <div className="grid grid-cols-2 items-center gap-x-4 gap-y-2 md:grid-cols-3">
        <Field label={t("rc.inPoint")}>
          <NumInput
            value={Number(clip.startTime.toFixed(2))}
            min={0}
            step={0.1}
            onChange={(v) =>
              onPatch({
                // Never let the two points cross: the backend rejects an
                // empty window, and the timeline would invert.
                startTime: Math.min(Math.max(v ?? 0, 0), Math.max(0, end - MIN_SLICE)),
              })
            }
          />
        </Field>
        <Field label={t("rc.outPoint")}>
          <NumInput
            value={Number(end.toFixed(2))}
            min={0}
            step={0.1}
            onChange={(v) => {
              const srcDur = sources.get(clip.path)?.durationSecs ?? 0;
              onPatch({
                endTime: Math.max(Math.min(v ?? 0, srcDur || (v ?? 0)), clip.startTime + MIN_SLICE),
              });
            }}
          />
        </Field>
        <Field label={t("rc.speed")}>
          <Select
            className="w-full"
            value={String(clip.speed ?? 1)}
            onChange={(v) => onPatch({ speed: Number(v) })}
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
          <span className={`flex items-center gap-1.5 ${clip.mute ? "opacity-40" : ""}`}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={clip.volume ?? 1}
              disabled={!!clip.mute}
              style={rangeFill(clip.volume ?? 1, 0, 1)}
              onChange={(e) => onPatch({ volume: Number(e.target.value) }, `vol:${index}`)}
              className="mp-range min-w-0 flex-1"
            />
            <span className="shrink-0 text-xs tabular-nums text-neutral-400">
              {(clip.volume ?? 1).toFixed(1)}×
            </span>
          </span>
        </Field>
        <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
          <Checkbox checked={!!clip.mute} onChange={(v) => onPatch({ mute: v })} />
          {t("rc.mute")}
        </label>
      </div>
    </div>
  );
}

/** The file being previewed, described in full: the same report the 格式体检
 *  tool renders, served from the concat check's probe cache so a source on the
 *  timeline costs no extra ffprobe. Scrolls inside the player's height. */
function SourceMeta({ path }: { path: string | null }) {
  const { t } = useI18n();
  const [report, setReport] = useState<MediaReport | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setReport(null);
    setFailed(false);
    if (!path) return;
    inspectCached(path)
      .then((r) => {
        if (active) setReport(r);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [path]);

  return (
    /* Absolutely positioned inside a zero-content wrapper: as a normal grid
     * item the report would set the row's height and the player card beside it
     * would stretch — a slab of black under the picture. This way the player
     * owns the height and the report scrolls inside it. */
    <div className="relative min-h-56 min-w-0 lg:min-h-0">
      <div className="absolute inset-0 flex min-h-0 flex-col overflow-hidden rounded-lg bg-white ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
        <div className="flex items-baseline gap-2 border-b border-neutral-100 px-3 py-1.5 dark:border-neutral-800">
          <span className="shrink-0 text-[11px] font-medium text-neutral-500 dark:text-neutral-500">
            {t("rc.metaTitle")}
          </span>
          <span
            className="min-w-0 truncate text-xs text-neutral-600 dark:text-neutral-400"
            title={path ?? undefined}
          >
            {path ? sourceName(path) : "—"}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!path ? (
            <p className="px-3 py-2 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-500">
              {t("rc.meta.empty")}
            </p>
          ) : failed ? (
            <p className="px-3 py-2 text-[11px] text-error-600 dark:text-error-400">
              {t("stripmd.error")}
            </p>
          ) : report ? (
            <InspectReport report={report} flat />
          ) : (
            <p className="px-3 py-2 text-[11px] text-neutral-500 dark:text-neutral-500">
              {t("stripmd.loading")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** The encoding rationale is a footnote, so it hides behind an ⓘ on the title
 *  rather than costing the workbench a permanent line below the fold. */
function WhyNote() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={t("rc.whyTitle")}
        aria-label={t("rc.whyTitle")}
        className={`flex h-5 w-5 items-center justify-center rounded-full transition ${
          open
            ? "bg-neutral-100 text-brand-600 dark:bg-neutral-800 dark:text-brand-400"
            : "text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        }`}
      >
        <InfoIcon className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-30" aria-hidden onClick={() => setOpen(false)} />
          <span
            role="dialog"
            aria-label={t("rc.whyTitle")}
            className="absolute left-0 top-7 z-40 w-[min(560px,78vw)] rounded-xl bg-white p-3 text-[11px] leading-relaxed text-neutral-600 shadow-xl ring-1 ring-neutral-200 dark:bg-neutral-900 dark:text-neutral-300 dark:ring-neutral-800"
          >
            <span className="mb-1.5 block text-xs font-semibold text-neutral-800 dark:text-neutral-100">
              {t("rc.whyTitle")}
            </span>
            <span className="block space-y-1.5">
              <span className="block">{t("rc.whyLead")}</span>
              <span className="block">· {t("rc.whyCopy")}</span>
              <span className="block">· {t("rc.whyEncode")}</span>
              <span className="block">{t("rc.whyTail")}</span>
            </span>
          </span>
        </>
      )}
    </span>
  );
}

function TransportButton({
  label,
  onClick,
  disabled,
  tone = "light",
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** `dark` sits on the black player chrome instead of a card. */
  tone?: "light" | "dark";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition disabled:cursor-not-allowed disabled:opacity-40 ${
        tone === "dark"
          ? "text-neutral-300 hover:bg-white/10 hover:text-white"
          : "bg-white text-neutral-500 ring-1 ring-neutral-200 hover:bg-neutral-50 hover:text-brand-600 dark:bg-neutral-900 dark:text-neutral-400 dark:ring-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-brand-400"
      }`}
    >
      {children}
    </button>
  );
}
