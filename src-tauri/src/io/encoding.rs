// UTF-8 / BOM / line-ending handling (spec §5.18). Mirrors the TypeScript
// helpers in src/document/lineEndings.ts. The canonical in-memory form is
// always UTF-8, BOM-stripped, LF-normalized; the original EOL is re-applied on
// write so files round-trip.

const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// Strip a leading UTF-8 BOM. Returns the body and whether a BOM was present.
pub fn strip_bom(bytes: &[u8]) -> (&[u8], bool) {
    if bytes.starts_with(&BOM) {
        (&bytes[3..], true)
    } else {
        (bytes, false)
    }
}

/// Detect the dominant EOL of raw file text. CRLF majority (and ties) → "crlf".
pub fn detect_eol(text: &str) -> &'static str {
    let crlf = text.matches("\r\n").count();
    let total_lf = text.matches('\n').count();
    let lone_lf = total_lf - crlf;
    if crlf == 0 && lone_lf == 0 {
        return "lf";
    }
    if crlf >= lone_lf {
        "crlf"
    } else {
        "lf"
    }
}

/// Normalize CRLF and lone CR to LF.
pub fn normalize_to_lf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Re-apply an EOL style to LF-normalized text for writing.
pub fn apply_eol(lf_text: &str, eol: &str) -> String {
    if eol == "crlf" {
        lf_text.replace('\n', "\r\n")
    } else {
        lf_text.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_bom() {
        let with_bom = [0xEF, 0xBB, 0xBF, b'h', b'i'];
        assert_eq!(strip_bom(&with_bom), (&b"hi"[..], true));
        assert_eq!(strip_bom(b"hi"), (&b"hi"[..], false));
    }

    #[test]
    fn detects_eol() {
        assert_eq!(detect_eol("a\r\nb\r\n"), "crlf");
        assert_eq!(detect_eol("a\nb\n"), "lf");
        assert_eq!(detect_eol("no newlines"), "lf");
        assert_eq!(detect_eol("a\r\nb\nc"), "crlf"); // tie -> crlf
    }

    #[test]
    fn round_trips_crlf() {
        let original = "# T\r\n\r\nBody\r\n";
        let lf = normalize_to_lf(original);
        assert_eq!(lf, "# T\n\nBody\n");
        assert_eq!(apply_eol(&lf, "crlf"), original);
    }

    #[test]
    fn normalizes_mixed() {
        assert_eq!(normalize_to_lf("a\rb\r\nc\nd"), "a\nb\nc\nd");
    }
}
