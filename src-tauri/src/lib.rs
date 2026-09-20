mod commands;
mod shell;

pub use mediatool_core::{error, models};

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Build the shell state (engine Ctx) before any command can run,
            // then hand the engine the same managers the app manages.
            let handle = app.handle().clone();
            let shell = shell::build(&handle);
            app.manage(shell.jobs.clone());
            app.manage(shell.ctx.monitors.clone());
            app.manage(shell.ctx.uploads.clone());
            app.manage(shell.ctx.oauth.clone());
            app.manage(shell);
            // Unpack the bundled live-recording engine in the background, so
            // it is ready without any user action.
            let prep_ctx = handle.state::<shell::ShellState>().ctx.clone();
            mediatool_core::streamlink::prepare(&prep_ctx);
            // Restore persisted live monitors so they keep watching across
            // restarts (skipped silently when yt-dlp is not installed yet).
            mediatool_core::ytdlp::resume_monitors(&prep_ctx);
            // The window starts hidden so the user never stares at the white
            // cold-start screen; the frontend reveals it after its first
            // paint. This timer is the safety net: if the frontend fails to
            // load, the window still appears.
            let reveal_handle = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                if let Some(win) = reveal_handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::cache_report,
            commands::cache_clean,
            commands::probe_file,
            commands::start_job,
            commands::start_workflow,
            commands::estimate_size,
            commands::cancel_job,
            commands::open_output_folder,
            commands::detect_gpu,
            commands::ffmpeg_status,
            commands::inspect_media,
            commands::get_thumbnail,
            commands::upload_start,
            commands::cancel_upload,
            commands::oauth_begin,
            commands::oauth_cancel,
            commands::ytdlp_status,
            commands::ytdlp_install,
            commands::ytdlp_latest_version,
            commands::ytdlp_probe,
            commands::ytdlp_start_download,
            commands::dl_active_tasks,
            commands::streamlink_status,
            commands::streamlink_latest_release,
            commands::streamlink_install,
            commands::monitor_add,
            commands::monitor_list,
            commands::monitor_remove,
            commands::monitor_record_now,
            commands::monitor_update
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // Quitting mid-encode must not orphan the ffmpeg sidecars: kill
            // every live child so no zombie processes keep burning CPU and
            // writing partial output files after the app is gone.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(s) = app_handle.try_state::<shell::ShellState>() {
                    s.jobs.kill_all();
                }
            }
        });
}
