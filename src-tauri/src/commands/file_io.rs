// File I/O commands. Reads return BOM-stripped, LF-normalized content plus the
// detected EOL; writes re-apply that EOL, never write a BOM, and are atomic.
// See spec §5.18 and docs/design.md §3.1.

use crate::error::AppError;
use crate::io::{atomic, encoding};
use crate::models::{FileMeta, FilePayload, ImageBytes};
use crate::watcher::file_watcher::{self, FileWatch};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, State};

fn modified_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<FilePayload, AppError> {
    let p = Path::new(&path);
    let bytes = fs::read(p)?;
    let size_bytes = bytes.len() as u64;
    let (body, had_bom) = encoding::strip_bom(&bytes);
    let raw = String::from_utf8(body.to_vec())
        .map_err(|_| AppError::encoding("file is not valid UTF-8"))?;
    let eol = encoding::detect_eol(&raw);
    let content = encoding::normalize_to_lf(&raw);
    Ok(FilePayload {
        content,
        eol: eol.to_string(),
        had_bom,
        size_bytes,
        modified_ms: modified_ms(p),
    })
}

#[tauri::command]
pub fn write_file(path: String, content: String, eol: String) -> Result<FileMeta, AppError> {
    let p = Path::new(&path);
    // Re-apply the file's EOL; always UTF-8, never a BOM.
    let out = encoding::apply_eol(&content, &eol);
    atomic::write_atomic(p, out.as_bytes())?;
    Ok(FileMeta {
        modified_ms: modified_ms(p),
    })
}

#[tauri::command]
pub fn path_exists(path: String) -> Result<bool, AppError> {
    Ok(Path::new(&path).exists())
}

/// Absolute path to the attachments directory next to the open document,
/// creating it on demand (spec §5.7). `doc_path` is the .md file's path.
#[tauri::command]
pub fn ensure_attachments_dir(doc_path: String, folder_name: String) -> Result<String, AppError> {
    let dir = attachments_dir(&doc_path, &folder_name)?;
    fs::create_dir_all(&dir)?;
    Ok(dir.to_string_lossy().to_string())
}

/// Write image/file bytes into the document's attachments folder (created on
/// demand) and return the **relative, forward-slash** link path to embed in the
/// markdown, e.g. `attachments/img-2026-05-31T10-00-00Z.png` (spec §5.5, §5.7).
/// If `file_name` already exists, a numeric suffix is appended so nothing is
/// overwritten; the returned path reflects the name actually written.
#[tauri::command]
pub fn write_attachment(
    doc_path: String,
    folder_name: String,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<String, AppError> {
    let dir = attachments_dir(&doc_path, &folder_name)?;
    fs::create_dir_all(&dir)?;
    let unique = unique_name(&dir, &file_name);
    atomic::write_atomic(&dir.join(&unique), &bytes)?;
    // Link paths are POSIX-style regardless of OS, for portable markdown.
    Ok(format!("{folder_name}/{unique}"))
}

/// Watch the open file for external changes → `file-changed` event (spec §5.1).
#[tauri::command]
pub fn watch_file(app: AppHandle, state: State<FileWatch>, path: String) -> Result<(), AppError> {
    file_watcher::watch(&app, &state, path)
}

/// Stop watching (e.g. on New / closing the document).
#[tauri::command]
pub fn unwatch_file(state: State<FileWatch>) -> Result<(), AppError> {
    file_watcher::unwatch(&state);
    Ok(())
}

/// Read raw image bytes plus a MIME type guessed from the extension (spec §5.5).
#[tauri::command]
pub fn read_image_bytes(path: String) -> Result<ImageBytes, AppError> {
    let p = Path::new(&path);
    let bytes = fs::read(p)?;
    let mime = mime_from_extension(p);
    Ok(ImageBytes { bytes, mime })
}

/// `<doc's parent dir>/<folder_name>`. Errors if the document has no parent
/// (e.g. an untitled buffer) — the caller must have a saved path first (§5.5).
fn attachments_dir(doc_path: &str, folder_name: &str) -> Result<PathBuf, AppError> {
    let parent = Path::new(doc_path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AppError::io("document has no parent directory; save it first"))?;
    Ok(parent.join(folder_name))
}

/// Return `file_name` unchanged if free, else insert `-1`, `-2`, … before the
/// extension until a free name is found.
fn unique_name(dir: &Path, file_name: &str) -> String {
    if !dir.join(file_name).exists() {
        return file_name.to_string();
    }
    let path = Path::new(file_name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(file_name);
    let ext = path.extension().and_then(|s| s.to_str());
    for n in 1.. {
        let candidate = match ext {
            Some(ext) => format!("{stem}-{n}.{ext}"),
            None => format!("{stem}-{n}"),
        };
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    unreachable!("an unused name is always found")
}

fn mime_from_extension(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("md-easy-test-{}-{}", std::process::id(), name));
        p
    }

    #[test]
    fn write_then_read_round_trips_lf() {
        let path = temp_path("lf.md");
        let p = path.to_string_lossy().to_string();
        write_file(p.clone(), "# Hi\n\nBody\n".into(), "lf".into()).unwrap();
        let payload = read_file(p).unwrap();
        assert_eq!(payload.content, "# Hi\n\nBody\n");
        assert_eq!(payload.eol, "lf");
        assert!(!payload.had_bom);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn crlf_is_preserved_on_disk_but_lf_in_memory() {
        let path = temp_path("crlf.md");
        let p = path.to_string_lossy().to_string();
        // Write canonical LF content but request CRLF on disk.
        write_file(p.clone(), "a\nb\n".into(), "crlf".into()).unwrap();
        let on_disk = fs::read(&path).unwrap();
        assert_eq!(on_disk, b"a\r\nb\r\n");
        // Reading normalizes back to LF and reports the detected CRLF.
        let payload = read_file(p).unwrap();
        assert_eq!(payload.content, "a\nb\n");
        assert_eq!(payload.eol, "crlf");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn bom_is_detected_and_stripped() {
        let path = temp_path("bom.md");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"hello\n");
        fs::write(&path, &bytes).unwrap();
        let payload = read_file(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(payload.content, "hello\n");
        assert!(payload.had_bom);
        let _ = fs::remove_file(&path);
    }

    /// A unique temp directory for attachment tests (so parallel tests and the
    /// created `attachments/` subfolder don't collide).
    fn temp_dir(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("md-easy-test-{}-{}", std::process::id(), name));
        p
    }

    #[test]
    fn ensure_attachments_dir_creates_it_next_to_doc() {
        let dir = temp_dir("ensure");
        let _ = fs::create_dir_all(&dir);
        let doc = dir.join("note.md");
        let created =
            ensure_attachments_dir(doc.to_string_lossy().to_string(), "attachments".into()).unwrap();
        assert_eq!(PathBuf::from(&created), dir.join("attachments"));
        assert!(Path::new(&created).is_dir());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_attachment_returns_posix_relative_path_and_writes_bytes() {
        let dir = temp_dir("write");
        let _ = fs::create_dir_all(&dir);
        let doc = dir.join("note.md");
        let rel = write_attachment(
            doc.to_string_lossy().to_string(),
            "attachments".into(),
            "img-2026.png".into(),
            vec![1, 2, 3, 4],
        )
        .unwrap();
        assert_eq!(rel, "attachments/img-2026.png");
        let on_disk = fs::read(dir.join("attachments").join("img-2026.png")).unwrap();
        assert_eq!(on_disk, vec![1, 2, 3, 4]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_attachment_does_not_overwrite_existing_name() {
        let dir = temp_dir("collide");
        let _ = fs::create_dir_all(&dir);
        let doc = dir.join("note.md");
        let args = || (doc.to_string_lossy().to_string(), "attachments".to_string());
        let (d, f) = args();
        let first = write_attachment(d, f, "img.png".into(), vec![0xAA]).unwrap();
        let (d, f) = args();
        let second = write_attachment(d, f, "img.png".into(), vec![0xBB]).unwrap();
        assert_eq!(first, "attachments/img.png");
        assert_eq!(second, "attachments/img-1.png");
        // The original is intact (not overwritten).
        assert_eq!(fs::read(dir.join("attachments/img.png")).unwrap(), vec![0xAA]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_attachment_errors_for_untitled_doc() {
        // A bare file name has no parent directory → must save first.
        let err = write_attachment("untitled.md".into(), "attachments".into(), "x.png".into(), vec![0]);
        assert!(err.is_err());
    }

    #[test]
    fn read_image_bytes_reports_mime_by_extension() {
        let dir = temp_dir("readimg");
        let _ = fs::create_dir_all(&dir);
        let img = dir.join("pic.jpeg");
        fs::write(&img, [0xDE, 0xAD, 0xBE, 0xEF]).unwrap();
        let out = read_image_bytes(img.to_string_lossy().to_string()).unwrap();
        assert_eq!(out.bytes, vec![0xDE, 0xAD, 0xBE, 0xEF]);
        assert_eq!(out.mime, "image/jpeg");
        let _ = fs::remove_dir_all(&dir);
    }
}
