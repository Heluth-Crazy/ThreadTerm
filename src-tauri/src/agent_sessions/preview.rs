use super::types::MAX_PREVIEW_CHARS;

/// Collapse whitespace to a single line and truncate for catalog previews.
pub fn sanitize_preview(input: &str) -> Option<String> {
    let collapsed = input.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= MAX_PREVIEW_CHARS {
        return Some(trimmed.to_string());
    }
    let truncated: String = trimmed
        .chars()
        .take(MAX_PREVIEW_CHARS.saturating_sub(1))
        .collect();
    Some(format!("{truncated}…"))
}

pub fn is_generic_session_title(title: &str) -> bool {
    let normalized = title.trim().to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "" | "new session"
            | "new chat"
            | "untitled"
            | "untitled session"
            | "claude"
            | "codex"
            | "opencode"
            | "gemini"
    )
}

pub fn is_meaningful_user_text(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("<command-")
        || lower.starts_with("<local-command")
        || lower.starts_with("caveat:")
        || lower.contains("\"type\":\"tool_")
    {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_preview_collapses_and_truncates() {
        assert_eq!(
            sanitize_preview("  hello   world  "),
            Some("hello world".into())
        );
        assert_eq!(sanitize_preview("   \n\t  "), None);
        let long = "a".repeat(200);
        let preview = sanitize_preview(&long).expect("preview");
        assert!(preview.ends_with('…'));
        assert!(preview.chars().count() <= MAX_PREVIEW_CHARS);
    }

    #[test]
    fn generic_titles_are_detected() {
        assert!(is_generic_session_title("New session"));
        assert!(!is_generic_session_title("Fix login bug"));
    }

    #[test]
    fn filters_meta_user_text() {
        assert!(!is_meaningful_user_text(""));
        assert!(!is_meaningful_user_text("<command-name>foo</command-name>"));
        assert!(is_meaningful_user_text("Please fix the flaky test"));
    }
}
