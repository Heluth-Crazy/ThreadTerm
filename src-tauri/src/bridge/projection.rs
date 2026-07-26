use std::path::Path;

use crate::pty::{self, LivePtySessionSnapshot, SessionState};

use super::{
    preview::preview_from_output,
    protocol::{
        BridgeSnapshot, CardMeta, MobileWorkbenchProjection, NotificationEntry, ServerMessage,
        TerminalSnapshotMessage, TerminalStatus,
    },
    BridgeRuntime, PreparedCardRemoval,
};

#[derive(Default)]
pub(super) struct BridgeStateMirror {
    cards: Vec<CardMeta>,
    notifications: Vec<NotificationEntry>,
    workbench: Option<MobileWorkbenchProjection>,
    initialized: bool,
}

impl BridgeRuntime {
    pub fn snapshot(&self) -> BridgeSnapshot {
        self.snapshot_with_enricher(enrich_card_with_live_state)
    }

    pub(super) fn snapshot_with_enricher<F>(&self, mut enrich: F) -> BridgeSnapshot
    where
        F: FnMut(CardMeta) -> CardMeta,
    {
        let (initialized, cards, notifications, workbench) = self
            .state_mirror
            .lock()
            .map(|state| {
                (
                    state.initialized,
                    state.cards.clone(),
                    state.notifications.clone(),
                    state.workbench.clone(),
                )
            })
            .unwrap_or_else(|_| (false, Vec::new(), Vec::new(), None));
        if !initialized {
            return BridgeSnapshot {
                cards: Vec::new(),
                notifications: Vec::new(),
                workbench: None,
                warming_up: true,
                server_id: self.server_id().to_string(),
                runtime_id: self.runtime_id.clone(),
                stream_seq: self.current_terminal_stream_seq(),
            };
        }

        // F-01 lock discipline: CLONE under `state_mirror`, ENRICH outside
        // the lock. `enrich_card_with_live_state` calls
        // `pty::live_session_snapshot`, which reads PTY state. Acquiring the
        // PTY state lock while holding `state_mirror` is the reverse order of
        // `pty::session::set_session_state` -> `bridge::broadcast_state` ->
        // `card_id_for_pty` (which locks `state_mirror`); together they can
        // deadlock. The previous snapshot behavior (cards after enrichment)
        // is preserved bit-for-bit — only the lock scope changes.
        let cards = cards
            .into_iter()
            .map(|card| {
                #[cfg(test)]
                self.snapshot_card_enrichments
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                enrich(card)
            })
            .collect();

        BridgeSnapshot {
            cards,
            notifications,
            workbench,
            warming_up: false,
            server_id: self.server_id().to_string(),
            runtime_id: self.runtime_id.clone(),
            stream_seq: self.current_terminal_stream_seq(),
        }
    }

    pub fn sync_cards(&self, cards: Vec<CardMeta>) {
        if let Ok(mut mirror) = self.state_mirror.lock() {
            mirror.cards = cards;
            mirror.initialized = true;
        }
        self.broadcast_state_snapshot_if_subscribed();
    }

    pub fn sync_state(
        &self,
        cards: Vec<CardMeta>,
        notifications: Vec<NotificationEntry>,
        workbench: Option<MobileWorkbenchProjection>,
    ) {
        if let Ok(mut mirror) = self.state_mirror.lock() {
            mirror.cards = cards;
            mirror.notifications = notifications;
            mirror.workbench = workbench;
            mirror.initialized = true;
        }
        self.broadcast_state_snapshot_if_subscribed();
    }

    fn broadcast_state_snapshot_if_subscribed(&self) {
        // The mirror is durable bridge state and must always be updated, even
        // with no WebSocket clients. The enriched snapshot is broadcast-only
        // work; a later HTTP/WebSocket client builds a fresh snapshot on
        // demand, so there is no reason to serialize every live terminal now.
        if !self.has_subscribers() {
            return;
        }
        let snapshot = self.snapshot();
        self.broadcast(ServerMessage::from(snapshot.clone()));
        // FIX-2 (deep-research-defect-fix / second-diagnosis 问题一-D):
        // terminal_snapshot is sent ONLY on first connect / reconnect /
        // Lagged-recovery (server.rs::initial_messages_for_client) and on
        // single-card add (broadcast_card_added). Card-mirror metadata sync
        // must NOT re-broadcast every live card's full screen snapshot —
        // that was the dominant WS amplification under sustained output.
        // Live screen content is already delivered incrementally via the
        // independent broadcast_terminal_output channel, so dropping the
        // per-sync full re-snapshot does not lose any client state.
    }

    pub fn pty_id_for_card(&self, card_id: &str) -> String {
        self.state_mirror
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .cards
                    .iter()
                    .find(|card| card.id == card_id)
                    .and_then(|card| card.pty_id.clone())
            })
            .unwrap_or_else(|| card_id.to_string())
    }

    pub fn card_id_for_pty(&self, pty_id: &str) -> String {
        self.state_mirror
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .cards
                    .iter()
                    .find(|card| {
                        card.id == pty_id
                            || card
                                .pty_id
                                .as_deref()
                                .map(|candidate| candidate == pty_id)
                                .unwrap_or(false)
                    })
                    .map(|card| card.id.clone())
            })
            .unwrap_or_else(|| pty_id.to_string())
    }

    pub(super) fn mirrored_card_for_pty(&self, pty_id: &str) -> Option<CardMeta> {
        self.mirrored_card_for_pty_with_enricher(pty_id, enrich_card_with_live_state)
    }

    fn cloned_mirrored_card_for_pty(&self, pty_id: &str) -> Option<CardMeta> {
        self.state_mirror.lock().ok().and_then(|state| {
            state
                .cards
                .iter()
                .find(|card| {
                    card.id == pty_id
                        || card
                            .pty_id
                            .as_deref()
                            .map(|candidate| candidate == pty_id)
                            .unwrap_or(false)
                })
                .cloned()
        })
    }

    pub(super) fn mirrored_card_for_pty_with_enricher<F>(
        &self,
        pty_id: &str,
        enrich: F,
    ) -> Option<CardMeta>
    where
        F: FnOnce(CardMeta) -> CardMeta,
    {
        // F-01 lock discipline: find+clone under `state_mirror`, enrich
        // outside. `enrich_card_with_live_state` reenters PTY state via
        // `pty::live_session_snapshot`, which would reverse
        // `set_session_state`'s lock order and risk deadlock.
        self.cloned_mirrored_card_for_pty(pty_id).map(enrich)
    }

    fn mirrored_card_for_removal(&self, pty_id: &str) -> Option<CardMeta> {
        self.cloned_mirrored_card_for_pty(pty_id).map(|mut card| {
            card.pty_live = false;
            card.pty_state = None;
            card
        })
    }

    pub(super) fn prepare_card_removal(
        &self,
        pty_id: &str,
        state: SessionState,
        working_dir: &str,
    ) -> PreparedCardRemoval {
        let card = self
            .mirrored_card_for_removal(pty_id)
            .unwrap_or_else(|| card_meta_tombstone(pty_id, state, working_dir));
        PreparedCardRemoval { card }
    }
}

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

pub(super) fn terminal_snapshot_message(
    runtime: &BridgeRuntime,
    card_id: &str,
) -> Option<TerminalSnapshotMessage> {
    let pty_id = runtime.pty_id_for_card(card_id);
    let snapshot = pty::attach_snapshot_for_bridge(&pty_id)?;
    let bridge_card_id = runtime.card_id_for_pty(&snapshot.pty_id);
    Some(TerminalSnapshotMessage {
        card_id: bridge_card_id,
        data: snapshot.data,
        seq: snapshot.seq,
        runtime_id: runtime.runtime_id().to_string(),
        stream_seq: runtime.current_terminal_stream_seq(),
        rows: snapshot.rows,
        cols: snapshot.cols,
        cursor_row: snapshot.cursor_row,
        cursor_col: snapshot.cursor_col,
        history: snapshot.history,
    })
}

pub(super) fn enrich_card_with_live_state(mut card: CardMeta) -> CardMeta {
    let pty_id = card.pty_id.clone().unwrap_or_else(|| card.id.clone());
    let Some(snapshot) = pty::live_session_snapshot(&pty_id) else {
        card.pty_live = false;
        card.pty_state = None;
        return card;
    };

    let preview = preview_from_output(&snapshot.terminal_output);
    let status = TerminalStatus::from(snapshot.state);
    card.pty_id = Some(snapshot.id);
    card.status = status.clone();
    card.pty_live = true;
    card.pty_state = Some(status);
    card.recent_output_bytes = snapshot.recent_output.len();
    if !preview.last_reply_preview.is_empty() {
        card.last_reply_preview = preview.last_reply_preview;
        card.summary_line = preview.summary_line;
        card.hidden_line_count = preview.hidden_line_count;
    }
    card
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
