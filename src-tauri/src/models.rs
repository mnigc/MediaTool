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
    /// libx264 | libvpx-vp9 | copy
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
    /// mp4 | mkv | webm | mov
    pub format: String,
    /// veryfast | faster | fast | medium | slow | slower | veryslow
    pub preset: String,
    /// trim: start offset in seconds
    pub start_time: Option<f64>,
    /// trim: clip length in seconds (None = to end)
    pub duration: Option<f64>,
    /// extract audio track only (ignore video)
    pub extract_audio: Option<bool>,
    /// audio output format when extract_audio is true
    pub extract_format: Option<String>,
    /// GPU backend id to use for encoding (nvenc/qsv/videotoolbox/amf/vaapi);
    /// empty/None falls back to CPU encoding.
    pub gpu: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageParams {
    /// jpeg | png | webp | avif
    pub format: String,
    /// 1..100 (higher = better quality)
    pub quality: u8,
    /// longest side in px; None = keep original
    pub max_dimension: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioParams {
    /// mp3 | aac | m4a | opus | flac
    pub format: String,
    pub bitrate_kbps: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub input: String,
    pub output_dir: Option<String>,
    pub media_type: MediaType,
    pub params: serde_json::Value,
    pub output_suffix: Option<String>,
    /// Optional GPU backend id (e.g. "nvenc"); empty/None = CPU.
    pub gpu: Option<String>,
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
