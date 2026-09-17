mod commands;
mod error;
mod ffmpeg;
mod gpu;
mod inspect;
mod jobs;
mod media;
mod models;
mod state;
mod thumbnail;

use tauri::Manager;

use state::JobManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(JobManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::probe_file,
            commands::start_job,
            commands::start_workflow,
            commands::estimate_size,
            commands::cancel_job,
            commands::open_output_folder,
            commands::detect_gpu,
            commands::inspect_media,
            thumbnail::get_thumbnail
        ])
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
