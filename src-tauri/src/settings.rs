// Settings model and persistence (spec §5.9). Stored in the platform's native
// per-user config directory (for example %APPDATA% on Windows and
// $XDG_CONFIG_HOME, or ~/.config, on Linux).
// as hand-editable TOML with comments. Loading is resilient (missing keys fall
// back to defaults); saving patches values into the existing document via
// toml_edit so the user's comments and key order are preserved.

use crate::error::AppError;
use crate::io::atomic;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use toml_edit::{DocumentMut, Item, Value};

/// `mdHardWrap` is either `false` (no wrapping) or an integer column.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum HardWrap {
    Off(bool),
    Column(u32),
}

impl Default for HardWrap {
    fn default() -> Self {
        HardWrap::Off(false)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,
    pub editor_theme: String,
    /// Accent (highlight) color source: "default" (built-in blue) | "system"
    /// (the Windows accent color) | "custom" (`accent_color`). See spec §6.2.
    pub accent_mode: String,
    /// Custom accent color as a #rrggbb hex string, used when accent_mode = "custom".
    pub accent_color: String,
    /// Page width mode: "fill" (the column fills the window and adapts on resize)
    /// or "fixed" (capped at `editor_width_px`). Default "fixed".
    pub editor_width_mode: String,
    pub editor_width_px: u32,
    pub font_family: String,
    pub editor_font_scale: f64,

    pub attachments_folder_name: String,
    pub embed_images_as_base64: bool,
    // `rename_all = "camelCase"` would emit `maxEmbedSizeKb`, but the spec, the
    // settings.toml template, and the whole TS frontend use `maxEmbedSizeKB`
    // (KB as an acronym). Pin the exact key so (de)serialization round-trips the
    // canonical name — otherwise the frontend reads `undefined` and every pasted
    // image is forced to the attachments folder (spec §5.5).
    #[serde(rename = "maxEmbedSizeKB")]
    pub max_embed_size_kb: u32,

    pub link_display: String,

    pub recent_files_max_retained: u32,
    pub recent_files_visible_count: u32,

    pub default_view: String,
    pub collapse_base64_in_raw_view: bool,
    pub spell_check_enabled: bool,
    /// Show a leading YAML `---` block above the WYSIWYG editor as a VS Code-style
    /// editable key/value table (spec §5.17). On by default; either way the YAML is
    /// kept byte-for-byte and is editable in the Markdown view.
    pub show_frontmatter_panel: bool,
    /// Tabs (most-recently-used) whose editors stay live so undo history survives
    /// tab switches and the view toggle (spec §5.19). Clamped to 1..=20 on load.
    pub max_retained_tab_editors: u32,

    pub md_bullet_char: String,
    pub md_emphasis_char: String,
    pub md_strong_char: String,
    pub md_heading_style: String,
    pub md_hard_wrap: HardWrap,

    pub autosave_enabled: bool,
    pub autosave_interval_seconds: u32,
    pub recovery_snapshot_interval_seconds: u32,
    pub recovery_retention_days: u32,

    // Printing (spec §5.21). The print workspace opens with these and writes back
    // whatever the user changed, so the next print starts where they left off.
    pub print_version: String,
    pub print_paper_size: String,
    pub print_orientation: String,
    pub print_margins: String,
    pub print_scale_percent: u32,
    pub print_header_title: bool,
    pub print_header_date: bool,
    pub print_footer_page_numbers: bool,
    /// Last chosen printer; empty means the system default.
    pub printer_name: String,
    pub print_copies: u32,

    pub has_seen_welcome: bool,
    /// Whether the one-time "set md-easy as the default .md handler?" check has
    /// already run (spec §5.12). Set true after the first launch so the check
    /// and prompt never happen again — subsequent launches spend no time on it.
    pub has_checked_default_handler: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "dark".into(),
            editor_theme: "light".into(),
            accent_mode: "default".into(),
            accent_color: "#0067c0".into(),
            editor_width_mode: "fixed".into(),
            editor_width_px: 1188,
            font_family: "Segoe UI".into(),
            editor_font_scale: 1.0,
            attachments_folder_name: "attachments".into(),
            embed_images_as_base64: true,
            max_embed_size_kb: 10240,
            link_display: "text-and-url".into(),
            recent_files_max_retained: 500,
            recent_files_visible_count: 100,
            default_view: "document".into(),
            collapse_base64_in_raw_view: true,
            spell_check_enabled: true,
            show_frontmatter_panel: true,
            max_retained_tab_editors: 5,
            md_bullet_char: "-".into(),
            md_emphasis_char: "*".into(),
            md_strong_char: "**".into(),
            md_heading_style: "atx".into(),
            md_hard_wrap: HardWrap::Off(false),
            autosave_enabled: false,
            autosave_interval_seconds: 30,
            recovery_snapshot_interval_seconds: 10,
            recovery_retention_days: 7,
            print_version: "document".into(),
            print_paper_size: "a4".into(),
            print_orientation: "portrait".into(),
            print_margins: "normal".into(),
            print_scale_percent: 100,
            print_header_title: false,
            print_header_date: false,
            print_footer_page_numbers: true,
            printer_name: String::new(),
            print_copies: 1,
            has_seen_welcome: false,
            has_checked_default_handler: false,
        }
    }
}

// Uses an `r##"…"##` delimiter (not `r#"…"#`) because the template contains hex
// color values like `"#0067c0"`; the `"#` in those would otherwise close a
// single-hash raw string early.
const TEMPLATE: &str = r##"# md-easy settings — edit by hand or via the in-app Settings dialog.
# Changes are watched and applied live.

theme = "dark"                    # UI theme: "system" | "light" | "dark"
editorTheme = "light"             # document text theme: "follow-ui" | "light" | "dark"
accentMode = "default"           # accent/highlight color: "default" (blue) | "system" (Windows accent) | "custom"
accentColor = "#0067c0"          # custom accent as #rrggbb, used when accentMode = "custom"
editorWidthMode = "fixed"        # page width: "fill" (fills window, adapts on resize) | "fixed" (editorWidthPx)
editorWidthPx = 1188             # column width when editorWidthMode = "fixed"
fontFamily = "Segoe UI"
editorFontScale = 1.0            # document text size multiplier (toolbar A-/A+); 1.0 = 100%

attachmentsFolderName = "attachments"
embedImagesAsBase64 = true
maxEmbedSizeKB = 10240           # images above this size go to the attachments folder instead of base64 (10240 = 10 MiB)

linkDisplay = "text-and-url"     # "text-and-url" | "text-only"

recentFilesMaxRetained = 500     # max entries kept in recent.json (LRU)
recentFilesVisibleCount = 100    # rows shown when not filtering; clamped to recentFilesMaxRetained

defaultView = "document"         # editor layout new docs open in: "document" | "split" (both) | "markdown"
collapseBase64InRawView = true
spellCheckEnabled = true
showFrontmatterPanel = true      # show a leading YAML --- block as an editable key/value table above the editor (§5.17)
maxRetainedTabEditors = 5        # tabs that keep live undo history across switches/toggle (1–20)

# Markdown serialization (how WYSIWYG edits are written back; see 5.16)
mdBulletChar = "-"               # "-" | "*" | "+"
mdEmphasisChar = "*"             # "*" | "_"  (italic)
mdStrongChar = "**"              # "**" | "__" (bold)
mdHeadingStyle = "atx"           # "atx" | "setext"
mdHardWrap = false               # false, or an integer column to hard-wrap at

autosaveEnabled = false          # recovery snapshots are always on regardless of this
autosaveIntervalSeconds = 30
recoverySnapshotIntervalSeconds = 10
recoveryRetentionDays = 7

# Printing (5.21) — remembered from the print workspace
printVersion = "document"        # what goes on paper: "document" (formatted) | "markdown" (source)
printPaperSize = "a4"            # "a4" | "letter" | "legal" | "a5"
printOrientation = "portrait"    # "portrait" | "landscape"
printMargins = "normal"          # "normal" (20mm) | "narrow" (10mm) | "wide" (30mm) | "none"
printScalePercent = 100          # document scale on the page, 50-200
printHeaderTitle = false         # file name in the running header
printHeaderDate = false          # date in the running header
printFooterPageNumbers = true    # "n / total" in the running footer
printerName = ""                 # last used printer; empty = system default
printCopies = 1

hasSeenWelcome = false
hasCheckedDefaultHandler = false  # set true after the one-time first-run "set as default .md app?" check (§5.12)
"##;

pub fn config_dir() -> Result<PathBuf, AppError> {
    let dir = platform_config_dir()?.join("md-easy");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(target_os = "windows")]
fn platform_config_dir() -> Result<PathBuf, AppError> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| AppError::io("APPDATA is not set"))
}

#[cfg(target_os = "linux")]
fn platform_config_dir() -> Result<PathBuf, AppError> {
    if let Some(path) = std::env::var_os("XDG_CONFIG_HOME").filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".config"))
        .ok_or_else(|| AppError::io("neither XDG_CONFIG_HOME nor HOME is set"))
}

#[cfg(target_os = "macos")]
fn platform_config_dir() -> Result<PathBuf, AppError> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Library").join("Application Support"))
        .ok_or_else(|| AppError::io("HOME is not set"))
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn platform_config_dir() -> Result<PathBuf, AppError> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".config"))
        .ok_or_else(|| AppError::io("HOME is not set"))
}

pub fn settings_file() -> Result<PathBuf, AppError> {
    Ok(config_dir()?.join("settings.toml"))
}

/// Load settings, creating the commented template on first run. Malformed files
/// fall back to defaults rather than failing (the app must stay usable).
pub fn load_or_default() -> Settings {
    let path = match settings_file() {
        Ok(p) => p,
        Err(_) => return Settings::default(),
    };
    if !path.exists() {
        let _ = atomic::write_atomic(&path, TEMPLATE.as_bytes());
    }
    let mut settings = match std::fs::read_to_string(&path) {
        Ok(text) => toml::from_str(&text).unwrap_or_default(),
        Err(_) => Settings::default(),
    };
    // Spec §5.9: recentFilesVisibleCount is clamped to recentFilesMaxRetained.
    settings.recent_files_visible_count = settings
        .recent_files_visible_count
        .min(settings.recent_files_max_retained);
    // Spec §5.19: keep the live-editor retention within a sane bound (a hand-edited
    // 0 would disable retention entirely; a huge value would exhaust memory).
    settings.max_retained_tab_editors = settings.max_retained_tab_editors.clamp(1, 20);
    // Spec §5.21: a hand-edited scale of 0 (or 5000) would render an unusable page.
    settings.print_scale_percent = settings.print_scale_percent.clamp(50, 200);
    settings.print_copies = settings.print_copies.clamp(1, 999);
    settings
}

/// Persist settings, patching the existing document to preserve comments/order.
pub fn save(settings: &Settings) -> Result<(), AppError> {
    let path = settings_file()?;
    let existing = std::fs::read_to_string(&path).unwrap_or_else(|_| TEMPLATE.to_string());
    let mut doc = existing
        .parse::<DocumentMut>()
        .unwrap_or_else(|_| TEMPLATE.parse().expect("template is valid TOML"));
    apply(settings, &mut doc);
    atomic::write_atomic(&path, doc.to_string().as_bytes())
}

/// Set a key's value while preserving its existing decor — the surrounding
/// whitespace and, crucially, any trailing inline `# comment`. (A plain
/// `doc[key] = value(..)` would discard the comment.)
fn set<T: Into<Value>>(doc: &mut DocumentMut, key: &str, val: T) {
    let mut new_val: Value = val.into();
    if let Some(existing) = doc.get(key).and_then(Item::as_value) {
        *new_val.decor_mut() = existing.decor().clone();
    }
    doc[key] = Item::Value(new_val);
}

fn apply(s: &Settings, doc: &mut DocumentMut) {
    set(doc, "theme", s.theme.as_str());
    set(doc, "editorTheme", s.editor_theme.as_str());
    set(doc, "accentMode", s.accent_mode.as_str());
    set(doc, "accentColor", s.accent_color.as_str());
    set(doc, "editorWidthMode", s.editor_width_mode.as_str());
    set(doc, "editorWidthPx", s.editor_width_px as i64);
    set(doc, "fontFamily", s.font_family.as_str());
    set(doc, "editorFontScale", s.editor_font_scale);
    set(doc, "attachmentsFolderName", s.attachments_folder_name.as_str());
    set(doc, "embedImagesAsBase64", s.embed_images_as_base64);
    set(doc, "maxEmbedSizeKB", s.max_embed_size_kb as i64);
    set(doc, "linkDisplay", s.link_display.as_str());
    set(doc, "recentFilesMaxRetained", s.recent_files_max_retained as i64);
    set(doc, "recentFilesVisibleCount", s.recent_files_visible_count as i64);
    set(doc, "defaultView", s.default_view.as_str());
    set(doc, "collapseBase64InRawView", s.collapse_base64_in_raw_view);
    set(doc, "spellCheckEnabled", s.spell_check_enabled);
    set(doc, "showFrontmatterPanel", s.show_frontmatter_panel);
    set(doc, "maxRetainedTabEditors", s.max_retained_tab_editors as i64);
    set(doc, "mdBulletChar", s.md_bullet_char.as_str());
    set(doc, "mdEmphasisChar", s.md_emphasis_char.as_str());
    set(doc, "mdStrongChar", s.md_strong_char.as_str());
    set(doc, "mdHeadingStyle", s.md_heading_style.as_str());
    match &s.md_hard_wrap {
        // The "off" state always serializes as the literal `false` (a stray
        // `mdHardWrap = true` is normalized, keeping the value `false | number`).
        HardWrap::Off(_) => set(doc, "mdHardWrap", false),
        HardWrap::Column(n) => set(doc, "mdHardWrap", *n as i64),
    }
    set(doc, "autosaveEnabled", s.autosave_enabled);
    set(doc, "autosaveIntervalSeconds", s.autosave_interval_seconds as i64);
    set(doc, "recoverySnapshotIntervalSeconds", s.recovery_snapshot_interval_seconds as i64);
    set(doc, "recoveryRetentionDays", s.recovery_retention_days as i64);
    set(doc, "printVersion", s.print_version.as_str());
    set(doc, "printPaperSize", s.print_paper_size.as_str());
    set(doc, "printOrientation", s.print_orientation.as_str());
    set(doc, "printMargins", s.print_margins.as_str());
    set(doc, "printScalePercent", s.print_scale_percent as i64);
    set(doc, "printHeaderTitle", s.print_header_title);
    set(doc, "printHeaderDate", s.print_header_date);
    set(doc, "printFooterPageNumbers", s.print_footer_page_numbers);
    set(doc, "printerName", s.printer_name.as_str());
    set(doc, "printCopies", s.print_copies as i64);
    set(doc, "hasSeenWelcome", s.has_seen_welcome);
    set(doc, "hasCheckedDefaultHandler", s.has_checked_default_handler);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_parses_into_defaults() {
        let s: Settings = toml::from_str(TEMPLATE).unwrap();
        assert_eq!(s.editor_width_px, 1188);
        assert_eq!(s.md_bullet_char, "-");
        assert!(matches!(s.md_hard_wrap, HardWrap::Off(false)));
        assert_eq!(s.theme, "dark");
        assert_eq!(s.editor_theme, "light");
        assert_eq!(s.max_embed_size_kb, 10240);
        assert_eq!(s.accent_mode, "default");
        assert_eq!(s.accent_color, "#0067c0");
        assert_eq!(s.editor_width_mode, "fixed");
        assert!(!s.has_checked_default_handler);
        assert!(s.show_frontmatter_panel);
    }

    /// The written template and the in-memory `Default` are two separate copies of
    /// the same defaults; a change to one that misses the other would give a fresh
    /// install different settings depending on whether the file had been written
    /// yet. The running header is off out of the box (spec §5.21), the footer on.
    #[test]
    fn print_running_head_defaults_match_between_template_and_default() {
        let from_template: Settings = toml::from_str(TEMPLATE).unwrap();
        let from_default = Settings::default();
        for s in [&from_template, &from_default] {
            assert!(!s.print_header_title, "document title must default to off");
            assert!(!s.print_header_date, "date must default to off");
            assert!(s.print_footer_page_numbers, "page numbers must default to on");
        }
    }

    #[test]
    fn show_frontmatter_panel_round_trips_and_defaults_true() {
        // A settings.toml predating the key must default the table ON (the frontmatter
        // table is the standard view), and an edited value must survive the
        // save→reparse round-trip so the user's choice isn't silently dropped.
        let legacy: Settings = toml::from_str("theme = \"dark\"\n").unwrap();
        assert!(legacy.show_frontmatter_panel);

        let mut doc = TEMPLATE.parse::<DocumentMut>().unwrap();
        let mut s = Settings::default();
        s.show_frontmatter_panel = false;
        apply(&s, &mut doc);
        let reparsed: Settings = toml::from_str(&doc.to_string()).unwrap();
        assert!(!reparsed.show_frontmatter_panel);
    }

    #[test]
    fn accent_and_width_mode_round_trip_through_save() {
        // A settings.toml predating these keys must still load (serde `default`),
        // and edited values must survive the save→reparse round-trip — otherwise
        // the user's accent / page-width choice is silently dropped (the bug the
        // maxEmbedSizeKB test guards against, applied to the new fields).
        let legacy: Settings = toml::from_str("theme = \"dark\"\n").unwrap();
        assert_eq!(legacy.accent_mode, "default");
        assert_eq!(legacy.editor_width_mode, "fixed");

        let mut doc = TEMPLATE.parse::<DocumentMut>().unwrap();
        let mut s = Settings::default();
        s.accent_mode = "custom".into();
        s.accent_color = "#ff8800".into();
        s.editor_width_mode = "fixed".into();
        apply(&s, &mut doc);
        let reparsed: Settings = toml::from_str(&doc.to_string()).unwrap();
        assert_eq!(reparsed.accent_mode, "custom");
        assert_eq!(reparsed.accent_color, "#ff8800");
        assert_eq!(reparsed.editor_width_mode, "fixed");
    }

    #[test]
    fn has_checked_default_handler_round_trips_and_defaults_false() {
        // A settings.toml predating the key must default the flag to false (so the
        // one-time default-handler check still runs once after upgrade), and once
        // set true it must survive the save→reparse round-trip — otherwise the
        // prompt would reappear on every launch (the very thing it must not do).
        let legacy: Settings = toml::from_str("theme = \"dark\"\n").unwrap();
        assert!(!legacy.has_checked_default_handler);

        let mut doc = TEMPLATE.parse::<DocumentMut>().unwrap();
        let mut s = Settings::default();
        s.has_checked_default_handler = true;
        apply(&s, &mut doc);
        let reparsed: Settings = toml::from_str(&doc.to_string()).unwrap();
        assert!(reparsed.has_checked_default_handler);
    }

    #[test]
    fn max_embed_size_kb_uses_the_canonical_camelcase_key() {
        // The frontend (and settings.toml) spell this `maxEmbedSizeKB`; the serde
        // default camelCase would emit `maxEmbedSizeKb`, which the TS side reads as
        // `undefined` → every pasted image is wrongly sent to attachments.
        let json = serde_json::to_value(Settings::default()).unwrap();
        assert!(json.get("maxEmbedSizeKB").is_some(), "JSON key must be maxEmbedSizeKB");
        assert!(json.get("maxEmbedSizeKb").is_none(), "must not emit lowercase-b variant");

        // A hand-edited value in settings.toml must actually be read back.
        let parsed: Settings = toml::from_str("maxEmbedSizeKB = 512\n").unwrap();
        assert_eq!(parsed.max_embed_size_kb, 512);
    }

    #[test]
    fn apply_preserves_comments_and_updates_values() {
        let mut doc = TEMPLATE.parse::<DocumentMut>().unwrap();
        let mut s = Settings::default();
        s.md_bullet_char = "*".into();
        s.editor_width_px = 900;
        s.md_hard_wrap = HardWrap::Column(80);
        apply(&s, &mut doc);
        let out = doc.to_string();
        // Comments survive.
        assert!(out.contains("# md-easy settings"));
        assert!(out.contains("(italic)"));
        // Values updated.
        assert!(out.contains("mdBulletChar = \"*\""));
        assert!(out.contains("editorWidthPx = 900"));
        assert!(out.contains("mdHardWrap = 80"));
        // Re-parses cleanly.
        let reparsed: Settings = toml::from_str(&out).unwrap();
        assert_eq!(reparsed.editor_width_px, 900);
        assert!(matches!(reparsed.md_hard_wrap, HardWrap::Column(80)));
    }
}
