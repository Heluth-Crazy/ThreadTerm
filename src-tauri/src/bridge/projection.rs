use std::path::Path;

use crate::pty::{LivePtySessionSnapshot, SessionState};

use super::{
    preview::preview_from_output,
    protocol::{CardMeta, TerminalStatus},
};

pub(super) fn card_meta_tombstone(
    pty_id: &str,
    state: SessionState,
    working_dir: &str,
) -> CardMeta {
    CardMeta {
        id: pty_id.to_string(),
        pty_id: None,
        status: TerminalStatus::from(state),
        project_path: working_dir.to_string(),
        project_name: project_name_from_path(working_dir),
        worktree_path: None,
        branch_label: None,
        terminal_type: Some("shell".to_string()),
        command: None,
        created_at: None,
        last_activity: None,
        last_reply_preview: String::new(),
        summary_line: None,
        hidden_line_count: 0,
        recent_output_bytes: 0,
        message_count: None,
        unread: None,
        provider_session_state: None,
        pty_live: false,
        pty_state: None,
        attachable: false,
    }
}

pub(super) fn card_meta_from_live_session(snapshot: LivePtySessionSnapshot) -> CardMeta {
    let preview = preview_from_output(&snapshot.terminal_output);
    let project_name = project_name_from_path(&snapshot.working_dir);
    let status = TerminalStatus::from(snapshot.state);
    CardMeta {
        id: snapshot.id,
        pty_id: None,
        status: status.clone(),
        project_path: snapshot.working_dir,
        project_name,
        worktree_path: None,
        branch_label: None,
        terminal_type: Some("shell".to_string()),
        command: None,
        created_at: None,
        last_activity: None,
        last_reply_preview: preview.last_reply_preview,
        summary_line: preview.summary_line,
        hidden_line_count: preview.hidden_line_count,
        recent_output_bytes: snapshot.recent_output.len(),
        message_count: None,
        unread: None,
        provider_session_state: None,
        pty_live: true,
        pty_state: Some(status),
        attachable: true,
    }
}

fn project_name_from_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return "Unknown project".to_string();
    }

    Path::new(trimmed)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_name_uses_working_directory_leaf() {
        assert_eq!(
            project_name_from_path("/Users/me/projects/ThreadTerm"),
            "ThreadTerm"
        );
        assert_eq!(project_name_from_path(""), "Unknown project");
    }
}
