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
pub struct TrimParams {
    /// Cut start offset in seconds.
    pub start_time: f64,
    /// Clip length in seconds (None = to end).
    pub duration: Option<f64>,
    /// "copy" (lossless, keyframe-aligned) | "encode" (precise re-encode)
    pub mode: String,
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
