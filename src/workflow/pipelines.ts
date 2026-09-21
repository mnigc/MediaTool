import { useSyncExternalStore } from "react";
import type { WorkflowStepInput } from "../types";
import { CRF } from "../lib/quality";
import {
  PLAYER_PREVIEW_CONTACT_PARAMS,
} from "../lib/presets";
import { readStorage, writeStorage } from "../lib/storage";

/** A named processing pipeline: an ordered list of tool steps whose outputs
 *  chain into each other. Pipelines are the single shared vocabulary for
 *  "what to run after something finishes" — the workflow builder saves and
 *  loads them, downloads/recordings bind one as post-processing, and
 *  task-center jobs can run one when the encode completes. */
export interface Pipeline {
  id: string;
  /** Display name; builtins resolve through i18n via `nameKey`, customs keep
   *  the name the user typed. */
  name: string;
  /** i18n key of the display name (builtins only). */
  nameKey?: string;
  /** i18n key of a one-line explanation (chip tooltip / summary detail). */
  descKey?: string;
  steps: WorkflowStepInput[];
  builtin: boolean;
  createdAt: number;
}

/* ── Builtin pipelines ─────────────────────────────────────────── */
/* The download/record post-processing presets, migrated here so the same
 * definitions serve every consumer. */

type BuiltinSpec = Omit<Pipeline, "builtin" | "createdAt">;

export const BUILTIN_PIPELINES: BuiltinSpec[] = [
  {
    id: "remux",
    name: "无损封装 MP4",
    nameKey: "dl.pipeline.remux",
    descKey: "dl.pipeline.remux.desc",
    // Stream-copy into MP4: zero quality loss and near-instant. Requires the
    // source to already carry mp4-compatible codecs (H.264 + AAC).
    steps: [
      {
        toolId: "video-compress",
        params: {
          videoCodec: "copy",
          qualityMode: "crf",
          resolution: "original",
          audioCodec: "copy",
          format: "mp4",
          preset: "medium",
        },
      },
    ],
  },
  {
    id: "transcode",
    name: "转码 MP4",
    nameKey: "dl.pipeline.transcode",
    descKey: "dl.pipeline.transcode.desc",
    steps: [
      {
        toolId: "video-compress",
        params: {
          videoCodec: "libx264",
          qualityMode: "crf",
          crf: CRF.balanced,
          resolution: "original",
          audioCodec: "aac",
          audioBitrateKbps: 192,
          format: "mp4",
          preset: "medium",
        },
      },
    ],
  },
  {
    id: "compress",
    name: "高压缩（H.264）",
    nameKey: "dl.pipeline.compress",
    descKey: "dl.pipeline.compress.desc",
    steps: [
      {
        toolId: "video-compress",
        params: {
          videoCodec: "libx264",
          qualityMode: "crf",
          crf: CRF.compact,
          resolution: "original",
          audioCodec: "aac",
          audioBitrateKbps: 128,
          format: "source",
          preset: "medium",
        },
      },
    ],
  },
  {
    id: "sprite",
    name: "雪碧图",
    nameKey: "dl.pipeline.sprite",
    descKey: "dl.pipeline.sprite.desc",
    // Same recipe as the "播放器预览" builtin preset — shared constant.
    steps: [
      {
        toolId: "video-contact",
        params: { ...PLAYER_PREVIEW_CONTACT_PARAMS },
      },
    ],
  },
  {
    id: "audio",
    name: "提取音频",
    nameKey: "dl.pipeline.audio",
    descKey: "dl.pipeline.audio.desc",
    steps: [
      {
        toolId: "extract-audio",
        params: { format: "mp3", bitrateKbps: 192 },
      },
    ],
  },
];

/* ── Store ─────────────────────────────────────────────────────── */
/* Same pattern as the preset store: builtins are computed, customs persist in
 * localStorage, and every consumer subscribes to one snapshot. */

const KEY = "mediatool.pipelines";

function loadCustoms(): Pipeline[] {
  try {
    const raw = readStorage(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return (arr as Pipeline[]).filter(
      (p) =>
        p &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        Array.isArray(p.steps)
    );
  } catch {
    return [];
  }
}

function saveCustoms(customs: Pipeline[]): void {
  writeStorage(KEY, JSON.stringify(customs));
}

function builtinList(): Pipeline[] {
  return BUILTIN_PIPELINES.map((p) => ({
    ...p,
    steps: p.steps.map((s) => ({ ...s, params: { ...s.params } })),
    builtin: true,
    createdAt: 0,
  }));
}

let cache: Pipeline[] | null = null;
const listeners = new Set<() => void>();

function snapshot(): Pipeline[] {
  if (!cache) cache = [...builtinList(), ...loadCustoms()];
  return cache;
}

function refresh(): Pipeline[] {
  cache = [...builtinList(), ...loadCustoms()];
  for (const fn of listeners) fn();
  return cache;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reactive pipeline list shared by every consumer (workflow builder,
 *  download/record pickers, task workbench selector). */
export function usePipelines(): Pipeline[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function pipelineById(id: string): Pipeline | undefined {
  return snapshot().find((p) => p.id === id);
}

/** Localized display name: builtins resolve through i18n, customs render
 *  their stored name verbatim. */
export function pipelineDisplayName(
  p: Pipeline,
  t: (key: string) => string
): string {
  if (p.builtin && p.nameKey) return t(p.nameKey);
  return p.name;
}

/** Create a custom pipeline from the workflow builder's current chain.
 *  Re-saving under the same name replaces the previous definition. */
export function addPipeline(name: string, steps: WorkflowStepInput[]): Pipeline {
  const trimmed = name.trim();
  const customs = loadCustoms().filter((p) => p.name !== trimmed);
  const created: Pipeline = {
    id: `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: trimmed,
    steps: steps.map((s) => ({ toolId: s.toolId, params: { ...s.params } })),
    builtin: false,
    createdAt: Date.now(),
  };
  customs.push(created);
  saveCustoms(customs);
  refresh();
  return created;
}

export function renamePipeline(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  saveCustoms(
    loadCustoms().map((p) => (p.id === id ? { ...p, name: trimmed } : p))
  );
  refresh();
}

export function removePipeline(id: string): void {
  saveCustoms(loadCustoms().filter((p) => p.id !== id));
  refresh();
}

/** Merge the selected pipeline ids (in selection order) into a step list —
 *  the download/record picker resolves its bound pipeline through this,
 *  exactly like the presets did. */
export function stepsForPipelineIds(ids: string[]): WorkflowStepInput[] {
  return ids.flatMap((id) => pipelineById(id)?.steps ?? []);
}
