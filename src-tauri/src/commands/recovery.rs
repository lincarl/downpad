// Crash-recovery snapshots (spec §5.11). The frontend writes the current buffer
// to the platform config directory's md-easy/recovery/{sessionId}.json every
// few seconds while dirty;
// on a clean shutdown the snapshot is deleted, so any file left on startup is an
// unfinished (crashed/force-quit) session. Writes are atomic. The session id and
// timestamps come from the frontend (crypto.randomUUID / toISOString), so no
// uuid/date crate is needed here.

use crate::error::AppError;
use crate::io::atomic;
use crate::models::Snapshot;
use crate::settings;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

fn recovery_dir() -> Result<PathBuf, AppError> {
    let dir = settings::config_dir()?.join("recovery");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn snapshot_path(session_id: &str) -> Result<PathBuf, AppError> {
    // Guard against path traversal from a malformed session id.
    let safe: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    Ok(recovery_dir()?.join(format!("{safe}.json")))
}

#[tauri::command]
pub fn write_snapshot(snapshot: Snapshot) -> Result<(), AppError> {
    let path = snapshot_path(&snapshot.session_id)?;
    let json = serde_json::to_string(&snapshot).map_err(|e| AppError::io(e.to_string()))?;
    atomic::write_atomic(&path, json.as_bytes())
}

#[tauri::command]
pub fn delete_snapshot(session_id: String) -> Result<(), AppError> {
    let path = snapshot_path(&session_id)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

/// Startup scan: prune snapshots older than `recoveryRetentionDays` and cap to
/// the 50 most recent, then return what remains (spec §5.11 limits).
#[tauri::command]
pub fn list_recovery_snapshots() -> Result<Vec<Snapshot>, AppError> {
    let dir = recovery_dir()?;
    let cfg = settings::load_or_default();
    let max_age = Duration::from_secs(u64::from(cfg.recovery_retention_days) * 24 * 60 * 60);
    let now = SystemTime::now();

    let mut found: Vec<(SystemTime, PathBuf, Snapshot)> = Vec::new();
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(now);
        // Prune by age.
        if now.duration_since(modified).map(|d| d > max_age).unwrap_or(false) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        match std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Snapshot>(&t).ok()) {
            Some(snap) => found.push((modified, path, snap)),
            None => {
                let _ = std::fs::remove_file(&path); // unparseable → drop
            }
        }
    }

    // Most-recent first; delete the oldest beyond the 50 cap.
    found.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path, _) in found.iter().skip(50) {
        let _ = std::fs::remove_file(path);
    }
    found.truncate(50);
    Ok(found.into_iter().map(|(_, _, snap)| snap).collect())
}
