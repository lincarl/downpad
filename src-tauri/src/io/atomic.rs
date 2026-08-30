// Atomic file writes (spec §5.11): write to a sibling temp file, then rename
// over the destination. std::fs::rename replaces an existing file on Windows
// (MoveFileExW with MOVEFILE_REPLACE_EXISTING) and is atomic within a volume,
// so a crash mid-write never leaves a partially written target.

use crate::error::AppError;
use std::fs;
use std::path::Path;

pub fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let dir = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AppError::io("destination has no parent directory"))?;
    let file_name = dest
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled");
    // Temp file lives in the same directory (same volume) so the rename is atomic.
    let tmp = dir.join(format!(".{file_name}.tmp"));

    fs::write(&tmp, bytes)?;
    if let Err(e) = fs::rename(&tmp, dest) {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::io(format!("atomic rename failed: {e}")));
    }
    Ok(())
}
