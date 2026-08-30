mod commands;
mod error;
mod io;
mod models;
mod settings;
mod state;
mod watcher;

use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single instance must be registered first (spec §5.12): a second launch
        // (e.g. double-clicking a .md) focuses this window and asks it to open the
        // file rather than starting a new process.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = commands::os_integration::first_md_arg(&argv) {
                let _ = app.emit("open-file-requested", serde_json::json!({ "path": path }));
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state::SearchState::default())
        .manage(watcher::file_watcher::FileWatch::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Live-reload settings.toml. Keep the watcher alive by managing it.
            match watcher::settings_watcher::start(&app.handle().clone()) {
                Ok(w) => {
                    app.manage(Mutex::new(w));
                }
                Err(e) => log::warn!("settings watcher not started: {e}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::file_io::read_file,
            commands::file_io::write_file,
            commands::file_io::path_exists,
            commands::file_io::watch_file,
            commands::file_io::unwatch_file,
            commands::file_io::ensure_attachments_dir,
            commands::file_io::write_attachment,
            commands::file_io::read_image_bytes,
            commands::settings::load_settings,
            commands::settings::save_settings,
            commands::settings::settings_path,
            commands::recent::get_recent_files,
            commands::recent::record_file_opened,
            commands::recent::remove_recent,
            commands::recent::set_favorite,
            commands::recent::stat_files,
            commands::search::search_recent_contents,
            commands::search::cancel_search,
            commands::recovery::write_snapshot,
            commands::recovery::delete_snapshot,
            commands::recovery::list_recovery_snapshots,
            commands::os_integration::get_launch_args,
            commands::os_integration::get_default_md_handler,
            commands::os_integration::get_system_accent_color,
            commands::os_integration::open_default_apps_settings,
            commands::printing::list_printers,
            commands::printing::print_webview,
            commands::printing::print_webview_to_pdf,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // Force a clean exit (code 0) on shutdown so an abnormal WebView2/tao
            // teardown can't surface a nonzero status (the 4294967295 / ELIFECYCLE
            // seen on window close). RunEvent::Exit is the terminal event: by the
            // time it fires the JS onCloseRequested guard (flush / confirm-discard /
            // recovery-snapshot delete) has already run on WindowEvent::CloseRequested,
            // and every plugin's own RunEvent::Exit handler — window-state geometry
            // save, single-instance mutex release — has already run before this
            // callback. So nothing is skipped. Must be RunEvent::Exit, not
            // ExitRequested (which runs before window-state saves geometry), and a
            // bare std::process::exit, not _app_handle.exit (which re-enters exit).
            // NOTE: md-easy never calls app.restart(); if that's ever added, this
            // unconditional exit would pre-empt the relaunch and must be revisited.
            if let tauri::RunEvent::Exit = event {
                std::process::exit(0);
            }
        });
}
