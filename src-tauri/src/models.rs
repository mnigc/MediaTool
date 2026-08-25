use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaType {
    Video,
    Image,
    Audio,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub media_type: MediaType,
    pub duration_secs: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub bitrate_kbps: Option<u64>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoParams {
    /// libx264 | libvpx-vp9 | libsvtav1 | copy
    pub video_codec: String,
    /// crf | target_size | bitrate
    pub quality_mode: String,
    pub crf: Option<u32>,
    pub target_size_mb: Option<f64>,
    pub video_bitrate_kbps: Option<u32>,
    /// original | 480p | 720p | 1080p | 1440p | 2160p | WxH
    pub resolution: String,
    /// aac | opus | copy | none
    pub audio_codec: String,
    pub audio_bitrate_kbps: Option<u32>,
    /// source (keep input container) | mp4 | mkv | webm | mov
    pub format: String,
    /// veryfast | faster | fast | medium | slow | slower | veryslow
    pub preset: String,
    /// output frame rate in fps (None/0 = follow source; ignored for stream copy)
    pub fps: Option<u32>,
    /// GPU backend id to use for encoding (nvenc/qsv/videotoolbox/amf/vaapi);
    /// empty/None falls back to CPU encoding.
    pub gpu: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageParams {
    /// source (keep input format) | jpeg | png | webp | avif
    pub format: String,
    /// 1..100 (higher = better quality)
    pub quality: u8,
    /// longest side in px; None = keep original
    pub max_dimension: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioParams {
    /// source (keep input codec family) | mp3 | aac | m4a | opus | flac
    pub format: String,
    pub bitrate_kbps: u32,
}

/* ── Standalone toolbox tools ──────────────────────────────────── */

/// Params for the metadata-stripping tool (all media types).
/// A/V: lossless remux with -map_metadata -1; images: high-quality re-encode.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StripMetadataParams {}

/// Params for the video-trim tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimSegment {
    /// Cut start offset in seconds.
    pub start_time: f64,
    /// Clip length in seconds (None = to end).
    pub duration: Option<f64>,
}

/// Params for the "trim" tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimParams {
    /// Cut start offset in seconds.
    pub start_time: f64,
    /// Clip length in seconds (None = to end).
    pub duration: Option<f64>,
    /// "copy" (lossless, keyframe-aligned) | "encode" (precise re-encode)
    pub mode: String,
    /// Multiple cut ranges, each exported as its own clip. Empty = single
    /// legacy range from `start_time` / `duration`.
    #[serde(default = "default_trim_segments")]
    pub segments: Vec<TrimSegment>,
}

fn default_trim_segments() -> Vec<TrimSegment> {
    Vec::new()
}

/// Params for the rotate/flip tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RotateParams {
    /// "90c" | "90cc" | "180" | "hflip" | "vflip"
    pub transform: String,
}

/// Params for the remove-audio-track tool (lossless `-an -c copy`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuteParams {}

/// Params for the extract-audio tool (video -> audio file).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractAudioParams {
    /// mp3 | aac | m4a | opus | flac
    pub format: String,
    pub bitrate_kbps: u32,
}

/// Params for the "gif" tool (video -> animated GIF).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifParams {
    /// trim: start offset in seconds
    pub start_time: Option<f64>,
    /// trim: clip length in seconds (None = to end)
    pub duration: Option<f64>,
    /// GIF frame rate, clamped 5..30; default 12
    pub fps: Option<u32>,
    /// output width in px, height auto; default 480
    pub width: Option<u32>,
}

/// Params for the "screenshot" tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotParams {
    /// "single" (one frame at at_sec) | "interval" (every_sec within range)
    pub mode: String,
    /// single mode: timestamp of the frame
    pub at_sec: Option<f64>,
    /// interval mode: capture one frame every N seconds
    pub every_sec: Option<f64>,
    /// interval mode: range start (default 0)
    pub start_sec: Option<f64>,
    /// interval mode: range end (None = to end of file)
    pub end_sec: Option<f64>,
    /// png | jpeg
    pub format: String,
    /// downscale to this width, keeping aspect; None = original size
    pub max_width: Option<u32>,
}

/// Params for the "speed" tool (0.25x .. 4x playback speed).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedParams {
    /// Playback rate multiplier, clamped 0.25..=4.0.
    pub rate: f64,
    /// Drop the audio track entirely instead of retiming it.
    pub mute_audio: Option<bool>,
}

/// Params for the "watermark" tool (image watermark overlay).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkParams {
    /// Path to the PNG/JPG watermark image (inputs[1] on the frontend).
    pub image_path: String,
    /// Nine-grid position: tl|tc|tr|ml|mc|mr|bl|bc|br
    pub position: String,
    /// Watermark width as % of the main video width; default 20.
    pub scale_percent: u32,
    /// Opacity 0.0..1.0; default 1.0.
    pub opacity: Option<f32>,
    /// Margin from edges as % of min(width,height); default 3.
    pub margin_percent: Option<u32>,
}

/* ── New toolbox tools (video / audio / image) ──────────────── */

/// Params for the "video-crop" tool (visual crop to an aspect ratio or a
/// custom rectangle). Re-encodes with H.264+AAC.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropParams {
    /// "center" (fit an aspect ratio, centered) | "custom" (explicit rect)
    pub mode: String,
    /// target aspect ratio for center mode: "1:1" | "16:9" | "9:16" | "4:3" | "3:2" | "original"
    pub aspect: Option<String>,
    /// custom rect (mode == "custom"); all in pixels
    pub x: Option<u32>,
    pub y: Option<u32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Params for the "video-volume" tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoVolumeParams {
    /// "normalize" (loudnorm) | "gain" (linear dB boost)
    pub mode: String,
    /// gain in dB for "gain" mode; clamped -20..20
    pub gain: Option<f32>,
}

/// Params for the "video-reverse" tool (no options).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoReverseParams {}

/// Params for the "video-subtitle" tool (burn-in subtitles).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleParams {
    /// path to .srt / .ass / .vtt subtitle file
    pub path: String,
    /// burn into the video (true) vs. mux as a soft stream (false, mkv only)
    pub burn: Option<bool>,
}

/// Params for the "video-addaudio" tool (replace or mix a background track).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddAudioParams {
    /// path to the replacement / background audio file (inputs[1])
    pub audio_path: String,
    /// "replace" (swap the audio track) | "mix" (overlay under original)
    pub mode: String,
    /// mix level 0..1 applied to the added track (mix mode only)
    pub volume: Option<f32>,
}

/// Params for the "video-merge" tool (concatenate multiple clips).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMergeParams {
    /// "concat" (sequential join) — currently the only layout
    pub mode: String,
}

/// Params for the "audio-trim" tool (lossless stream copy).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrimParams {
    pub start_time: f64,
    pub duration: Option<f64>,
}

/// Params for the "audio-fade" tool (fade in / out).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FadeParams {
    /// fade-in length in seconds
    pub in_sec: f64,
    /// fade-out length in seconds
    pub out_sec: f64,
}

/// Params for the "audio-volume" tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioVolumeParams {
    /// "normalize" (loudnorm) | "gain" (linear dB boost)
    pub mode: String,
    pub gain: Option<f32>,
}

/// Params for the "audio-pitch" tool (speed + pitch shift).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchParams {
    /// playback speed multiplier 0.5..2.0 (atempo)
    pub speed: f64,
    /// pitch shift in semitones, -12..12 (asetrate + aresample)
    pub pitch: f64,
}

/// Params for the "audio-silence" tool (remove silent passages).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SilenceParams {
    /// "remove" (cut silence) | "detect" (annotate, passthrough)
    pub mode: String,
    /// silence threshold in dB (negative), default -35
    pub threshold_db: Option<f32>,
    /// minimum silence length in seconds, default 0.5
    pub min_len: Option<f32>,
}

/// Params for the "image-resize" tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageResizeParams {
    /// "longest" (fit longest side) | "exact" (force WxH) | "percent" (scale %)
    pub mode: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub percent: Option<u32>,
}

/// Params for the "image-rotate" tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRotateParams {
    /// "90c" | "90cc" | "180" | "hflip" | "vflip"
    pub transform: String,
}

/// Params for the "image-crop" tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCropParams {
    pub mode: String,
    pub aspect: Option<String>,
    pub x: Option<u32>,
    pub y: Option<u32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Params for the "image-watermark" tool (text or image overlay).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageWatermarkParams {
    /// "text" | "image"
    pub mode: String,
    /// text content for text mode
    pub text: Option<String>,
    /// path to overlay image for image mode (inputs[1])
    pub image_path: Option<String>,
    /// nine-grid position tl|tc|tr|ml|mc|mr|bl|bc|br
    pub position: String,
    /// overlay width as % of main width; default 25
    pub scale_percent: u32,
    pub opacity: Option<f32>,
    pub margin_percent: Option<u32>,
    /// font size for text mode, default 36
    pub font_size: Option<u32>,
    /// text color for text mode, default "white"
    pub color: Option<String>,
}

/// Params for the "image-pdf" tool (image -> PDF, single image).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePdfParams {}

/// Params for the "image-adjust" tool (brightness/contrast/saturation).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAdjustParams {
    /// -1.0..1.0
    pub brightness: Option<f32>,
    /// -2.0..2.0
    pub contrast: Option<f32>,
    /// 0.0..3.0
    pub saturation: Option<f32>,
}

/// Params for the "video-frames" tool (sample frames then re-encode into a video).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameSampleParams {
    /// seconds between sampled frames
    pub interval: f64,
    /// output frame rate after re-timing
    pub fps: f64,
    /// width of the sampled frames (px)
    pub width: u32,
}

/// Params for the "video-contact" tool (contact sheet / sprite grid).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactSheetParams {
    /// "interval" (capture every N seconds) | "count" (N thumbnails across the video)
    #[serde(default = "default_contact_mode")]
    pub mode: String,
    /// seconds between captured thumbnails (interval mode)
    pub interval: f64,
    /// total number of thumbnails (count mode, grid auto-fits)
    #[serde(default = "default_contact_count")]
    pub count: u32,
    pub cols: u32,
    pub rows: u32,
    /// width of each thumbnail (px)
    pub thumb_w: u32,
}

fn default_contact_mode() -> String {
    "interval".to_string()
}

fn default_contact_count() -> u32 {
    20
}

/// Params for the "video-silence" tool (detect silent segments, write a report).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSilenceParams {
    /// silence threshold in dB (negative)
    pub threshold: f32,
    /// minimum silence length in seconds
    pub min_len: f32,
}

impl Default for FrameSampleParams {
    fn default() -> Self {
        Self { interval: 2.0, fps: 12.0, width: 480 }
    }
}

impl Default for ContactSheetParams {
    fn default() -> Self {
        Self { mode: "interval".into(), interval: 5.0, count: 20, cols: 4, rows: 4, thumb_w: 160 }
    }
}

impl Default for VideoSilenceParams {
    fn default() -> Self {
        Self { threshold: -35.0, min_len: 2.0 }
    }
}

/// Params for the "audio-merge" tool (concatenate audio files).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMergeParams {
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    /// Which tool runs this job: "compress" | "gif" | "screenshot" |
    /// "speed" | "watermark".
    pub tool_id: String,
    /// One or more input files. Most tools use inputs[0]; multi-input tools
    /// (merge/mix) may pass more.
    pub inputs: Vec<String>,
    pub output_dir: Option<String>,
    pub params: serde_json::Value,
    pub output_suffix: Option<String>,
    /// Optional GPU backend id (e.g. "nvenc"); empty/None = CPU.
    /// Only used by the compress tool.
    pub gpu: Option<String>,
    /// What to do when the output file already exists:
    /// "overwrite" | "rename" (append " (2)", " (3)", …) | "skip".
    /// None defaults to "rename". Ignored for pattern outputs.
    pub overwrite_policy: Option<String>,
}

/// Result of starting a job. `skipped == true` means nothing was encoded
/// because the output file already existed and the policy was "skip".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartJobResult {
    pub id: String,
    pub skipped: bool,
}

/* ── Multi-step workflow ─────────────────────────────────────── */

/// One composable step inside a multi-step workflow. Reuses the same params
/// and tool ids as single jobs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStepInput {
    pub tool_id: String,
    pub params: serde_json::Value,
}

/// Request to run a whole workflow. The backend tries to merge the steps into
/// a single FFmpeg command; if that is impossible it signals the caller to
/// fall back to running the steps one by one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRequest {
    pub input: String,
    pub steps: Vec<WorkflowStepInput>,
    pub output_dir: Option<String>,
    pub output_suffix: Option<String>,
    pub gpu: Option<String>,
    pub overwrite_policy: Option<String>,
}

/// Result of a workflow start.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWorkflowResult {
    pub id: String,
    /// true when the steps were merged into a single FFmpeg command that is now
    /// running (progress/done report on `id`). false means nothing was started
    /// and the caller should run the steps individually.
    pub merged: bool,
    /// true when the output file already existed and the policy was "skip", so
    /// nothing was started and the caller should treat the run as finished.
    #[serde(default)]
    pub skipped: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub id: String,
    pub percent: f64,
    pub phase: String,
    pub speed: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoneEvent {
    pub id: String,
    pub ok: bool,
    pub cancelled: bool,
    /// true when the job was skipped because the output file already existed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub input_size: u64,
    pub output_size: Option<u64>,
}

/// Request for a refined size estimate via a short real encode sample.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EstimateRequest {
    pub info: MediaInfo,
    /// JobParams serialized as JSON (VideoParams | ImageParams | AudioParams).
    pub params: serde_json::Value,
    pub media_type: MediaType,
    /// Length of the sample clip in seconds (defaults to 8).
    pub sample_secs: Option<f64>,
}

/// Result of a refined size estimate.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EstimateResult {
    /// Bytes produced by the sample clip.
    pub sampled_bytes: u64,
    /// Actual duration of the sample clip in seconds.
    pub sampled_secs: f64,
    /// Total duration used for extrapolation (after trim), if applicable.
    pub total_secs: Option<f64>,
    /// Estimated total output size in bytes.
    pub bytes: u64,
    /// true when the whole clip was sampled (short clip) -> exact.
    pub exact: bool,
}

/// One stream inside a full media inspection report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamReport {
    pub index: i64,
    /// video | audio | subtitle | data | attachment
    pub kind: String,
    pub codec_name: Option<String>,
    pub codec_long: Option<String>,
    pub profile: Option<String>,
    pub pix_fmt: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// e.g. "30000/1001"
    pub avg_frame_rate: Option<String>,
    pub sample_rate: Option<u64>,
    pub channels: Option<u32>,
    pub channel_layout: Option<String>,
    pub bitrate_kbps: Option<u64>,
    pub language: Option<String>,
    pub tags: serde_json::Value,
}

/// Full ffprobe-based report for the inspect tool.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaReport {
    pub path: String,
    pub size_bytes: u64,
    pub format_name: Option<String>,
    pub format_long: Option<String>,
    pub duration_secs: Option<f64>,
    pub bitrate_kbps: Option<u64>,
    pub tags: serde_json::Value,
    pub streams: Vec<StreamReport>,
    pub chapter_count: usize,
}
