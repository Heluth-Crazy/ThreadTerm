mod access;
mod messages;
mod terminal;
mod theme;
mod v2;
mod workbench;

#[allow(unused_imports)]
pub use access::{
    BridgeDevice, BridgeStatus, ClientClass, DevicePermission, MobileCardRequest, MobileCloseMode,
    MobileCloseRequest, MobileCloseResolution, MobileRenameCardRequest, MobileSpawnCardRequest,
    PairQrResponse, PairRequest, PairResponse,
};
#[allow(unused_imports)]
pub use messages::{
    parse_client_message, versioned_server_message, ClientMessage, ProtocolParseError,
    ServerMessage, VersionedServerMessage,
};
pub use terminal::{CardMeta, TerminalSnapshotMessage, TerminalStatus};
pub use theme::{AppThemeTokens, BridgeTheme, TerminalThemeTokens, ThemeMode};
#[allow(unused_imports)]
pub use v2::{
    draft_patch_from_message, is_v1_forbidden_workspace_kind, parse_v2_client_message,
    versioned_v2_server_message, SecurePairQrResponse, SecurePairRequest, SecurePairResponse,
    V2ClientMessage, V2ProtocolParseError, V2ServerMessage, VersionedV2ServerMessage,
    WorkspaceMetaSnapshot, MAX_V2_PAYLOAD_BYTES, PROTOCOL_VERSION_V2, V1_FORBIDDEN_WORKSPACE_KINDS,
};
#[allow(unused_imports)]
pub use workbench::{
    BridgeSnapshot, MobileAttentionCapability, MobileAttentionItem, MobileExecutionGroup,
    MobileProjectWorkbenchOverview, MobileWorkbenchCapabilities, MobileWorkbenchProjection,
    MobileWorkbenchRules, MobileWorkbenchSummary, NotificationEntry, NotificationRouting,
};

pub const PROTOCOL_VERSION: u16 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_protocol_messages_with_stable_kind_names_and_version() {
        let message = ServerMessage::State {
            card_id: "card-1".to_string(),
            status: TerminalStatus::WaitingForInput,
        };

        let json = serde_json::to_value(versioned_server_message(message))
            .expect("serialize protocol message");
        assert_eq!(json["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(json["kind"], "state");
        assert_eq!(json["card_id"], "card-1");
        assert_eq!(json["status"], "waiting_for_input");
    }

    #[test]
    fn snapshot_preserves_the_server_identity_for_mobile_clients() {
        let message: ServerMessage = BridgeSnapshot {
            cards: Vec::new(),
            notifications: Vec::new(),
            workbench: None,
            warming_up: false,
            server_id: "server-a".to_string(),
            runtime_id: "runtime-a".to_string(),
            stream_seq: 7,
        }
        .into();

        let json = serde_json::to_value(versioned_server_message(message))
            .expect("serialize bridge snapshot");
        assert_eq!(json["kind"], "snapshot");
        assert_eq!(json["serverId"], "server-a");
        assert_eq!(json["runtimeId"], "runtime-a");
        assert_eq!(json["streamSeq"], 7);
    }

    #[test]
    fn workbench_projection_defaults_new_read_only_fields_for_older_desktops() {
        let projection: MobileWorkbenchProjection = serde_json::from_value(serde_json::json!({
            "generatedAt": 123,
            "summary": {
                "attention": 0,
                "normalRunning": 1,
                "review": 0,
                "failed": 0
            },
            "attentionItems": [],
            "executionGroups": [],
            "rules": {
                "includeWaiting": true,
                "includeFailed": true,
                "includeCompletedReview": true,
                "stalledEnabled": false,
                "stalledThresholdMinutes": 30,
                "stalledExcludedCount": 0
            },
            "capabilities": {
                "openTerminal": true,
                "respondToStructuredRequest": false,
                "updateRules": false,
                "updateNotificationReadState": false
            }
        }))
        .expect("deserialize legacy workbench projection");

        assert!(projection.followed_card_ids.is_empty());
        assert!(projection.project_overviews.is_empty());
        let json = serde_json::to_value(projection).expect("serialize workbench projection");
        assert!(json.get("followedCardIds").is_none());
        assert!(json.get("projectOverviews").is_none());
    }

    #[test]
    fn serializes_card_meta_context_for_mobile_clients() {
        let card = CardMeta {
            id: "card-1".to_string(),
            pty_id: Some("pty-1".to_string()),
            status: TerminalStatus::Idle,
            project_path: "/tmp/ThreadTerm".to_string(),
            project_name: "ThreadTerm".to_string(),
            worktree_path: None,
            branch_label: Some("mobile".to_string()),
            terminal_type: Some("codex".to_string()),
            command: None,
            created_at: Some(123),
            last_activity: Some(456),
            last_reply_preview: "recent output".to_string(),
            summary_line: Some("latest reply".to_string()),
            hidden_line_count: 2,
            recent_output_bytes: 128,
            message_count: Some(7),
            unread: Some(true),
            provider_session_state: Some("bound".to_string()),
            pty_live: false,
            pty_state: None,
            attachable: true,
        };

        let json = serde_json::to_value(card).expect("serialize card meta");
        assert_eq!(json["ptyId"], "pty-1");
        assert_eq!(json["projectPath"], "/tmp/ThreadTerm");
        assert_eq!(json["projectName"], "ThreadTerm");
        assert_eq!(json["branchLabel"], "mobile");
        assert_eq!(json["terminalType"], "codex");
        assert_eq!(json["summaryLine"], "latest reply");
        assert_eq!(json["hiddenLineCount"], 2);
        assert_eq!(json["messageCount"], 7);
        assert_eq!(json["unread"], true);
        assert_eq!(json["attachable"], true);
    }

    #[test]
    fn serializes_terminal_snapshot_and_output_for_mobile_clients() {
        let snapshot = TerminalSnapshotMessage {
            card_id: "card-1".to_string(),
            data: "\u{1b}[1;1Hready".to_string(),
            seq: 42,
            runtime_id: "runtime-a".to_string(),
            stream_seq: 9,
            rows: 24,
            cols: 80,
            cursor_row: 1,
            cursor_col: 6,
            history: Some("previous line\r\n".to_string()),
        };

        let snapshot_json =
            serde_json::to_value(versioned_server_message(ServerMessage::TerminalSnapshot {
                snapshot: snapshot.clone(),
            }))
            .expect("serialize terminal snapshot");
        assert_eq!(snapshot_json["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(snapshot_json["kind"], "terminal_snapshot");
        assert_eq!(snapshot_json["snapshot"]["cardId"], "card-1");
        assert_eq!(snapshot_json["snapshot"]["runtimeId"], "runtime-a");
        assert_eq!(snapshot_json["snapshot"]["streamSeq"], 9);
        assert_eq!(snapshot_json["snapshot"]["cursorRow"], 1);
        assert_eq!(snapshot_json["snapshot"]["history"], "previous line\r\n");

        let output_json =
            serde_json::to_value(versioned_server_message(ServerMessage::TerminalOutput {
                card_id: "card-1".to_string(),
                data: " streamed".to_string(),
                seq: 43,
                runtime_id: "runtime-a".to_string(),
                stream_seq: 10,
            }))
            .expect("serialize terminal output");
        assert_eq!(output_json["kind"], "terminal_output");
        assert_eq!(output_json["card_id"], "card-1");
        assert_eq!(output_json["data"], " streamed");
        assert_eq!(output_json["seq"], 43);
        assert_eq!(output_json["runtimeId"], "runtime-a");
        assert_eq!(output_json["streamSeq"], 10);
    }

    #[test]
    fn serializes_theme_message_for_mobile_clients() {
        let theme = BridgeTheme::default();
        let json = serde_json::to_value(versioned_server_message(ServerMessage::Theme {
            app: theme.app,
            terminal: theme.terminal,
            mode: theme.mode,
        }))
        .expect("serialize theme message");

        assert_eq!(json["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(json["kind"], "theme");
        assert_eq!(json["mode"], "dark");
        assert_eq!(json["app"]["cardForeground"], "#e8edf5");
        assert_eq!(json["terminal"]["brightCyan"], "#22d3ee");
    }

    #[test]
    fn serializes_exact_exit_code_for_mobile_clients() {
        let json = serde_json::to_value(versioned_server_message(ServerMessage::Exit {
            card_id: "card-1".to_string(),
            code: Some(127),
        }))
        .expect("serialize exit message");

        assert_eq!(json["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(json["kind"], "exit");
        assert_eq!(json["card_id"], "card-1");
        assert_eq!(json["code"], 127);
    }

    #[test]
    fn parses_client_input_message() {
        let message = parse_client_message(
            r#"{"protocol_version":1,"kind":"input","card_id":"card-1","data":"y\n"}"#,
        )
        .expect("parse client input");

        match message {
            ClientMessage::Input { card_id, data } => {
                assert_eq!(card_id, "card-1");
                assert_eq!(data, "y\n");
            }
            _ => panic!("expected input message"),
        }
    }

    #[test]
    fn parses_client_auth_message() {
        let message =
            parse_client_message(r#"{"protocol_version":1,"kind":"auth","token":"device-token"}"#)
                .expect("parse client auth");

        match message {
            ClientMessage::Auth { token } => assert_eq!(token, "device-token"),
            _ => panic!("expected auth message"),
        }
    }

    #[test]
    fn parses_terminal_resync_message() {
        let message = parse_client_message(r#"{"protocol_version":1,"kind":"terminal_resync"}"#)
            .expect("parse terminal resync");

        assert!(matches!(message, ClientMessage::TerminalResync));
    }

    #[test]
    fn parses_mobile_control_messages() {
        let spawn = parse_client_message(
            r#"{"protocol_version":1,"kind":"spawn","request_id":"req-1","terminal_type":"codex","project_path":"/tmp/app","command":"codex"}"#,
        )
        .expect("parse spawn");
        match spawn {
            ClientMessage::Spawn {
                request_id,
                terminal_type,
                project_path,
                command,
            } => {
                assert_eq!(request_id, "req-1");
                assert_eq!(terminal_type, "codex");
                assert_eq!(project_path, "/tmp/app");
                assert_eq!(command.as_deref(), Some("codex"));
            }
            _ => panic!("expected spawn message"),
        }

        let activate = parse_client_message(
            r#"{"protocol_version":1,"kind":"activate","request_id":"req-2","card_id":"card-1"}"#,
        )
        .expect("parse activate");
        match activate {
            ClientMessage::Activate {
                request_id,
                card_id,
            } => {
                assert_eq!(request_id, "req-2");
                assert_eq!(card_id, "card-1");
            }
            _ => panic!("expected activate message"),
        }

        let legacy_close = parse_client_message(
            r#"{"protocol_version":1,"kind":"close","request_id":"req-3","card_id":"card-1"}"#,
        )
        .expect("parse legacy close");
        assert!(matches!(
            legacy_close,
            ClientMessage::Close {
                mode: None,
                attempt_id: None,
                ..
            }
        ));

        let graceful_close = parse_client_message(
            r#"{"protocol_version":1,"kind":"close","request_id":"req-4","card_id":"card-1","mode":"continue","attempt_id":"attempt-1"}"#,
        )
        .expect("parse graceful close continuation");
        match graceful_close {
            ClientMessage::Close {
                request_id,
                card_id,
                mode,
                attempt_id,
            } => {
                assert_eq!(request_id.as_deref(), Some("req-4"));
                assert_eq!(card_id, "card-1");
                assert_eq!(mode, Some(MobileCloseMode::Continue));
                assert_eq!(attempt_id.as_deref(), Some("attempt-1"));
            }
            _ => panic!("expected close message"),
        }
    }

    #[test]
    fn serializes_mobile_control_results() {
        let json = serde_json::to_value(versioned_server_message(ServerMessage::SpawnResult {
            request_id: "req-1".to_string(),
            ok: true,
            card_id: Some("card-1".to_string()),
            error_code: None,
            message: None,
        }))
        .expect("serialize spawn result");

        assert_eq!(json["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(json["kind"], "spawn_result");
        assert_eq!(json["request_id"], "req-1");
        assert_eq!(json["card_id"], "card-1");
        assert_eq!(json["ok"], true);

        let close_json =
            serde_json::to_value(versioned_server_message(ServerMessage::CloseResult {
                request_id: "req-2".to_string(),
                ok: false,
                card_id: Some("card-1".to_string()),
                error_code: Some("graceful_timeout".to_string()),
                message: None,
                outcome: Some("timed_out".to_string()),
                attempt_id: Some("attempt-1".to_string()),
                stage: Some("agent_exit".to_string()),
            }))
            .expect("serialize graceful close result");
        assert_eq!(close_json["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(close_json["kind"], "close_result");
        assert_eq!(close_json["outcome"], "timed_out");
        assert_eq!(close_json["attempt_id"], "attempt-1");
        assert_eq!(close_json["stage"], "agent_exit");
    }

    #[test]
    fn rejects_missing_or_wrong_protocol_version() {
        let missing = parse_client_message(r#"{"kind":"ping"}"#)
            .expect_err("missing version must be rejected");
        assert_eq!(missing.error_code(), "protocol_version_mismatch");

        let wrong = parse_client_message(r#"{"protocol_version":2,"kind":"ping"}"#)
            .expect_err("wrong version must be rejected");
        assert_eq!(wrong.error_code(), "protocol_version_mismatch");

        let error = ServerMessage::Error {
            code: wrong.error_code().to_string(),
            message: wrong.to_string(),
        };
        let json = serde_json::to_value(versioned_server_message(error))
            .expect("serialize version mismatch error");
        assert_eq!(json["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(json["kind"], "error");
        assert_eq!(json["code"], "protocol_version_mismatch");
    }
}
