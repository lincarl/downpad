// Serde payload structs shared across commands. These mirror the TypeScript
// types in src/ipc/contracts.ts 1:1; `rename_all = "camelCase"` keeps the wire
// format aligned with the spec's identifiers and the frontend.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePayload {
    /// File text, BOM-stripped and LF-normalized (the canonical in-memory form).
    pub content: String,
    /// Dominant line-ending style of the file on disk: "lf" | "crlf".
    pub eol: String,
    /// Whether the file began with a UTF-8 BOM (stripped here, never re-written).
    pub had_bom: bool,
    pub size_bytes: u64,
    /// Last-modified time in milliseconds since the Unix epoch.
    pub modified_ms: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub modified_ms: i64,
}

/// Raw image bytes plus a best-effort MIME type (by file extension). Used to
/// relocate a missing image and to copy an image to the clipboard (spec §5.5).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageBytes {
    pub bytes: Vec<u8>,
    pub mime: String,
}

/// A recent-files history entry as exposed over IPC (friendly camelCase shape).
/// The compact on-disk `{ p, t, f }` representation (spec §5.8.1) lives in
/// `commands::recent`; this is the form the frontend consumes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    /// Absolute path as last opened; original spelling preserved for display.
    pub path: String,
    /// Last opened, epoch milliseconds (UTC); larger means more recent.
    pub last_opened_ms: i64,
    /// Favorite (starred) flag.
    pub favorite: bool,
}

/// Live disk stat for a recent row (spec §5.8 row layout): existence + size,
/// plus whether the containing folder still exists (for the "Open folder"
/// context-menu item, which §5.8 disables when the folder is gone).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub exists: bool,
    /// Size in bytes (0 when the file is missing).
    pub size_bytes: u64,
    /// Whether the file's parent directory currently exists.
    pub folder_exists: bool,
}

/// Options for the history content search (spec §5.8.1). Substring match.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOpts {
    pub case_sensitive: bool,
}

/// A streamed content-search result or progress tick (design §3.4). For a
/// "content" hit, `line` is the 1-based number of the first matching line
/// (spec §5.8 "Inside documents") and `snippet` is a trimmed excerpt of that
/// line around the match (for the result-row preview); for a "progress"
/// tick both are `None`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// "content" for a match, "progress" for a periodic counter tick.
    pub kind: String,
    pub path: String,
    pub line: Option<u32>,
    /// Excerpt of the matching line (elided with `…`); `None` for progress.
    pub snippet: Option<String>,
    pub scanned: u32,
    pub matched: u32,
}

/// Returned when a content search finishes (or is cancelled).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSummary {
    pub scanned: u32,
    pub matched: u32,
    pub cancelled: bool,
}

/// Payload of the `file-changed` event (spec §5.1 reload banner, design §3.7).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChanged {
    pub path: String,
    pub modified_ms: i64,
}

/// The current default handler for .md files (spec §5.12).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultHandler {
    /// The ProgId Windows reports for .md (empty if unknown / not set).
    pub prog_id: String,
    /// Whether that handler appears to be md-easy.
    pub is_default: bool,
}

/// A crash-recovery snapshot (spec §5.11), matching the on-disk JSON shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub session_id: String,
    /// ISO-8601 timestamp (supplied by the frontend).
    pub saved_at: String,
    pub file_path: Option<String>,
    pub markdown: String,
    pub is_dirty: bool,
}
