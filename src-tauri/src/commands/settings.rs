// Settings commands (docs/design.md §3.2). The settings.toml watcher that emits
// `settings-changed` is wired in lib.rs.

use crate::error::AppError;
use crate::settings::{self, Settings};

#[tauri::command]
pub fn load_settings() -> Result<Settings, AppError> {
    Ok(settings::load_or_default())
}

#[tauri::command]
pub fn save_settings(settings: Settings) -> Result<(), AppError> {
    settings::save(&settings)
}

#[tauri::command]
pub fn settings_path() -> Result<String, AppError> {
    Ok(settings::settings_file()?.to_string_lossy().to_string())
}
