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

use state::JobManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
