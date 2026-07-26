use once_cell::sync::Lazy;
use regex::Regex;

const PREVIEW_MAX_LINES: usize = 8;

static ANSI_STRIP: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()][A-Za-z0-9])")
        .expect("invalid bridge ansi regex")
});
static CONTROL_STRIP: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]").expect("invalid bridge control regex")
});

#[derive(Debug, PartialEq, Eq)]
pub(super) struct BridgePreview {
    pub(super) last_reply_preview: String,
    pub(super) summary_line: Option<String>,
    pub(super) hidden_line_count: usize,
}

pub(super) fn preview_from_output(output: &str) -> BridgePreview {
    let ansi_cleaned = ANSI_STRIP.replace_all(output, "");
    let control_cleaned = CONTROL_STRIP.replace_all(&ansi_cleaned, "");
    let newline_cleaned = control_cleaned.replace('\r', "\n");
    let all_lines: Vec<String> = newline_cleaned
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.chars().take(240).collect::<String>())
        .collect();
    let composer_stripped_lines = strip_trailing_ai_composer_region(&all_lines);
    let source_lines = if composer_stripped_lines.is_empty() {
        all_lines
    } else {
        composer_stripped_lines
    };
    let filtered_lines: Vec<String> = source_lines
        .iter()
        .filter(|line| !is_mobile_preview_noise_line(line))
        .cloned()
        .collect();
    let lines = if filtered_lines.is_empty() {
        source_lines
    } else {
        filtered_lines
    };
    let lines = dedupe_preview_lines(lines);

    let hidden_line_count = lines.len().saturating_sub(PREVIEW_MAX_LINES);
    let visible_lines = lines
        .iter()
        .skip(hidden_line_count)
        .cloned()
        .collect::<Vec<_>>();
    let summary_line = summary_line_from_preview_lines(&visible_lines);

    BridgePreview {
        last_reply_preview: visible_lines.join("\n"),
        summary_line,
        hidden_line_count,
    }
}

fn strip_trailing_ai_composer_region(lines: &[String]) -> Vec<String> {
    let mut end = lines.len();
    let mut saw_composer_chrome = false;

    while end > 0 && is_ai_composer_chrome_line(&lines[end - 1]) {
        saw_composer_chrome = true;
        end -= 1;
    }

    let mut removed_composer_input = false;
    while end > 0 && is_ai_composer_input_line(&lines[end - 1], saw_composer_chrome) {
        removed_composer_input = true;
        saw_composer_chrome = true;
        end -= 1;
    }

    if removed_composer_input {
        while end > 0 && is_ai_composer_chrome_line(&lines[end - 1]) {
            end -= 1;
        }
    }

    lines[..end].to_vec()
}

fn is_ai_composer_chrome_line(line: &str) -> bool {
    let normalized = line.trim();
    normalized.is_empty() || is_mobile_preview_noise_line(normalized)
}

fn is_ai_composer_input_line(line: &str, saw_composer_chrome: bool) -> bool {
    let normalized = line.trim();
    let Some(first) = normalized.chars().next() else {
        return false;
    };

    matches!(first, '›' | '❯' | '▸' | '▹' | '▶' | '➤')
        || (saw_composer_chrome && normalized.starts_with("> "))
}

fn dedupe_preview_lines(lines: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for line in lines {
        let duplicate = out
            .last()
            .map(|previous: &String| preview_signature(previous) == preview_signature(&line))
            .unwrap_or(false);
        if !duplicate {
            out.push(line);
        }
    }
    out
}

fn preview_signature(line: &str) -> String {
    line.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn summary_line_from_preview_lines(lines: &[String]) -> Option<String> {
    lines.iter().rev().find_map(|line| {
        let trimmed = line.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn is_mobile_preview_noise_line(line: &str) -> bool {
    let normalized = line.trim();
    let lower = normalized.to_lowercase();

    lower.contains("trellis sessionstart")
        || lower.contains("hooks need review before they can run")
        || lower.contains("open /hooks to review")
        || lower.contains("mcp startup incomplete")
        || lower.contains("mcp client for")
        || lower.contains("starting mcp")
        || lower.contains("mcp servers")
        || (lower.contains("tip:") && lower.contains("/fast"))
        || normalized.starts_with('›')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_strips_ansi_and_reports_hidden_lines() {
        let input = "\x1b[31mone\x1b[0m\n\n two \nthree\nfour\nfive\nsix\nseven\neight\nnine\n";
        let preview = preview_from_output(input);

        assert_eq!(preview.hidden_line_count, 1);
        assert_eq!(preview.summary_line.as_deref(), Some("nine"));
        assert!(!preview.last_reply_preview.contains("\x1b"));
        assert!(preview.last_reply_preview.starts_with("two"));
        assert!(preview.last_reply_preview.ends_with("nine"));
    }

    #[test]
    fn preview_filters_mobile_bridge_noise() {
        let input = [
            "• Trellis SessionStart injected: workflow loaded",
            "MCP client for `pencil` failed to start",
            "Open /hooks to review them.",
            "Real assistant response line",
            "› Summarize recent commits",
        ]
        .join("\n");
        let preview = preview_from_output(&input);

        assert_eq!(preview.hidden_line_count, 0);
        assert_eq!(preview.last_reply_preview, "Real assistant response line");
        assert_eq!(
            preview.summary_line.as_deref(),
            Some("Real assistant response line")
        );
    }

    #[test]
    fn preview_keeps_output_when_every_line_matches_noise_filter() {
        let input = "MCP startup incomplete\n› waiting for input\n";
        let preview = preview_from_output(input);

        assert_eq!(preview.hidden_line_count, 0);
        assert!(preview
            .last_reply_preview
            .contains("MCP startup incomplete"));
        assert!(preview.last_reply_preview.contains("waiting for input"));
    }

    #[test]
    fn preview_summary_ignores_trailing_ai_composer_prompt() {
        let input = "Here is the answer.\nIt is safe to continue.\n› Summarize recent commits\n";
        let preview = preview_from_output(input);

        assert_eq!(
            preview.summary_line.as_deref(),
            Some("It is safe to continue.")
        );
        assert!(!preview
            .last_reply_preview
            .contains("Summarize recent commits"));
    }

    #[test]
    fn preview_deduplicates_repeated_mobile_lines() {
        let input = "收到，测试消息正常。\n收到，测试消息正常。\n下一步继续。\n";
        let preview = preview_from_output(input);

        assert_eq!(
            preview.last_reply_preview,
            "收到，测试消息正常。\n下一步继续。"
        );
        assert_eq!(preview.summary_line.as_deref(), Some("下一步继续。"));
    }

    #[test]
    fn preview_preserves_lines_split_across_output_chunks_when_source_is_cumulative() {
        // Mirrors the bridge path where emit_pty_output_chunk previews the
        // terminal snapshot/cumulative output, not just the latest raw chunk.
        let first_chunk = "Building pack";
        let second_chunk = "age\nDone\n";
        let cumulative = format!("{first_chunk}{second_chunk}");
        let latest_chunk_only = preview_from_output(second_chunk);
        let preview = preview_from_output(&cumulative);

        assert_eq!(latest_chunk_only.summary_line.as_deref(), Some("Done"));
        assert_eq!(preview.last_reply_preview, "Building package\nDone");
        assert_eq!(preview.summary_line.as_deref(), Some("Done"));
    }
}
