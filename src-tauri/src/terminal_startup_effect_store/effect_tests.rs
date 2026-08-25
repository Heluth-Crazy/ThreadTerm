use super::{StartupEffectCommit, StartupEffectCommitOutcome, StartupEffectKind};

const TOKEN: &str = "0123456789abcdef0123456789abcdef";
fn token() -> String {
    TOKEN.to_string()
}

fn expected_record(kind: &str, at: u64, field: &str, status: &str) -> String {
    format!(r#"{{"token":"{TOKEN}","kind":"{kind}","at":{at},"{field}":"{status}"}}"#)
}

fn commits() -> [StartupEffectCommit; 3] {
    [
        StartupEffectCommit::RecordUserSubmit {
            token: token(),
            card_id: "card".into(),
            pty_id: "pty".into(),
            at_ms: 7,
        },
        StartupEffectCommit::BindProviderSession {
            token: token(),
            card_id: "card".into(),
            pty_id: "pty".into(),
            provider: "codex".into(),
            provider_session_id: "session".into(),
            at_ms: 8,
        },
        StartupEffectCommit::DiscoverProviderSession {
            token: token(),
            card_id: "card".into(),
            pty_id: "pty".into(),
            provider: "claude".into(),
            provider_session_id: "session".into(),
            at_ms: 9,
        },
    ]
}

#[test]
fn accessors_and_conversion_cover_all_variants() {
    let expected_kinds = [
        StartupEffectKind::RecordUserSubmit,
        StartupEffectKind::BindProviderSession,
        StartupEffectKind::DiscoverProviderSession,
    ];
    for (commit, expected_kind) in commits().iter().zip(expected_kinds) {
        assert_eq!(commit.token(), token());
        assert_eq!(commit.card_id(), "card");
        assert_eq!(commit.pty_id(), "pty");
        assert_eq!(commit.kind(), expected_kind);
        assert!(commit.validate().is_ok());
        assert_eq!(commit.at_ms(), expected_kind as u64 + 7);
        assert_eq!(
            commit.is_discovery(),
            expected_kind == StartupEffectKind::DiscoverProviderSession
        );
        let target = commit.binding_target();
        assert_eq!(
            target,
            match expected_kind {
                StartupEffectKind::RecordUserSubmit => None,
                StartupEffectKind::BindProviderSession => Some(("codex", "session")),
                StartupEffectKind::DiscoverProviderSession => Some(("claude", "session")),
            }
        );
        let record = commit.to_record().expect("valid effect record");
        assert_eq!(record.token, token());
    }
}

#[test]
fn validation_rejects_bad_token_and_empty_fields_without_panicking() {
    let invalid = [
        StartupEffectCommit::RecordUserSubmit {
            token: "0123456789abcdef0123456789abcdeF".into(),
            card_id: "card".into(),
            pty_id: "pty".into(),
            at_ms: 0,
        },
        StartupEffectCommit::RecordUserSubmit {
            token: token(),
            card_id: String::new(),
            pty_id: "pty".into(),
            at_ms: 0,
        },
        StartupEffectCommit::BindProviderSession {
            token: token(),
            card_id: "card".into(),
            pty_id: "pty".into(),
            provider: "  ".into(),
            provider_session_id: "session".into(),
            at_ms: 0,
        },
        StartupEffectCommit::DiscoverProviderSession {
            token: token(),
            card_id: "card".into(),
            pty_id: "pty".into(),
            provider: "provider".into(),
            provider_session_id: "\t".into(),
            at_ms: 0,
        },
    ];
    for commit in invalid {
        assert!(commit.validate().is_err());
        assert!(commit.to_record().is_err());
    }
}

#[test]
fn serialized_records_are_minimal_and_status_matches_kind() {
    let expected = [
        expected_record("recordUserSubmit", 7, "timeline", "present"),
        expected_record("bindProviderSession", 8, "binding", "active"),
        expected_record("discoverProviderSession", 9, "binding", "active"),
    ];
    for (commit, expected) in commits().iter().zip(expected) {
        let record = commit.to_record().expect("valid effect record");
        let serialized = serde_json::to_string(&record).expect("serialize effect record");
        assert_eq!(serialized, expected);
        let value: serde_json::Value = serde_json::from_str(&serialized).expect("record JSON");
        for forbidden in [
            "cardId",
            "ptyId",
            "provider",
            "providerSessionId",
            "command",
            "cwd",
        ] {
            assert!(!value.as_object().unwrap().contains_key(forbidden));
        }
    }
}

#[test]
fn commit_outcomes_are_distinct_statuses() {
    let outcomes = [
        StartupEffectCommitOutcome::Applied,
        StartupEffectCommitOutcome::AlreadyApplied,
        StartupEffectCommitOutcome::Obsolete,
        StartupEffectCommitOutcome::Conflict,
    ];
    assert_eq!(
        serde_json::to_string(&outcomes).unwrap(),
        r#"["applied","alreadyApplied","obsolete","conflict"]"#
    );
    assert_ne!(outcomes[0], outcomes[1]);
}
