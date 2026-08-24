import type {
  AudioParams,
  ImageParams,
  JobParams,
  MediaInfo,
  VideoParams,
} from "../types";

export interface SizeEstimate {
  bytes: number;
  /** true when directly derivable (bitrate / target size / audio bitrate) */
  exact: boolean;
  /** true when a heuristic (CRF quality / image re-encode) */
  rough: boolean;
}

const KBPS_TO_BYTES_PER_SEC = 125; // 1000 / 8

function audioBytes(bitrateKbps: number, durationSecs: number): number {
  return Math.round(bitrateKbps * KBPS_TO_BYTES_PER_SEC * durationSecs);
}

function durationOf(info: MediaInfo): number | null {
  if (info.durationSecs && info.durationSecs > 0) return info.durationSecs;
  if (info.bitrateKbps && info.bitrateKbps > 0 && info.sizeBytes > 0) {
    const secs = info.sizeBytes / (info.bitrateKbps * 1000);
    if (secs > 0 && Number.isFinite(secs)) return secs;
  }
  return null;
}

const HEIGHT_BY_RES: Record<string, number> = {
  "480p": 480,
  "720p": 720,
  "1080p": 1080,
  "1440p": 1440,
  "2160p": 2160,
};

function targetHeight(resolution: string, info: MediaInfo): number {
  if (resolution === "original") return info.height ?? 0;
  return HEIGHT_BY_RES[resolution] ?? info.height ?? 0;
}

// Approx. average H.264 video bitrate (kbps) at CRF 23 for a given frame height.
const BASE_KBPS_BY_HEIGHT: Array<[number, number]> = [
  [480, 900],
  [720, 2000],
  [1080, 4500],
  [1440, 9000],
  [2160, 18000],
];

function videoKbpsAtHeight(h: number): number {
  if (h <= 0) return 0;
  let ref = BASE_KBPS_BY_HEIGHT[0];
  for (const e of BASE_KBPS_BY_HEIGHT) {
    if (Math.abs(e[0] - h) < Math.abs(ref[0] - h)) ref = e;
  }
  return Math.round(ref[1] * Math.pow(h / ref[0], 2));
}

function audioKbpsOf(codec: string, bitrateKbps: number | undefined): number {
  if (codec === "none") return 0;
  if (codec === "copy") return 128; // best-effort guess for source audio
  return bitrateKbps ?? 128;
}

function estimateImage(info: MediaInfo, p: ImageParams): SizeEstimate {
  let pixelRatio = 1;
  if (
    p.maxDimension &&
    p.maxDimension > 0 &&
    info.width &&
    info.height
  ) {
    const scale = Math.min(
      p.maxDimension / info.width,
      p.maxDimension / info.height,
      1
    );
    if (scale > 0) pixelRatio = scale * scale;
  }
  const q = p.quality / 100;
  const factor = pixelRatio * Math.pow(q, 1.3);
  return { bytes: Math.round(info.sizeBytes * factor), exact: false, rough: true };
}

export function estimateOutputSize(
  info: MediaInfo,
  params: JobParams
): SizeEstimate | null {
  const dur = durationOf(info);

  if (info.mediaType === "audio") {
    if (dur == null) return null;
    const kbps = (params as AudioParams).bitrateKbps;
    return { bytes: audioBytes(kbps, dur), exact: true, rough: false };
  }

  if (info.mediaType === "image") {
    return estimateImage(info, params as ImageParams);
  }

  if (info.mediaType === "video") {
    const v = params as VideoParams;

    if (dur == null) return null;

    if (v.qualityMode === "target_size") {
      const mb = v.targetSizeMb ?? 10;
      return { bytes: Math.round(mb * 1_000_000), exact: true, rough: false };
    }

    let videoKbps: number;
    let exact = false;

    if (v.qualityMode === "bitrate") {
      videoKbps = v.videoBitrateKbps ?? 1000;
      exact = true;
    } else {
      // CRF heuristic
      const tH = targetHeight(v.resolution, info);
      const srcH = info.height ?? tH;
      const areaRatio = srcH > 0 ? Math.pow(tH / srcH, 2) : 1;

      if (v.videoCodec === "copy") {
        const total = info.bitrateKbps ?? 0;
        videoKbps = Math.max(0, total - 128);
      } else {
        const crf = v.crf ?? 28;
        const crfScale = Math.pow(1.4, (23 - crf) / 3);
        let codecFactor = 1.0;
        if (v.videoCodec === "libvpx-vp9") codecFactor = 0.7;
        else if (v.videoCodec === "libsvtav1") codecFactor = 0.6;
        // Frame rate adjustment relative to the 30fps baseline of the table.
        const fpsScale =
          v.fps && v.fps > 0 ? Math.pow(v.fps / 30, 0.5) : 1.0;
        videoKbps = videoKbpsAtHeight(tH) * areaRatio * crfScale * codecFactor * fpsScale;
      }
      exact = false;
    }

    const audioK = audioKbpsOf(v.audioCodec, v.audioBitrateKbps);
    const totalKbps = videoKbps + audioK;
    return {
      bytes: Math.round(totalKbps * KBPS_TO_BYTES_PER_SEC * dur),
      exact,
      rough: !exact,
    };
  }

  return null;
}
