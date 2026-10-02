use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/* ── Wire-string enums ──────────────────────────────────────────── */

/// Prepare-time error for a parameter value the current build does not
/// recognize. The original wire string is kept in the message so a preset
/// written by another version (or by hand) is still diagnosable.
fn unknown_wire_error(field: &str, value: &str) -> AppError {
    AppError(format!(
        "参数“{field}”的值 “{value}” 无法识别：可能来自其他版本的预设或手改配置，请在工具选项中重新选择"
    ))
}

/// Define a string-backed enum for one JSON parameter field.
///
/// Known variants deserialize from (and serialize back to) the exact strings
/// the frontend and persisted presets use. Any other string — a value from an
/// older/newer build or a hand-edited config — lands in `Other(original)`
/// instead of failing the whole params object, so old JSON always parses.
/// Callers either map `Other` onto the historical default (fields where any
/// value used to be silently tolerated) or reject it at job-preparation time
/// via `ensure_known`, keeping the original value in the error.
///
/// The optional `empty => Variant` line records the historical convention
/// that an empty string means "the default": such values deserialize straight
/// into the given variant, preserving what used to work.
macro_rules! wire_enum {
    (
        $(#[$meta:meta])*
        $name:ident {
            $(
                $(#[$vmeta:meta])*
                $variant:ident => $wire:literal
            ),+ $(,)?
        }
    ) => {
        wire_enum! {
            $(#[$meta])*
            $name { $($(#[$vmeta])* $variant => $wire),+ }
            empty => [ ]
        }
    };
    (
        $(#[$meta:meta])*
        $name:ident {
            $(
                $(#[$vmeta:meta])*
                $variant:ident => $wire:literal
            ),+ $(,)?
        }
        empty => [$($empty_arm:tt)*]
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq)]
        pub enum $name {
            $(
                $(#[$vmeta])*
                $variant,
            )+
            /// Any unrecognized wire value, preserved verbatim.
            Other(String),
        }

        impl $name {
            /// The exact wire string this value round-trips as.
            pub fn as_str(&self) -> &str {
                match self {
                    $($name::$variant => $wire,)+
                    $name::Other(raw) => raw,
                }
            }

            /// Reject values this build does not recognize, keeping the
            /// original string in the error. Called at job-preparation time —
            /// never at deserialization — so old files still parse.
            pub fn ensure_known(&self, field: &'static str) -> Result<()> {
                match self {
                    $name::Other(raw) => Err(unknown_wire_error(field, raw)),
                    _ => Ok(()),
                }
            }

            pub(crate) fn from_wire(raw: String) -> Self {
                match raw.as_str() {
                    $($wire => $name::$variant,)+
                    $($empty_arm)*
                    _ => $name::Other(raw),
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(
                &self,
                serializer: S,
            ) -> std::result::Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(
                deserializer: D,
            ) -> std::result::Result<Self, D::Error> {
                Ok(Self::from_wire(String::deserialize(deserializer)?))
            }
        }
    };
}

wire_enum! {
    /// Target video encoder family for the compress / convert tools.
    VideoCodec {
        LibX264 => "libx264",
        LibX265 => "libx265",
        LibVpxVp9 => "libvpx-vp9",
        LibSvtAv1 => "libsvtav1",
        /// Lossless stream copy.
        Copy => "copy",
    }
}

wire_enum! {
    /// Rate-control mode for the video encoders.
    QualityMode {
        Crf => "crf",
        TargetSize => "target_size",
        Bitrate => "bitrate",
    }
}

wire_enum! {
    /// What happens to the audio track in a video job.
    AudioChoice {
        Aac => "aac",
        Opus => "opus",
        Copy => "copy",
        /// Drop the audio track entirely.
        None => "none",
    }
}

wire_enum! {
    /// Output container for the compress / convert tools.
    OutputFormat {
        /// Keep the input container.
        Source => "source",
        Mp4 => "mp4",
        Mkv => "mkv",
        Webm => "webm",
        Mov => "mov",
    }
    empty => ["" => OutputFormat::Source,]
}

wire_enum! {
    /// x264-style encoder speed preset.
    SpeedPreset {
        Veryfast => "veryfast",
        Faster => "faster",
        Fast => "fast",
        Medium => "medium",
        Slow => "slow",
        Slower => "slower",
        Veryslow => "veryslow",
    }
}

wire_enum! {
    /// Hardware encoder backend id. Values this build does not know keep the
    /// historical behavior: CPU encoding, silently (a machine may report a
    /// backend this version has never heard of).
    GpuBackend {
        Nvenc => "nvenc",
        Qsv => "qsv",
        Videotoolbox => "videotoolbox",
        Amf => "amf",
        Vaapi => "vaapi",
    }
}

wire_enum! {
    /// Audio-only output codec family.
    AudioFormat {
        /// Re-encode into whatever the source already is.
        Source => "source",
        Mp3 => "mp3",
        Aac => "aac",
        M4a => "m4a",
        Opus => "opus",
        Flac => "flac",
    }
    empty => ["" => AudioFormat::Source,]
}

wire_enum! {
    /// Cut strategy shared by trim and rough cut: lossless keyframe-aligned
    /// stream copy or a frame-exact re-encode.
    CutMode {
        Copy => "copy",
        Encode => "encode",
    }
    empty => ["" => CutMode::Copy,]
}

wire_enum! {
    /// Still-image export format for the screenshot tool.
    ImageFormat {
        Png => "png",
        Jpeg => "jpeg",
    }
    empty => ["" => ImageFormat::Png,]
}

wire_enum! {
    /// Screenshot capture strategy.
    ScreenshotMode {
        /// One frame at `at_sec`.
        Single => "single",
        /// One frame every `every_sec` within the range.
        Interval => "interval",
        /// N frames spread evenly across the whole file.
        Count => "count",
    }
    empty => ["" => ScreenshotMode::Single,]
}

wire_enum! {
    /// Nine-grid watermark anchor position.
    WatermarkPosition {
        Tl => "tl",
        Tc => "tc",
        Tr => "tr",
        Ml => "ml",
        Mc => "mc",
        Mr => "mr",
        Bl => "bl",
        Bc => "bc",
        Br => "br",
    }
    empty => ["" => WatermarkPosition::Br,]
}

wire_enum! {
    /// Rough-cut output container.
    RoughCutContainer {
        Mp4 => "mp4",
        Mkv => "mkv",
    }
    empty => ["" => RoughCutContainer::Mp4,]
}

wire_enum! {
    /// Audio-level adjustment strategy.
    VolumeMode {
        Normalize => "normalize",
        Gain => "gain",
    }
    empty => ["" => VolumeMode::Gain,]
}

wire_enum! {
    /// Contact-sheet capture strategy.
    ContactMode {
        Interval => "interval",
        Count => "count",
    }
    empty => ["" => ContactMode::Interval,]
}

wire_enum! {
    /// What to do when the output file already exists. Values this build does
    /// not know keep the historical "rename" behavior instead of erroring —
    /// that is what unknown policies always did.
    OverwritePolicy {
        Overwrite => "overwrite",
        Rename => "rename",
        Skip => "skip",
    }
}

wire_enum! {
    /// Download / recording quality cap. Values outside the shared vocabulary
    /// pass through untouched: streamlink accepts per-plugin stream names, so
    /// the passthrough is a documented feature, not an error.
    DlQuality {
        Best => "best",
        R2160p => "2160p",
        R1080p => "1080p",
        R720p => "720p",
        R480p => "480p",
        /// Audio-only extraction (VOD downloads; live capture degrades to the
        /// lowest audible stream).
        Audio => "audio",
    }
}

impl Default for DlQuality {
    // Hand-written because the enum comes from the `wire_enum!` macro, which
    // does not stamp a `#[default]` marker on any variant.
    #[allow(clippy::derivable_impls)]
    fn default() -> Self {
        DlQuality::Best
    }
}

wire_enum! {
    /// Whether a download request is a VOD download or a live capture.
    /// Unknown values keep the historical "download" behavior.
    DlKind {
        Download => "download",
        Record => "record",
    }
}

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
    /// Average video frame rate (falls back to the nominal rate when ffprobe
    /// reports `0/0`). `None` for audio, images and unreadable streams.
    pub fps: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub bitrate_kbps: Option<u64>,
    pub size_bytes: u64,
    /// HDR transfer detected at probe time (HDR10/HLG, or a DV base layer
    /// carrying HDR10 metadata). `default` keeps pre-upgrade persisted jobs
    /// deserializable.
    #[serde(default)]
    pub hdr: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoParams {
    /// Target encoder family; `gpu` may swap it for a hardware encoder.
    pub video_codec: VideoCodec,
    /// crf | target_size | bitrate
    pub quality_mode: QualityMode,
    pub crf: Option<u32>,
    pub target_size_mb: Option<f64>,
    pub video_bitrate_kbps: Option<u32>,
    /// original | 480p | 720p | 1080p | 1440p | 2160p | WxH
    ///
    /// Deliberately a free string: the `WxH` form is user input, so the value
    /// set is open and an enum would be a bad fit.
    pub resolution: String,
    /// aac | opus | copy | none
    pub audio_codec: AudioChoice,
    pub audio_bitrate_kbps: Option<u32>,
    /// source (keep input container) | mp4 | mkv | webm | mov
    pub format: OutputFormat,
    /// veryfast | faster | fast | medium | slow | slower | veryslow
    pub preset: SpeedPreset,
    /// output frame rate in fps (None/0 = follow source; ignored for stream copy)
    pub fps: Option<u32>,
    /// GPU backend id to use for encoding (nvenc/qsv/videotoolbox/amf/vaapi);
    /// empty/None falls back to CPU encoding.
    pub gpu: Option<GpuBackend>,
}

impl VideoParams {
    /// Reject wire values this build does not recognize. Called at
    /// job-preparation time so a preset from another version surfaces a clear
    /// error (naming the original value) instead of a failed ffmpeg run.
    pub(crate) fn validate(&self) -> Result<()> {
        self.video_codec.ensure_known("视频编码")?;
        self.quality_mode.ensure_known("画质模式")?;
        self.audio_codec.ensure_known("音频")?;
        self.format.ensure_known("输出格式")?;
        self.preset.ensure_known("编码速度预设")?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioParams {
    /// source (keep input codec family) | mp3 | aac | m4a | opus | flac
    pub format: AudioFormat,
    pub bitrate_kbps: u32,
}

impl AudioParams {
    /// See `VideoParams::validate`.
    pub(crate) fn validate(&self) -> Result<()> {
        self.format.ensure_known("音频格式")?;
        Ok(())
    }
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
    pub mode: CutMode,
    /// Multiple cut ranges, each exported as its own clip. Empty = single
    /// legacy range from `start_time` / `duration`.
    #[serde(default = "default_trim_segments")]
    pub segments: Vec<TrimSegment>,
}

impl TrimParams {
    /// See `VideoParams::validate`.
    pub(crate) fn validate(&self) -> Result<()> {
        self.mode.ensure_known("剪切模式")?;
        Ok(())
    }
}

fn default_trim_segments() -> Vec<TrimSegment> {
    Vec::new()
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
    pub format: AudioFormat,
    pub bitrate_kbps: u32,
}

impl ExtractAudioParams {
    /// See `VideoParams::validate`.
    pub(crate) fn validate(&self) -> Result<()> {
        self.format.ensure_known("音频格式")?;
        Ok(())
    }
}

/// Params for the "screenshot" tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotParams {
    /// "single" (one frame at at_sec) | "interval" (every_sec within range)
    /// | "count" (N frames spread evenly across the whole file)
    pub mode: ScreenshotMode,
    /// single mode: timestamp of the frame
    pub at_sec: Option<f64>,
    /// interval mode: capture one frame every N seconds
    pub every_sec: Option<f64>,
    /// count mode: number of frames to export
    #[serde(default)]
    pub count: Option<u32>,
    /// interval mode: range start (default 0)
    pub start_sec: Option<f64>,
    /// interval mode: range end (None = to end of file)
    pub end_sec: Option<f64>,
    /// png | jpeg
    pub format: ImageFormat,
    /// downscale to this width, keeping aspect; None = original size
    pub max_width: Option<u32>,
}

impl ScreenshotParams {
    /// See `VideoParams::validate`.
    pub(crate) fn validate(&self) -> Result<()> {
        self.mode.ensure_known("截图模式")?;
        self.format.ensure_known("截图格式")?;
        Ok(())
    }
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
    pub position: WatermarkPosition,
    /// Watermark width as % of the main video width; default 20.
    pub scale_percent: u32,
    /// Opacity 0.0..1.0; default 1.0.
    pub opacity: Option<f32>,
    /// Margin from edges as % of min(width,height); default 3.
    pub margin_percent: Option<u32>,
}

impl WatermarkParams {
    /// See `VideoParams::validate`.
    pub(crate) fn validate(&self) -> Result<()> {
        self.position.ensure_known("水印位置")?;
        Ok(())
    }
}

/* ── New toolbox tools (video / audio) ───────────────────────── */

/// Params for the "video-subtitle" tool (burn-in subtitles).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleParams {
    /// path to .srt / .ass / .vtt subtitle file
    pub path: String,
    /// burn into the video (true) vs. mux as a soft stream (false, mkv only)
    pub burn: Option<bool>,
}

/// One segment of a rough-cut timeline: a source file trimmed to
/// [start_time, end_time) with optional per-clip audio/speed tweaks.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoughCutClip {
    /// Absolute path of the source media file.
    pub path: String,
    /// Cut start offset in seconds within the source.
    pub start_time: f64,
    /// Cut end offset in seconds (None = to end of source).
    pub end_time: Option<f64>,
    /// Drop this clip's audio (silence is spliced in when neighbors keep
    /// theirs, so the concat stays uniform).
    #[serde(default)]
    pub mute: bool,
    /// Linear audio gain multiplier (1.0 = unchanged).
    #[serde(default = "default_roughcut_volume")]
    pub volume: f64,
    /// Playback speed multiplier, clamped 0.25..=4.0 (1.0 = unchanged).
    #[serde(default = "default_roughcut_speed")]
    pub speed: f64,
}

fn default_roughcut_volume() -> f64 {
    1.0
}

fn default_roughcut_speed() -> f64 {
    1.0
}

/// Params for the "roughcut" tool: an ordered clip list exported as one file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoughCutParams {
    /// "copy" (lossless keyframe-aligned concat) | "encode" (precise re-encode)
    pub mode: CutMode,
    /// Ordered timeline segments.
    pub clips: Vec<RoughCutClip>,
    /// Output container: "mp4" | "mkv".
    #[serde(default = "default_roughcut_container")]
    pub container: RoughCutContainer,
    /// Encoding recipe for "encode" mode (None = sensible defaults).
    #[serde(default)]
    pub encode: Option<VideoParams>,
}

impl RoughCutParams {
    /// See `VideoParams::validate`.
    pub(crate) fn validate(&self) -> Result<()> {
        self.mode.ensure_known("粗剪模式")?;
        self.container.ensure_known("粗剪容器")?;
        if let Some(ep) = &self.encode {
            ep.validate()?;
        }
        Ok(())
    }
}

fn default_roughcut_container() -> RoughCutContainer {
    RoughCutContainer::Mp4
}

/// Params for the "audio-volume" tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioVolumeParams {
    /// "normalize" (loudnorm) | "gain" (linear dB boost)
    pub mode: VolumeMode,
    pub gain: Option<f32>,
}

impl AudioVolumeParams {
    /// See `VideoParams::validate`.
    pub(crate) fn validate(&self) -> Result<()> {
        self.mode.ensure_known("音量模式")?;
        Ok(())
    }
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
    pub mode: ContactMode,
    /// seconds between captured thumbnails (interval mode)
    pub interval: f64,
    /// total number of thumbnails (count mode, grid auto-fits)
    #[serde(default = "default_contact_count")]
    pub count: u32,
    /// fixed grid width in count mode (player-preview layout); None = auto-fit
    #[serde(default)]
    pub count_cols: Option<u32>,
    pub cols: u32,
    pub rows: u32,
    /// width of each thumbnail (px)
    pub thumb_w: u32,
}

impl ContactSheetParams {
    /// See `VideoParams::validate`.
    pub(crate) fn validate(&self) -> Result<()> {
        self.mode.ensure_known("缩略图模式")?;
        Ok(())
    }
}

fn default_contact_mode() -> ContactMode {
    ContactMode::Interval
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
        Self {
            interval: 2.0,
            fps: 12.0,
            width: 480,
        }
    }
}

impl Default for ContactSheetParams {
    fn default() -> Self {
        Self {
            mode: ContactMode::Interval,
            interval: 5.0,
            count: 20,
            count_cols: None,
            cols: 4,
            rows: 4,
            thumb_w: 160,
        }
    }
}

impl Default for VideoSilenceParams {
    fn default() -> Self {
        Self {
            threshold: -35.0,
            min_len: 2.0,
        }
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
    /// Which tool runs this job: "compress" | "screenshot" |
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
    pub gpu: Option<GpuBackend>,
    /// What to do when the output file already exists:
    /// "overwrite" | "rename" (append " (2)", " (3)", …) | "skip".
    /// None defaults to "rename". Ignored for pattern outputs. Values this
    /// build does not know keep the historical "rename" behavior.
    pub overwrite_policy: Option<OverwritePolicy>,
    /// Bound pipelines may opt into the lossless-remux auto-fallback: when a
    /// stream-copy into MP4 hits codecs the container can't carry, the copy
    /// params are swapped for the transcode recipe and `note` on the result
    /// explains the substitution. Explicit tool-page choices keep the error.
    pub allow_copy_fallback: Option<bool>,
}

/// Result of starting a job. `skipped == true` means nothing was encoded
/// because the output file already existed and the policy was "skip";
/// `output` then carries the existing file. `note` carries a non-fatal
/// adjustment the backend made while preparing the job (remux fallback).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartJobResult {
    pub id: String,
    pub skipped: bool,
    pub output: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
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
    pub gpu: Option<GpuBackend>,
    pub overwrite_policy: Option<OverwritePolicy>,
    /// Opt into the lossless-remux auto-fallback (see `JobRequest`).
    pub allow_copy_fallback: Option<bool>,
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
    /// Non-fatal adjustment made while preparing the run (remux fallback).
    #[serde(default)]
    pub note: Option<String>,
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
    /// Every file the job delivered. Differs from `output` only for jobs with
    /// several products (multi-segment trim, frame sequences); omitted when
    /// there is just the one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outputs: Option<Vec<String>>,
    pub error: Option<String>,
    pub input_size: u64,
    pub output_size: Option<u64>,
}

/// Request for a refined size estimate via a short real encode sample.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EstimateRequest {
    pub info: MediaInfo,
    /// JobParams serialized as JSON (VideoParams | AudioParams).
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A legacy params blob as an older frontend might have sent it, plus two
    /// values no current build knows ("h263" codec, "cbr" quality mode —
    /// e.g. from a hand-edited preset).
    const LEGACY_PARAMS: &str = r#"{
        "videoCodec": "h263",
        "qualityMode": "cbr",
        "crf": 26,
        "resolution": "original",
        "audioCodec": "aac",
        "audioBitrateKbps": 128,
        "format": "mp4",
        "preset": "medium"
    }"#;

    #[test]
    fn legacy_json_with_unknown_values_still_parses() {
        // Unknown enum values must NOT fail the whole params object — the
        // error belongs to the prepare stage, not to deserialization.
        let p: VideoParams = serde_json::from_str(LEGACY_PARAMS).unwrap();
        assert_eq!(p.video_codec, VideoCodec::Other("h263".into()));
        assert_eq!(p.quality_mode, QualityMode::Other("cbr".into()));
        assert_eq!(p.audio_codec, AudioChoice::Aac);
        assert_eq!(p.format, OutputFormat::Mp4);
        assert_eq!(p.preset, SpeedPreset::Medium);
        assert_eq!(p.resolution, "original");
    }

    #[test]
    fn unknown_values_fail_at_validation_with_original_value() {
        let p: VideoParams = serde_json::from_str(LEGACY_PARAMS).unwrap();
        let err = p.validate().unwrap_err();
        assert!(err.0.contains("h263"), "missing raw value: {}", err.0);
        assert!(err.0.contains("视频编码"), "missing field name: {}", err.0);
        // A known value elsewhere must not trip validation.
        let mut ok = p.clone();
        ok.video_codec = VideoCodec::LibX264;
        let err = ok.validate().unwrap_err();
        assert!(err.0.contains("cbr"), "{}", err.0);
        let mut clean = ok;
        clean.quality_mode = QualityMode::Bitrate;
        assert!(clean.validate().is_ok());
    }

    #[test]
    fn serialization_round_trips_every_enum_field() {
        // Known values serialize to the exact on-the-wire strings.
        let p = VideoParams {
            video_codec: VideoCodec::LibVpxVp9,
            quality_mode: QualityMode::TargetSize,
            crf: None,
            target_size_mb: Some(5.0),
            video_bitrate_kbps: None,
            resolution: "720p".into(),
            audio_codec: AudioChoice::None,
            audio_bitrate_kbps: Some(128),
            format: OutputFormat::Source,
            preset: SpeedPreset::Veryslow,
            fps: Some(30),
            gpu: Some(GpuBackend::Vaapi),
        };
        let json: serde_json::Value = serde_json::to_value(&p).unwrap();
        assert_eq!(json["videoCodec"], "libvpx-vp9");
        assert_eq!(json["qualityMode"], "target_size");
        assert_eq!(json["audioCodec"], "none");
        assert_eq!(json["format"], "source");
        assert_eq!(json["preset"], "veryslow");
        assert_eq!(json["gpu"], "vaapi");
        // Round-trip yields the same struct again.
        let back: VideoParams = serde_json::from_value(json).unwrap();
        assert_eq!(back, p);

        // Unknown values round-trip verbatim (nothing is dropped or mangled).
        let raw = serde_json::from_str::<serde_json::Value>(LEGACY_PARAMS).unwrap();
        let back: serde_json::Value =
            serde_json::to_value(serde_json::from_value::<VideoParams>(raw).unwrap()).unwrap();
        assert_eq!(back["videoCodec"], "h263");
        assert_eq!(back["qualityMode"], "cbr");

        // The same holds for every other enum-carrying params struct.
        let trim: TrimParams =
            serde_json::from_str(r#"{"startTime":1.0,"mode":"encode"}"#).unwrap();
        assert_eq!(trim.mode, CutMode::Encode);
        assert_eq!(serde_json::to_value(&trim).unwrap()["mode"], "encode");

        let shot: ScreenshotParams = serde_json::from_str(
            r#"{"mode":"interval","atSec":1.0,"everySec":2.0,"startSec":0.0,"endSec":9.0,"format":"jpeg","maxWidth":640}"#,
        )
        .unwrap();
        assert_eq!(shot.mode, ScreenshotMode::Interval);
        assert_eq!(shot.format, ImageFormat::Jpeg);
        assert_eq!(serde_json::to_value(&shot).unwrap()["format"], "jpeg");

        let wm: WatermarkParams = serde_json::from_str(
            r#"{"imagePath":"w.png","position":"mc","scalePercent":20}"#,
        )
        .unwrap();
        assert_eq!(wm.position, WatermarkPosition::Mc);
        assert_eq!(serde_json::to_value(&wm).unwrap()["position"], "mc");

        let rc: RoughCutParams = serde_json::from_str(
            r#"{"mode":"copy","clips":[],"container":"mkv"}"#,
        )
        .unwrap();
        assert_eq!(rc.mode, CutMode::Copy);
        assert_eq!(rc.container, RoughCutContainer::Mkv);
        assert_eq!(serde_json::to_value(&rc).unwrap()["container"], "mkv");

        let vol: AudioVolumeParams =
            serde_json::from_str(r#"{"mode":"normalize","gain":1.5}"#).unwrap();
        assert_eq!(vol.mode, VolumeMode::Normalize);
        assert_eq!(serde_json::to_value(&vol).unwrap()["mode"], "normalize");

        let contact: ContactSheetParams =
            serde_json::from_str(r#"{"mode":"count","interval":5.0,"count":9,"cols":3,"rows":3,"thumbW":160}"#)
                .unwrap();
        assert_eq!(contact.mode, ContactMode::Count);
        assert_eq!(serde_json::to_value(&contact).unwrap()["mode"], "count");

        let audio: AudioParams =
            serde_json::from_str(r#"{"format":"m4a","bitrateKbps":192}"#).unwrap();
        assert_eq!(audio.format, AudioFormat::M4a);
        assert_eq!(serde_json::to_value(&audio).unwrap()["format"], "m4a");
    }

    #[test]
    fn empty_strings_keep_their_historical_default_meaning() {
        let p: VideoParams =
            serde_json::from_str(r#"{"videoCodec":"libx264","qualityMode":"crf","audioCodec":"aac","format":"","preset":"fast","resolution":"original"}"#)
                .unwrap();
        assert_eq!(p.format, OutputFormat::Source);
        // And serializing a "default" stays a plain known string.
        assert_eq!(serde_json::to_value(&p).unwrap()["format"], "source");

        let audio: AudioParams =
            serde_json::from_str(r#"{"format":"","bitrateKbps":128}"#).unwrap();
        assert_eq!(audio.format, AudioFormat::Source);
    }

    #[test]
    fn optional_policy_and_gpu_fields_stay_tolerant() {
        // Unknown overwrite policies / gpu backends historically fell back to
        // their defaults; they must keep doing so instead of erroring.
        let req: JobRequest = serde_json::from_str(
            r#"{"toolId":"video-compress","inputs":["a.mp4"],"params":{},"overwritePolicy":"clobber","gpu":"tpu"}"#,
        )
        .unwrap();
        assert_eq!(
            req.overwrite_policy,
            Some(OverwritePolicy::Other("clobber".into()))
        );
        assert_eq!(req.gpu, Some(GpuBackend::Other("tpu".into())));
        // Round-trip preserves them for the next run.
        let back: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(back["overwritePolicy"], "clobber");
        assert_eq!(back["gpu"], "tpu");

        // Absent fields stay None.
        let req: JobRequest = serde_json::from_str(
            r#"{"toolId":"video-compress","inputs":["a.mp4"],"params":{}}"#,
        )
        .unwrap();
        assert_eq!(req.overwrite_policy, None);
        assert_eq!(req.gpu, None);
    }

    #[test]
    fn download_quality_and_kind_round_trip() {
        let req: crate::ytdlp::DownloadRequest = serde_json::from_str(
            r#"{"url":"https://x/y","quality":"1080p","outputDir":"/tmp","kind":"record"}"#,
        )
        .unwrap();
        assert_eq!(req.quality, DlQuality::R1080p);
        assert_eq!(req.kind, Some(DlKind::Record));

        // The streamlink passthrough vocabulary survives untouched.
        let req: crate::ytdlp::DownloadRequest = serde_json::from_str(
            r#"{"url":"https://x/y","quality":"480p30","outputDir":"/tmp"}"#,
        )
        .unwrap();
        assert_eq!(req.quality, DlQuality::Other("480p30".into()));
        assert_eq!(req.quality.as_str(), "480p30");
        assert_eq!(req.kind, None);

        // Persisted monitors (quality survives a save/load cycle) too.
        let info: crate::ytdlp::MonitorInfo =
            serde_json::from_str(r#"{"quality":"720p"}"#).unwrap();
        assert_eq!(info.quality, DlQuality::R720p);
        let back = serde_json::to_value(&info).unwrap();
        assert_eq!(back["quality"], "720p");
    }

    #[test]
    fn missing_format_defaults_preserved() {
        // extension-facing defaults live in the caller, but the serde default
        // functions must keep producing the historical values.
        let rc: RoughCutParams =
            serde_json::from_str(r#"{"mode":"copy","clips":[]}"#).unwrap();
        assert_eq!(rc.container, RoughCutContainer::Mp4);
        let contact: ContactSheetParams =
            serde_json::from_str(r#"{"interval":5.0,"cols":4,"rows":4,"thumbW":160}"#).unwrap();
        assert_eq!(contact.mode, ContactMode::Interval);
        assert_eq!(contact.count, 20);
    }
}
