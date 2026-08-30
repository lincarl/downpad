// History content search (spec §5.8 "Inside documents"). Scans the recent-files
// list most-recent-first, reading each file and streaming matches back over a
// Tauri `ipc::Channel` (the documented streaming primitive — events are not).
// The scan runs on a blocking thread so `cancel_search` can flip the cancel
// token mid-run; progress ticks let the UI show "Searching file contents… N / …".
// Each content hit reports the 1-based line number of the first matching line.
//
// With the default 500-file cap a single-threaded scan finishes well under a
// second on an SSD (spec §10); rayon parallelism is a future optimisation.

use crate::error::AppError;
use crate::models::{SearchHit, SearchOpts, SearchSummary};
use crate::state::SearchState;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;

/// Context characters kept on each side of the match in a snippet, and the
/// overall snippet length cap. A short window keeps the streamed payload small
/// (one per matched file) while giving the result row enough surrounding text
/// to be useful (spec §5.8 "Inside documents").
const SNIPPET_CONTEXT_BEFORE: usize = 30;
const SNIPPET_MAX_CHARS: usize = 160;

/// First line of `content` containing `query` (case-insensitively unless
/// `case_sensitive`), as a 1-based line number plus a trimmed excerpt of that
/// line around the match. `None` if no line matches.
fn first_match(content: &str, query: &str, case_sensitive: bool) -> Option<(u32, String)> {
    let needle = fold(query, case_sensitive);
    if needle.is_empty() {
        return None; // an empty query is rejected upstream; stay defensive
    }
    for (i, line) in content.lines().enumerate() {
        if let Some(at) = match_char_index(line, &needle, case_sensitive) {
            return Some((i as u32 + 1, make_snippet(line, at, query.chars().count())));
        }
    }
    None
}

/// Case-fold `s` for matching: lowercased (char-by-char) unless `case_sensitive`.
/// Used for both the needle here and the haystack inside `match_char_index`, so
/// the two always fold the same way.
fn fold(s: &str, case_sensitive: bool) -> String {
    if case_sensitive {
        s.to_string()
    } else {
        s.chars().flat_map(char::to_lowercase).collect()
    }
}

/// Char index into `line` where the already-folded `needle` first matches, or
/// `None`. The match is a plain substring search on the folded haystack; the
/// result is mapped back to a char index in the *original* `line` via a parallel
/// origin table, which stays correct even when a character's lowercase expands
/// to several chars (e.g. 'İ' → "i\u{307}") — matching the prior
/// `to_lowercase().contains` behaviour while giving a usable snippet offset.
fn match_char_index(line: &str, needle: &str, case_sensitive: bool) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    // Fold the line char-by-char, recording for each folded char which original
    // char index it came from.
    let mut folded = String::new();
    let mut origin: Vec<usize> = Vec::new();
    for (ci, ch) in line.chars().enumerate() {
        if case_sensitive {
            folded.push(ch);
            origin.push(ci);
        } else {
            for lc in ch.to_lowercase() {
                folded.push(lc);
                origin.push(ci);
            }
        }
    }
    let byte = folded.find(needle)?;
    let folded_char_idx = folded[..byte].chars().count();
    Some(origin[folded_char_idx])
}

/// A one-line excerpt of `line` around the match at char index `at` (spanning
/// `query_chars` chars), elided with a leading/trailing `…` when text is cut.
/// Tabs and other control chars are flattened to spaces so the preview stays on
/// a single tidy line; the visible text is otherwise verbatim so the frontend
/// can re-locate and highlight the matched term.
fn make_snippet(line: &str, at: usize, query_chars: usize) -> String {
    let chars: Vec<char> = line
        .chars()
        .map(|c| if c == '\t' || c.is_control() { ' ' } else { c })
        .collect();
    let start = at.saturating_sub(SNIPPET_CONTEXT_BEFORE);
    // Cap the window, but never cut off the matched term itself for long queries
    // (`at + query_chars` is always within the line, so this stays in bounds).
    let end = (start + SNIPPET_MAX_CHARS).min(chars.len()).max(at + query_chars);

    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    out
}

fn run_search(
    paths: Vec<String>,
    query: String,
    opts: SearchOpts,
    on_result: Channel<SearchHit>,
    token: Arc<AtomicBool>,
) -> SearchSummary {
    let mut scanned = 0u32;
    let mut matched = 0u32;

    for path in paths {
        if token.load(Ordering::SeqCst) {
            return SearchSummary { scanned, matched, cancelled: true };
        }
        if !Path::new(&path).is_file() {
            continue; // missing files are skipped without error
        }
        scanned += 1;
        // Unreadable files (e.g. binary, permissions) are skipped silently.
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Some((line, snippet)) = first_match(&content, &query, opts.case_sensitive) {
                matched += 1;
                let _ = on_result.send(SearchHit {
                    kind: "content".into(),
                    path: path.clone(),
                    line: Some(line),
                    snippet: Some(snippet),
                    scanned,
                    matched,
                });
            }
        }
        if scanned % 25 == 0 {
            let _ = on_result.send(SearchHit {
                kind: "progress".into(),
                path: String::new(),
                line: None,
                snippet: None,
                scanned,
                matched,
            });
        }
    }
    SearchSummary { scanned, matched, cancelled: false }
}

#[tauri::command]
pub async fn search_recent_contents(
    state: tauri::State<'_, SearchState>,
    search_id: String,
    query: String,
    opts: SearchOpts,
    on_result: Channel<SearchHit>,
) -> Result<SearchSummary, AppError> {
    if query.trim().is_empty() {
        return Ok(SearchSummary { scanned: 0, matched: 0, cancelled: false });
    }
    let token = state.register(&search_id);
    let paths: Vec<String> = crate::commands::recent::get_recent_files(None)
        .unwrap_or_default()
        .into_iter()
        .map(|e| e.path)
        .collect();

    let summary = tauri::async_runtime::spawn_blocking(move || {
        run_search(paths, query, opts, on_result, token)
    })
    .await
    .map_err(|e| AppError::io(e.to_string()))?;

    state.unregister(&search_id);
    Ok(summary)
}

#[tauri::command]
pub fn cancel_search(state: tauri::State<'_, SearchState>, search_id: String) -> Result<(), AppError> {
    state.cancel(&search_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line_of(content: &str, query: &str, cs: bool) -> Option<u32> {
        first_match(content, query, cs).map(|(line, _)| line)
    }

    #[test]
    fn first_match_is_one_based_and_case_insensitive() {
        let content = "alpha\nthe Pasted Graph below\ngamma";
        assert_eq!(line_of(content, "graph", false), Some(2));
        assert_eq!(line_of(content, "GRAPH", false), Some(2));
        assert_eq!(line_of(content, "alpha", false), Some(1));
        assert_eq!(line_of(content, "missing", false), None);
    }

    #[test]
    fn case_sensitive_respects_case() {
        let content = "Graph\ngraph";
        assert_eq!(line_of(content, "graph", true), Some(2));
        assert_eq!(line_of(content, "Graph", true), Some(1));
    }

    #[test]
    fn snippet_is_the_short_line_verbatim_when_it_fits() {
        let (line, snippet) = first_match("alpha\nthe quick brown fox\ngamma", "quick", false).unwrap();
        assert_eq!(line, 2);
        // Short line: no elision, original casing preserved (frontend highlights).
        assert_eq!(snippet, "the quick brown fox");
    }

    #[test]
    fn snippet_elides_long_lines_around_the_match_and_keeps_the_term() {
        // Long context on both sides so the window is cut at both ends.
        let prefix = "x".repeat(200);
        let suffix = "y".repeat(200);
        let content = format!("{prefix} NEEDLE {suffix}");
        let (_, snippet) = first_match(&content, "needle", false).unwrap();
        assert!(snippet.starts_with('…'), "leading text was cut, expected a leading …");
        assert!(snippet.ends_with('…'), "trailing text was cut, expected a trailing …");
        assert!(snippet.contains("NEEDLE"), "the matched term must survive in the snippet");
        // Bounded length: window + the two ellipsis chars.
        assert!(snippet.chars().count() <= SNIPPET_MAX_CHARS + 2);
    }

    #[test]
    fn snippet_flattens_tabs_to_spaces() {
        let (_, snippet) = first_match("\t\tcode block hit", "hit", false).unwrap();
        assert!(!snippet.contains('\t'), "tabs should be flattened to spaces");
        assert!(snippet.contains("hit"));
    }

    #[test]
    fn snippet_keeps_a_long_query_intact() {
        // Query longer than the default window must not be truncated.
        let query = "z".repeat(200);
        let content = format!("prefix {query} suffix");
        let (_, snippet) = first_match(&content, &query, false).unwrap();
        assert!(snippet.contains(&query), "the full long query must be present");
    }

    #[test]
    fn matches_a_char_whose_lowercase_expands_to_several_chars() {
        // 'İ' (U+0130) lowercases to "i\u{307}". A file whose only 'i' is an İ
        // must still match the query "i" (parity with to_lowercase().contains).
        assert_eq!(line_of("İ", "i", false), Some(1));
        // …and a term that follows such a char is still located, not dropped.
        let (line, snippet) = first_match("İstanbul guide", "guide", false).unwrap();
        assert_eq!(line, 1);
        assert!(snippet.contains("guide"));
    }

    #[test]
    fn snippet_windowing_is_char_safe_with_multibyte_text() {
        // A long multi-byte prefix before the match must not panic (the window is
        // computed on chars, never bytes) and the match must survive, bounded.
        let prefix = "あ".repeat(80);
        let content = format!("日本語 {prefix} NEEDLE 末尾");
        let (_, snippet) = first_match(&content, "needle", false).unwrap();
        assert!(snippet.contains("NEEDLE"), "the matched term must survive");
        assert!(snippet.starts_with('…'), "the long multibyte prefix should be elided");
        assert!(snippet.chars().count() <= SNIPPET_MAX_CHARS + 2);
    }
}
