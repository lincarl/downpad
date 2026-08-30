// Recent-files history (spec §5.8.1). Stored separately from settings in
// the platform config directory so settings.toml stays small and hand-editable.
//
// On disk the file is a **compact JSON array** of `{ "p", "t", "f" }` objects
// (path, epoch-ms last-opened, favorite) written atomically — `f` is omitted
// when false to keep the file small. Over IPC we expose the friendlier
// `RecentEntry { path, lastOpenedMs, favorite }`. The list is LRU-capped at
// `recentFilesMaxRetained`; the timestamp is supplied by the frontend
// (`Date.now()`) so the backend needs no date crate.

use crate::error::AppError;
use crate::io::atomic;
use crate::models::{FileStat, RecentEntry};
use crate::settings;
use serde::{Deserialize, Serialize};

/// On-disk shape (compact keys, spec §5.8.1). `f` omitted when false.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DiskEntry {
    p: String,
    t: i64,
    #[serde(default, skip_serializing_if = "is_false")]
    f: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

impl DiskEntry {
    fn to_ipc(&self) -> RecentEntry {
        RecentEntry {
            path: self.p.clone(),
            last_opened_ms: self.t,
            favorite: self.f,
        }
    }
}

/// Pre-v0.10 on-disk shape (`{ path, lastOpened, openCount }`). Kept only so we
/// can migrate an existing history forward instead of silently wiping it.
#[derive(Debug, Deserialize)]
struct LegacyEntry {
    path: String,
    #[serde(rename = "lastOpened")]
    last_opened: String,
}

fn recent_file() -> Result<std::path::PathBuf, AppError> {
    Ok(settings::config_dir()?.join("recent.json"))
}

/// Parse recent.json, preferring the compact `{p,t,f}` array and falling back to
/// the legacy `{path,lastOpened,openCount}` shape (migrated in-memory; `t` from
/// the ISO timestamp, favorite defaulted false). Unparseable content yields an
/// empty list (callers never overwrite the file purely on a read failure here).
fn parse_entries(text: &str) -> Vec<DiskEntry> {
    if let Ok(entries) = serde_json::from_str::<Vec<DiskEntry>>(text) {
        return entries;
    }
    if let Ok(legacy) = serde_json::from_str::<Vec<LegacyEntry>>(text) {
        return legacy
            .into_iter()
            .map(|e| DiskEntry {
                p: e.path,
                t: iso_to_epoch_ms(&e.last_opened).unwrap_or(0),
                f: false,
            })
            .collect();
    }
    Vec::new()
}

fn load() -> Vec<DiskEntry> {
    let path = match recent_file() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => parse_entries(&text),
        Err(_) => Vec::new(),
    }
}

/// Convert an ISO-8601 timestamp like `2026-05-25T15:42:11Z` to epoch ms (UTC).
/// Minimal parser (no date crate) using Howard Hinnant's days-from-civil; any
/// trailing fractional seconds / zone suffix is ignored. `None` if malformed.
fn iso_to_epoch_ms(s: &str) -> Option<i64> {
    if s.len() < 19 {
        return None;
    }
    let n = |a: usize, b: usize| s.get(a..b).and_then(|p| p.parse::<i64>().ok());
    let (year, mon, day) = (n(0, 4)?, n(5, 7)?, n(8, 10)?);
    let (hh, mm, ss) = (n(11, 13)?, n(14, 16)?, n(17, 19)?);
    if !(1..=12).contains(&mon) || !(1..=31).contains(&day) {
        return None;
    }
    let y = if mon <= 2 { year - 1 } else { year };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = if mon > 2 { mon - 3 } else { mon + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some((days * 86400 + hh * 3600 + mm * 60 + ss) * 1000)
}

/// Persist most-recent-first as a compact (non-pretty) JSON array.
fn store(entries: &[DiskEntry]) -> Result<(), AppError> {
    let path = recent_file()?;
    let json = serde_json::to_string(entries).map_err(|e| AppError::io(e.to_string()))?;
    atomic::write_atomic(&path, json.as_bytes())
}

/// Normalized dedup key (spec §5.8.1): separators → `/` and `.`/`..` resolved.
/// Windows paths are lower-cased because that filesystem is case-insensitive;
/// Unix path case is retained.
/// Only matching/dedup uses this; the original spelling is kept for display.
fn path_key(p: &str) -> String {
    let unified = p.replace('\\', "/");
    let mut segments: Vec<&str> = Vec::new();
    for seg in unified.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            s => segments.push(s),
        }
    }
    let key = segments.join("/");
    if cfg!(target_os = "windows") {
        key.to_lowercase()
    } else {
        key
    }
}

fn same_path(a: &str, b: &str) -> bool {
    path_key(a) == path_key(b)
}

/// Sort most-recent-first (largest `t` first) and LRU-evict to the cap.
fn sort_and_cap(entries: &mut Vec<DiskEntry>) {
    entries.sort_by(|a, b| b.t.cmp(&a.t));
    let cap = settings::load_or_default().recent_files_max_retained as usize;
    if entries.len() > cap {
        entries.truncate(cap);
    }
}

/// Most-recent-first, optionally limited.
#[tauri::command]
pub fn get_recent_files(limit: Option<u32>) -> Result<Vec<RecentEntry>, AppError> {
    let mut entries = load();
    entries.sort_by(|a, b| b.t.cmp(&a.t));
    if let Some(n) = limit {
        entries.truncate(n as usize);
    }
    Ok(entries.iter().map(DiskEntry::to_ipc).collect())
}

/// Upsert on open (spec §5.8.1): move the entry to the front and refresh `t`,
/// preserving the favorite flag; dedupe by normalized path key; then LRU-evict
/// down to `recentFilesMaxRetained` (oldest `t` dropped first). `opened_at_ms`
/// is epoch milliseconds from the frontend (`Date.now()`).
#[tauri::command]
pub fn record_file_opened(path: String, opened_at_ms: i64) -> Result<RecentEntry, AppError> {
    let mut entries = load();
    let entry = match entries.iter_mut().find(|e| same_path(&e.p, &path)) {
        Some(existing) => {
            // Refresh timestamp and adopt the latest spelling; keep favorite.
            existing.t = opened_at_ms;
            existing.p = path.clone();
            existing.to_ipc()
        }
        None => {
            let e = DiskEntry { p: path.clone(), t: opened_at_ms, f: false };
            entries.push(e.clone());
            e.to_ipc()
        }
    };
    sort_and_cap(&mut entries);
    store(&entries)?;
    Ok(entry)
}

/// Toggle/set the favorite flag on an existing entry and persist immediately
/// (spec §5.8 star). No-op error if the path is no longer in history.
#[tauri::command]
pub fn set_favorite(path: String, favorite: bool) -> Result<RecentEntry, AppError> {
    let mut entries = load();
    let found = entries.iter_mut().find(|e| same_path(&e.p, &path));
    match found {
        Some(e) => {
            e.f = favorite;
            let ipc = e.to_ipc();
            store(&entries)?;
            Ok(ipc)
        }
        None => Err(AppError::io("file is not in recent history")),
    }
}

#[tauri::command]
pub fn remove_recent(path: String) -> Result<(), AppError> {
    let mut entries = load();
    entries.retain(|e| !same_path(&e.p, &path));
    store(&entries)
}

/// Live disk stat for the visible rows (spec §5.8 row layout): existence, size,
/// and whether the containing folder still exists.
#[tauri::command]
pub fn stat_files(paths: Vec<String>) -> Result<Vec<FileStat>, AppError> {
    Ok(paths
        .into_iter()
        .map(|p| {
            let folder_exists = std::path::Path::new(&p)
                .parent()
                .map(|d| d.is_dir())
                .unwrap_or(false);
            match std::fs::metadata(&p) {
                Ok(m) if m.is_file() => {
                    FileStat { path: p, exists: true, size_bytes: m.len(), folder_exists }
                }
                _ => FileStat { path: p, exists: false, size_bytes: 0, folder_exists },
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(p: &str, t: i64, f: bool) -> DiskEntry {
        DiskEntry { p: p.into(), t, f }
    }

    #[test]
    fn path_key_normalizes_for_the_current_platform() {
        let expected = if cfg!(target_os = "windows") {
            "c:/users/me/doc.md"
        } else {
            "C:/Users/Me/Doc.md"
        };
        assert_eq!(path_key("C:\\Users\\Me\\Doc.md"), expected);
        // `.` and `..` resolve.
        let expected = if cfg!(target_os = "windows") {
            "c:/a/c.md"
        } else {
            "C:/a/c.md"
        };
        assert_eq!(path_key("C:/a/./b/../c.md"), expected);
    }

    #[test]
    fn dedup_uses_the_platforms_case_semantics() {
        assert_eq!(
            same_path("C:\\N\\Doc.md", "c:/n/doc.md"),
            cfg!(target_os = "windows")
        );
        assert!(!same_path("a.md", "b.md"));
    }

    #[test]
    fn most_recent_first_sort() {
        let mut v = vec![
            entry("a", 100, false),
            entry("b", 300, false),
            entry("c", 200, false),
        ];
        v.sort_by(|a, b| b.t.cmp(&a.t));
        assert_eq!(v.iter().map(|e| e.p.as_str()).collect::<Vec<_>>(), ["b", "c", "a"]);
    }

    #[test]
    fn favorite_false_is_omitted_on_disk() {
        let json = serde_json::to_string(&[entry("a.md", 5, false)]).unwrap();
        assert_eq!(json, r#"[{"p":"a.md","t":5}]"#);
        let json = serde_json::to_string(&[entry("a.md", 5, true)]).unwrap();
        assert_eq!(json, r#"[{"p":"a.md","t":5,"f":true}]"#);
    }

    #[test]
    fn disk_entry_round_trips_without_f() {
        let parsed: Vec<DiskEntry> = serde_json::from_str(r#"[{"p":"a.md","t":7}]"#).unwrap();
        assert_eq!(parsed.len(), 1);
        assert!(!parsed[0].f);
        assert_eq!(parsed[0].t, 7);
    }

    #[test]
    fn iso_to_epoch_ms_matches_known_values() {
        // 1970-01-01T00:00:00Z == 0.
        assert_eq!(iso_to_epoch_ms("1970-01-01T00:00:00Z"), Some(0));
        // 2026-05-25T15:42:11Z == 1779723731 s.
        assert_eq!(iso_to_epoch_ms("2026-05-25T15:42:11Z"), Some(1_779_723_731_000));
        // Fractional seconds / offset suffix ignored.
        assert_eq!(iso_to_epoch_ms("2026-05-25T15:42:11.500Z"), Some(1_779_723_731_000));
        assert_eq!(iso_to_epoch_ms("garbage"), None);
    }

    #[test]
    fn parse_entries_reads_new_format() {
        let v = parse_entries(r#"[{"p":"a.md","t":5,"f":true}]"#);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].p, "a.md");
        assert!(v[0].f);
    }

    #[test]
    fn parse_entries_migrates_legacy_format_without_losing_history() {
        // Pre-v0.10 shape must not be dropped — it migrates to {p,t,f:false}.
        let legacy = r#"[{"path":"C:/n/a.md","lastOpened":"2026-05-25T15:42:11Z","openCount":12}]"#;
        let v = parse_entries(legacy);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].p, "C:/n/a.md");
        assert_eq!(v[0].t, 1_779_723_731_000);
        assert!(!v[0].f);
    }

    #[test]
    fn parse_entries_empty_and_garbage() {
        assert!(parse_entries("[]").is_empty());
        assert!(parse_entries("not json").is_empty());
    }
}
