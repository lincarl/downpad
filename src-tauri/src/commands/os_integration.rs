// OS integration (spec §5.12, §5.15, design §3.6): launch-argument handling, the
// default-.md-handler status check, and the deep link into Windows Default Apps.

use crate::error::AppError;
use crate::models::DefaultHandler;
use std::path::Path;

const MD_EXTS: [&str; 5] = ["md", "markdown", "mdown", "mkd", "txt"];

fn is_markdown_path(arg: &str) -> bool {
    let p = Path::new(arg);
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| MD_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// First CLI argument (after the exe) that names a markdown/openable file.
/// Used by both startup and the single-instance second-launch callback.
pub fn first_md_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| !a.starts_with('-') && (is_markdown_path(a) || Path::new(a).is_file()))
        .cloned()
}

/// The markdown file md-easy was launched with, if any (spec §5.12, §5.15).
#[tauri::command]
pub fn get_launch_args() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    first_md_arg(&args)
}

/// Weak fallback that matches a ProgId *name*. Windows derives the `.md`
/// UserChoice ProgId from the installer, and Tauri registers ours under the
/// file-type description ("Markdown Document") — which contains none of these
/// substrings — so this would miss the real default. The authoritative check
/// resolves the ProgId's open command (see `exe_is_md_easy`); this only covers
/// the rare case where that command can't be read.
fn looks_like_md_easy(prog_id: &str) -> bool {
    let p = prog_id.to_ascii_lowercase();
    p.contains("md-easy") || p.contains("md_easy") || p.contains("se.elysics")
}

/// The executable a `shell\open\command` string launches: handles both
/// `"C:\…\md-easy.exe" "%1"` (quoted) and `C:\…\md-easy.exe "%1"` (unquoted).
fn exe_from_command(cmd: &str) -> Option<String> {
    let cmd = cmd.trim();
    if cmd.is_empty() {
        return None;
    }
    if let Some(rest) = cmd.strip_prefix('"') {
        // Quoted exe: everything up to the closing quote.
        return rest.split('"').next().map(str::to_string).filter(|s| !s.is_empty());
    }
    // Unquoted: a path may contain spaces, so cut just past the first ".exe"
    // rather than at the first space; fall back to the first token otherwise.
    let lower = cmd.to_ascii_lowercase();
    match lower.find(".exe") {
        Some(i) => Some(cmd[..i + 4].to_string()),
        None => cmd.split_whitespace().next().map(str::to_string),
    }
}

/// Normalize a path string for comparison: trim, drop the `\\?\` long-path
/// prefix, unify separators, and lowercase.
fn norm_path(s: &str) -> String {
    s.trim()
        .trim_start_matches(r"\\?\")
        .replace('/', "\\")
        .to_ascii_lowercase()
}

/// Last path component (file name) of a path string.
fn file_name_of(s: &str) -> &str {
    let s = s.trim().trim_end_matches(['\\', '/']);
    match s.rfind(['\\', '/']) {
        Some(i) => &s[i + 1..],
        None => s,
    }
}

/// True if a handler executable is md-easy: the very same file as `current_exe`
/// when that's known, otherwise any file named `md-easy.exe` (so running the dev
/// binary still recognizes the *installed* exe that owns the association). This
/// matches on the executable, not the ProgId's (installer-chosen) name, which is
/// what makes the check robust to however Windows named the ProgId.
fn exe_is_md_easy(handler_exe: &str, current_exe: Option<&str>) -> bool {
    if let Some(cur) = current_exe {
        if norm_path(handler_exe) == norm_path(cur) {
            return true;
        }
    }
    file_name_of(handler_exe).eq_ignore_ascii_case("md-easy.exe")
}

#[cfg(target_os = "windows")]
fn read_md_prog_id() -> String {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey(
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice",
    )
    .and_then(|k| k.get_value::<String, _>("ProgId"))
    .unwrap_or_default()
}

#[cfg(not(target_os = "windows"))]
fn read_md_prog_id() -> String {
    String::new()
}

/// The `shell\open\command` registered for a ProgId — looked up per-user first
/// (where per-user installs and our own ProgId live), then in the merged HKCR
/// view (covers machine-wide installs).
#[cfg(target_os = "windows")]
fn read_prog_id_command(prog_id: &str) -> Option<String> {
    use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER};
    use winreg::RegKey;
    if prog_id.is_empty() {
        return None;
    }
    let tail = format!(r"{prog_id}\shell\open\command");
    let read = |root: RegKey, sub: &str| -> Option<String> {
        root.open_subkey(sub)
            .ok()
            .and_then(|k| k.get_value::<String, _>("").ok())
            .filter(|v| !v.is_empty())
    };
    read(RegKey::predef(HKEY_CURRENT_USER), &format!(r"Software\Classes\{tail}"))
        .or_else(|| read(RegKey::predef(HKEY_CLASSES_ROOT), &tail))
}

#[cfg(not(target_os = "windows"))]
fn read_prog_id_command(_prog_id: &str) -> Option<String> {
    None
}

/// Read the current default handler for .md (spec §5.12). We resolve the
/// UserChoice ProgId's open command and check whether it launches md-easy —
/// matching on the executable, not the ProgId's installer-chosen name (which is
/// "Markdown Document", containing no "md-easy" substring). Windows-only registry
/// read; other platforms report "unknown".
#[tauri::command]
pub fn get_default_md_handler() -> Result<DefaultHandler, AppError> {
    let prog_id = read_md_prog_id();
    let current = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let is_default = read_prog_id_command(&prog_id)
        .and_then(|cmd| exe_from_command(&cmd))
        .map(|exe| exe_is_md_easy(&exe, current.as_deref()))
        .unwrap_or(false)
        || looks_like_md_easy(&prog_id);
    Ok(DefaultHandler { is_default, prog_id })
}

/// Read the current Windows accent color (Personalization → Colors), returned as
/// a `#rrggbb` hex string, or `None` when unavailable / off-Windows (spec §6.2,
/// "Follow system" accent). DWM stores `AccentColor` as a 0xAABBGGRR DWORD.
#[cfg(target_os = "windows")]
fn read_system_accent() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let dwm = hkcu.open_subkey(r"Software\Microsoft\Windows\DWM").ok()?;
    let abgr: u32 = dwm.get_value("AccentColor").ok()?;
    let r = abgr & 0xFF;
    let g = (abgr >> 8) & 0xFF;
    let b = (abgr >> 16) & 0xFF;
    Some(format!("#{r:02x}{g:02x}{b:02x}"))
}

#[cfg(not(target_os = "windows"))]
fn read_system_accent() -> Option<String> {
    None
}

/// The OS accent color as `#rrggbb`, or `None` if it can't be read (spec §6.2).
#[tauri::command]
pub fn get_system_accent_color() -> Option<String> {
    read_system_accent()
}

/// The app's one name (spec §6.1). It is both UI text and registry identity: the
/// title Windows shows on the Default Apps page (the Capabilities
/// `ApplicationName`), the value published under
/// HKCU\Software\RegisteredApplications, and the value passed to the Settings deep
/// link that opens md-easy's own page (spec §5.12). A hyphen is URI-unreserved, so
/// it needs no escaping in the query string. One constant, so the name the user
/// reads and the name Windows keys off cannot drift apart.
const APP_NAME: &str = "md-easy";

/// ProgId md-easy registers for markdown files under HKCU\Software\Classes.
#[cfg(target_os = "windows")]
const MD_PROG_ID: &str = "md-easy.md";

/// The Settings URI to open. When md-easy is registered as a default-capable
/// program we deep-link straight to *its* Default Apps page (Win11 21H2+ with the
/// 2023-04 cumulative update lists .md right there, so the user doesn't have to
/// hunt the full app list); otherwise we fall back to the general page. Pure, so
/// it's unit-tested. See spec §5.12.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn default_apps_uri(registered: bool) -> String {
    if registered {
        format!("ms-settings:defaultapps?registeredAppUser={APP_NAME}")
    } else {
        "ms-settings:defaultapps".to_string()
    }
}

/// Register md-easy as a Windows "default-capable" program for .md/.markdown in
/// HKCU (unprivileged, idempotent): a ProgId whose open command points at the
/// current executable, a Capabilities key declaring the file associations, and
/// the RegisteredApplications entry tying them together. This does NOT make
/// md-easy the default — Windows reserves that for an explicit user choice — it
/// makes md-easy *appear* on its own Default Apps page so the deep link below has
/// somewhere to land. Spec §5.12.
#[cfg(target_os = "windows")]
fn register_md_capabilities() -> Result<(), AppError> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let exe = std::env::current_exe()
        .map_err(|e| AppError::io(format!("can't resolve current exe: {e}")))?;
    let exe = exe.to_string_lossy();
    let open_cmd = format!("\"{exe}\" \"%1\"");
    let icon = format!("\"{exe}\",0");

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let create = |path: &str| -> Result<RegKey, AppError> {
        hkcu.create_subkey(path)
            .map(|(k, _)| k)
            .map_err(|e| AppError::io(format!("registry write failed ({path}): {e}")))
    };

    // ProgId: how Windows actually opens a .md once md-easy is chosen as default.
    create(&format!(r"Software\Classes\{MD_PROG_ID}"))?.set_value("", &"Markdown Document").ok();
    create(&format!(r"Software\Classes\{MD_PROG_ID}\DefaultIcon"))?.set_value("", &icon).ok();
    create(&format!(r"Software\Classes\{MD_PROG_ID}\shell\open\command"))?
        .set_value("", &open_cmd)
        .ok();

    // Capabilities: declares which extensions md-easy can be the default for.
    let caps = create(r"Software\md-easy\Capabilities")?;
    caps.set_value("ApplicationName", &APP_NAME).ok();
    caps.set_value(
        "ApplicationDescription",
        &"A lightweight, pure-WYSIWYG markdown editor",
    )
    .ok();
    let fa = create(r"Software\md-easy\Capabilities\FileAssociations")?;
    fa.set_value(".md", &MD_PROG_ID).ok();
    fa.set_value(".markdown", &MD_PROG_ID).ok();

    // Tie it together so Settings (and the deep link) can find md-easy by name.
    create(r"Software\RegisteredApplications")?
        .set_value(APP_NAME, &r"Software\md-easy\Capabilities")
        .ok();

    Ok(())
}

/// Open Windows "Default apps" Settings so the user can pick md-easy for .md.
/// Windows won't let an app claim associations silently (spec §5.12), but we can
/// (best effort) register md-easy as a default-capable program and then deep-link
/// straight to its own page — which lists .md — so the user lands exactly where
/// they need to be instead of scrolling the full app list. Falls back to the
/// general Default Apps page if registration or the deep link isn't available.
#[tauri::command]
pub fn open_default_apps_settings() -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    {
        let registered = register_md_capabilities().is_ok();
        let uri = default_apps_uri(registered);
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &uri])
            .spawn()
            .map_err(|e| AppError::io(format!("couldn't open Default apps: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_apps_uri_deep_links_to_md_easy_only_when_registered() {
        // Registered → md-easy's own page (lists .md); otherwise the general page.
        assert_eq!(
            default_apps_uri(true),
            "ms-settings:defaultapps?registeredAppUser=md-easy"
        );
        assert_eq!(default_apps_uri(false), "ms-settings:defaultapps");
    }

    #[test]
    fn is_markdown_path_matches_known_extensions() {
        assert!(is_markdown_path("notes.md"));
        assert!(is_markdown_path("README.MARKDOWN"));
        assert!(!is_markdown_path("image.png"));
    }

    #[test]
    fn exe_from_command_handles_quoted_and_unquoted() {
        assert_eq!(
            exe_from_command(r#""C:\Users\me\AppData\Local\md-easy\md-easy.exe" "%1""#).as_deref(),
            Some(r"C:\Users\me\AppData\Local\md-easy\md-easy.exe")
        );
        // Unquoted path containing a space must not be cut at the space.
        assert_eq!(
            exe_from_command(r#"C:\Program Files\md-easy\md-easy.exe "%1""#).as_deref(),
            Some(r"C:\Program Files\md-easy\md-easy.exe")
        );
        assert_eq!(exe_from_command("   ").as_deref(), None);
    }

    #[test]
    fn exe_is_md_easy_matches_by_name_or_full_path() {
        // The regression this fixes: Windows set the .md default to a ProgId
        // literally named "Markdown Document", but its open command launches
        // md-easy.exe — so md-easy IS the default regardless of the ProgId name.
        assert!(exe_is_md_easy(r"C:\X\md-easy.exe", None));
        assert!(!exe_is_md_easy(r"C:\X\notepad.exe", None));
        // Same exe with differing case / separators still counts as us.
        assert!(exe_is_md_easy(r"C:\Apps\md-easy.exe", Some("c:/apps/md-easy.exe")));
        // A different exe at a different path is not us.
        assert!(!exe_is_md_easy(r"C:\Other\app.exe", Some(r"C:\Mine\md-easy.exe")));
    }
}
