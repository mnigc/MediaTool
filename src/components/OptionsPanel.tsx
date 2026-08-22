import type { ReactNode } from "react";
import type { AudioParams, ImageParams, JobParams, VideoParams } from "../types";

interface Props {
  mediaType: string;
  params: JobParams;
  onChange: (p: JobParams) => void;
}

export default function OptionsPanel({ mediaType, params, onChange }: Props) {
  if (mediaType === "video") return <VideoOptions params={params as VideoParams} onChange={onChange} />;
  if (mediaType === "image") return <ImageOptions params={params as ImageParams} onChange={onChange} />;
  if (mediaType === "audio") return <AudioOptions params={params as AudioParams} onChange={onChange} />;
  return null;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
      {children}
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{title}</div>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </div>
  );
}

const sel =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm transition focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200";

function VideoOptions({ params, onChange }: { params: VideoParams; onChange: (p: VideoParams) => void }) {
  const set = (patch: Partial<VideoParams>) => onChange({ ...params, ...patch });

  if (params.extractAudio) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-100">
          仅提取音频：将忽略视频画面，输出为纯音频文件。
        </div>
        <Section title="音频输出">
          <Field label="输出格式">
            <select
              className={sel}
              value={params.extractFormat ?? "mp3"}
              onChange={(e) => set({ extractFormat: e.target.value })}
            >
              <option value="mp3">MP3</option>
              <option value="aac">AAC (.m4a)</option>
              <option value="m4a">M4A</option>
              <option value="opus">Opus</option>
              <option value="flac">FLAC (无损)</option>
            </select>
          </Field>
          <Field label="码率 (kbps)">
            <input
              type="number"
              className={sel}
              min={32}
              value={params.audioBitrateKbps ?? 128}
              onChange={(e) => set({ audioBitrateKbps: Number(e.target.value) })}
            />
          </Field>
        </Section>
        <button
          type="button"
          onClick={() => set({ extractAudio: false })}
          className="text-xs font-medium text-slate-400 underline-offset-2 transition hover:text-slate-600 hover:underline"
        >
          返回视频压缩设置
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => set({ extractAudio: true, extractFormat: params.extractFormat ?? "mp3" })}
          className="text-xs font-medium text-indigo-500 underline-offset-2 transition hover:text-indigo-700 hover:underline"
        >
          仅提取音频 →
        </button>
      </div>
      <Section title="视频">
        <Field label="输出格式">
          <select className={sel} value={params.format} onChange={(e) => set({ format: e.target.value })}>
            <option value="mp4">MP4 (H.264)</option>
            <option value="mkv">MKV</option>
            <option value="webm">WebM (VP9)</option>
            <option value="mov">MOV</option>
          </select>
        </Field>

        <Field label="视频编码">
          <select className={sel} value={params.videoCodec} onChange={(e) => set({ videoCodec: e.target.value })}>
            <option value="libx264">H.264 (兼容好)</option>
            <option value="libvpx-vp9">VP9 (免版税, 更高压缩)</option>
            <option value="copy">直接复制 (不重编码)</option>
          </select>
        </Field>

        <Field label="质量模式">
          <select className={sel} value={params.qualityMode} onChange={(e) => set({ qualityMode: e.target.value })}>
            <option value="crf">CRF 质量优先</option>
            <option value="target_size">目标文件大小</option>
            <option value="bitrate">固定码率</option>
          </select>
        </Field>

        {params.qualityMode === "crf" && (
          <Field label={`CRF: ${params.crf ?? 28} (越低越好)`}>
            <input
              type="range"
              min={18}
              max={40}
              value={params.crf ?? 28}
              onChange={(e) => set({ crf: Number(e.target.value) })}
              className="w-full accent-indigo-500"
            />
          </Field>
        )}

        {params.qualityMode === "target_size" && (
          <Field label="目标大小 (MB)">
            <input
              type="number"
              className={sel}
              min={1}
              value={params.targetSizeMb ?? 10}
              onChange={(e) => set({ targetSizeMb: Number(e.target.value) })}
            />
          </Field>
        )}

        {params.qualityMode === "bitrate" && (
          <Field label="视频码率 (kbps)">
            <input
              type="number"
              className={sel}
              min={100}
              value={params.videoBitrateKbps ?? 1000}
              onChange={(e) => set({ videoBitrateKbps: Number(e.target.value) })}
            />
          </Field>
        )}

        <Field label="分辨率">
          <select className={sel} value={params.resolution} onChange={(e) => set({ resolution: e.target.value })}>
            <option value="original">原始</option>
            <option value="2160p">2160p</option>
            <option value="1440p">1440p</option>
            <option value="1080p">1080p</option>
            <option value="720p">720p</option>
            <option value="480p">480p</option>
          </select>
        </Field>
      </Section>

      <Section title="裁剪（可选）">
        <Field label="起始时间 (秒)">
          <input
            type="number"
            className={sel}
            min={0}
            step={0.1}
            placeholder="0"
            value={params.startTime ?? ""}
            onChange={(e) => set({ startTime: e.target.value ? Number(e.target.value) : undefined })}
          />
        </Field>
        <Field label="时长 (秒, 留空到结尾)">
          <input
            type="number"
            className={sel}
            min={0.1}
            step={0.1}
            placeholder="到结尾"
            value={params.duration ?? ""}
            onChange={(e) => set({ duration: e.target.value ? Number(e.target.value) : undefined })}
          />
        </Field>
      </Section>

      <Section title="音频">
        <Field label="音频编码">
          <select className={sel} value={params.audioCodec} onChange={(e) => set({ audioCodec: e.target.value })}>
            <option value="aac">AAC</option>
            <option value="opus">Opus</option>
            <option value="copy">复制</option>
            <option value="none">移除音频</option>
          </select>
        </Field>

        {params.audioCodec !== "none" && params.audioCodec !== "copy" && (
          <Field label="音频码率 (kbps)">
            <input
              type="number"
              className={sel}
              min={32}
              value={params.audioBitrateKbps ?? 128}
              onChange={(e) => set({ audioBitrateKbps: Number(e.target.value) })}
            />
          </Field>
        )}
      </Section>

      <Section title="输出">
        <Field label="编码速度 / 压缩">
          <select className={sel} value={params.preset} onChange={(e) => set({ preset: e.target.value })}>
            <option value="veryfast">极快</option>
            <option value="faster">较快</option>
            <option value="fast">快</option>
            <option value="medium">中等</option>
            <option value="slow">慢 (更高压缩)</option>
            <option value="slower">更慢</option>
            <option value="veryslow">极慢</option>
          </select>
        </Field>
      </Section>
    </div>
  );
}

function ImageOptions({ params, onChange }: { params: ImageParams; onChange: (p: ImageParams) => void }) {
  const set = (patch: Partial<ImageParams>) => onChange({ ...params, ...patch });
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="输出格式">
        <select className={sel} value={params.format} onChange={(e) => set({ format: e.target.value })}>
          <option value="webp">WebP (推荐)</option>
          <option value="jpeg">JPEG</option>
          <option value="png">PNG</option>
          <option value="avif">AVIF (更高压缩)</option>
        </select>
      </Field>
      <Field label={`质量: ${params.quality}`}>
        <input
          type="range"
          min={1}
          max={100}
          value={params.quality}
          onChange={(e) => set({ quality: Number(e.target.value) })}
          className="w-full accent-indigo-500"
        />
      </Field>
      <Field label="最长边 (px, 留空不缩放)">
        <input
          type="number"
          className={sel}
          placeholder="例如 1920"
          value={params.maxDimension ?? ""}
          onChange={(e) => set({ maxDimension: e.target.value ? Number(e.target.value) : undefined })}
        />
      </Field>
    </div>
  );
}

function AudioOptions({ params, onChange }: { params: AudioParams; onChange: (p: AudioParams) => void }) {
  const set = (patch: Partial<AudioParams>) => onChange({ ...params, ...patch });
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="输出格式">
        <select className={sel} value={params.format} onChange={(e) => set({ format: e.target.value })}>
          <option value="mp3">MP3</option>
          <option value="aac">AAC (.m4a)</option>
          <option value="m4a">M4A</option>
          <option value="opus">Opus</option>
          <option value="flac">FLAC (无损)</option>
        </select>
      </Field>
      <Field label="码率 (kbps)">
        <input
          type="number"
          className={sel}
          min={32}
          value={params.bitrateKbps}
          onChange={(e) => set({ bitrateKbps: Number(e.target.value) })}
        />
      </Field>
    </div>
  );
}
