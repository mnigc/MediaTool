//! Media-tool job orchestration, split by responsibility: `util` holds the
//! shared pure helpers, `args` the ffmpeg argument builders, `prepare` the
//! param parsing / validation / overwrite-policy resolution, `workflow` the
//! single-command merge pipeline, `run` the runtime loop and `estimate` the
//! size estimator. The public API paths are unchanged.
mod args;
mod estimate;
mod prepare;
mod run;
mod util;
mod workflow;

pub use estimate::estimate_size;
pub use run::start_job;
pub use workflow::start_workflow;

#[cfg(test)]
pub(crate) mod test_support {
    use crate::models::{MediaInfo, MediaType};

    pub(crate) fn sample_info() -> MediaInfo {
        MediaInfo {
            path: "in.mp4".into(),
            media_type: MediaType::Video,
            duration_secs: Some(10.0),
            width: Some(1920),
            height: Some(1080),
            fps: Some(25.0),
            video_codec: Some("h264".into()),
            audio_codec: Some("aac".into()),
            bitrate_kbps: Some(2000),
            size_bytes: 1_000_000,
            hdr: false,
        }
    }
}
