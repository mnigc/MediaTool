mod cache;
mod commands;
mod error;
mod ffmpeg;
mod gpu;
mod inspect;
mod jobs;
mod media;
mod models;
mod state;
mod streamlink;
mod thumbnail;
mod ytdlp;

use tauri::Manager;

use state::JobManager;
use ytdlp::MonitorManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(JobManager::new())
        .manage(MonitorManager::default())
        .invoke_handler(tauri::generate_handler![
            cache::cache_report,
            cache::cache_clean,
            commands::probe_file,
            commands::start_job,
            commands::start_workflow,
            commands::estimate_size,
            commands::cancel_job,
            commands::open_output_folder,
            commands::detect_gpu,
            commands::inspect_media,
            thumbnail::get_thumbnail,
            ytdlp::ytdlp_status,
            ytdlp::ytdlp_install,
            ytdlp::ytdlp_latest_version,
            ytdlp::ytdlp_probe,
            ytdlp::ytdlp_start_download,
            ytdlp::dl_active_tasks,
            streamlink::streamlink_status,
            streamlink::streamlink_latest_release,
            streamlink::streamlink_install,
            ytdlp::monitor_add,
            ytdlp::monitor_list,
            ytdlp::monitor_remove,
            ytdlp::monitor_record_now,
            ytdlp::monitor_update
        ])
        .setup(|app| {
            // Unpack the bundled live-recording engine in the background, so it
            // is ready without any user action.
            streamlink::prepare(app.handle());
            // Restore persisted live monitors so they keep watching across
            // restarts (skipped silently when yt-dlp is not installed yet).
            ytdlp::resume_monitors(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // Quitting mid-encode must not orphan the ffmpeg sidecars: kill
            // every live child so no zombie processes keep burning CPU and
            // writing partial output files after the app is gone.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app_handle.state::<JobManager>().kill_all();
            }
        });
}
