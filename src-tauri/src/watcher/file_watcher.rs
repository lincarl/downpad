// Watches the currently-open file and emits `file-changed` when it changes on
// disk (spec §5.1 reload banner). Like the settings watcher, it watches the
// parent directory (atomic saves replace the file, so a direct inode watch would
// miss post-rename events) and filters to our file name. Self-write suppression
// lives on the frontend, which compares the event's modifiedMs against the last
// mtime it wrote (design risk #6).

use crate::error::AppError;
use crate::models::FileChanged;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::ffi::OsString;
use std::path::Path;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter};

/// Managed state holding the active single-file watcher (or none).
#[derive(Default)]
pub struct FileWatch(pub Mutex<Option<RecommendedWatcher>>);

fn modified_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Start (replacing any prior) watching `path`'s directory for changes to it.
pub fn watch(app: &AppHandle, state: &FileWatch, path: String) -> Result<(), AppError> {
    let target = Path::new(&path);
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AppError::io("file has no parent directory"))?
        .to_path_buf();
    let file_name: Option<OsString> = target.file_name().map(|n| n.to_os_string());
    let handle = app.clone();
    let target_path = path.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if !matches!(
            event.kind,
            EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
        ) {
            return;
        }
        let touches = event
            .paths
            .iter()
            .any(|p| p.file_name().map_or(false, |n| Some(n) == file_name.as_deref()));
        if !touches {
            return;
        }
        let ms = modified_ms(Path::new(&target_path));
        let _ = handle.emit(
            "file-changed",
            FileChanged {
                path: target_path.clone(),
                modified_ms: ms,
            },
        );
    })
    .map_err(|e| AppError::io(format!("file watcher init failed: {e}")))?;

    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| AppError::io(format!("file watch failed: {e}")))?;

    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}

pub fn unwatch(state: &FileWatch) {
    *state.0.lock().unwrap() = None;
}
