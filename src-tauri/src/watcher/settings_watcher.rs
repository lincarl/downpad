// Watches settings.toml and emits `settings-changed` so the app live-reloads
// hand edits (spec §5.9). The returned watcher must be kept alive (managed by
// the app) for the watch to persist. Re-emitting on our own saves is harmless:
// the frontend re-applies identical settings idempotently.

use crate::error::AppError;
use crate::settings;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

pub fn start(app: &AppHandle) -> Result<RecommendedWatcher, AppError> {
    let dir = settings::config_dir()?;
    let handle = app.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        let touches_settings = event
            .paths
            .iter()
            .any(|p| p.file_name().map(|n| n == "settings.toml").unwrap_or(false));
        let relevant = matches!(
            event.kind,
            EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
        );
        if touches_settings && relevant {
            let settings = settings::load_or_default();
            let _ = handle.emit("settings-changed", settings);
        }
    })
    .map_err(|e| AppError::io(format!("settings watcher init failed: {e}")))?;

    // Watch the config directory (atomic saves replace the file, so watching the
    // file inode directly would miss events after a rename).
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| AppError::io(format!("settings watch failed: {e}")))?;

    Ok(watcher)
}
