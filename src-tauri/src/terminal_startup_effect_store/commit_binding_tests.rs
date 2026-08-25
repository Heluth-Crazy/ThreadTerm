use super::commit_test_support::{envelope, provider_card, token, Fixture};
use super::{StartupEffectCommit, StartupEffectCommitOutcome};
use serde_json::json;
fn bind(
    n: u8,
    discover: bool,
    card_id: &str,
    pty_id: &str,
    provider: &str,
    session: &str,
) -> StartupEffectCommit {
    let fields = (
        token(n),
        card_id.into(),
        pty_id.into(),
        provider.into(),
        session.into(),
        u64::from(n),
    );
    if discover {
        StartupEffectCommit::DiscoverProviderSession {
            token: fields.0,
            card_id: fields.1,
            pty_id: fields.2,
            provider: fields.3,
            provider_session_id: fields.4,
            at_ms: fields.5,
        }
    } else {
        StartupEffectCommit::BindProviderSession {
            token: fields.0,
            card_id: fields.1,
            pty_id: fields.2,
            provider: fields.3,
            provider_session_id: fields.4,
            at_ms: fields.5,
        }
    }
}
#[test]
fn binding_sets_fields_preserves_valid_bound_at_and_new_same_session_is_applied() {
    let fixture = Fixture::new("commit-binding");
    let mut target = provider_card("target", "pty", "codex", Some("session"));
    target["providerSessionBoundAt"] = json!(77);
    fixture.seed(envelope(vec![target], vec![]));
    let store = fixture.store();
    assert_eq!(
        store
            .commit(bind(1, false, "target", "pty", "codex", "session"))
            .unwrap(),
        StartupEffectCommitOutcome::Applied
    );
    assert_eq!(
        store
            .commit(bind(2, false, "target", "pty", "codex", "session"))
            .unwrap(),
        StartupEffectCommitOutcome::Applied
    );
    let card = &fixture.read()["state"]["cards"][0];
    assert_eq!(card["providerSessionBoundAt"], 77);
    assert_eq!(card["providerSessionLastResumeAt"], 2);
    assert_eq!(
        card["startupSideEffects"]["applied"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn provider_target_and_uniqueness_conflicts_classify_discovery_as_obsolete() {
    let fixture = Fixture::new("commit-binding");
    fixture.seed(envelope(
        vec![
            provider_card("target", "pty", "codex", None),
            provider_card("other", "other", "codex", Some("used")),
        ],
        vec![provider_card(
            "archived",
            "archived",
            "claude",
            Some("archived-session"),
        )],
    ));
    let store = fixture.store();
    assert_eq!(
        store
            .commit(bind(3, false, "target", "pty", "claude", "new"))
            .unwrap(),
        StartupEffectCommitOutcome::Conflict
    );
    assert_eq!(
        store
            .commit(bind(4, true, "target", "pty", "claude", "new"))
            .unwrap(),
        StartupEffectCommitOutcome::Obsolete
    );
    assert_eq!(
        store
            .commit(bind(5, false, "target", "pty", "codex", "used"))
            .unwrap(),
        StartupEffectCommitOutcome::Conflict
    );
    assert_eq!(
        store
            .commit(bind(6, true, "target", "pty", "codex", "used"))
            .unwrap(),
        StartupEffectCommitOutcome::Obsolete
    );
}

#[test]
fn different_existing_target_session_conflicts_and_archived_target_can_bind() {
    let fixture = Fixture::new("commit-binding");
    fixture.seed(envelope(
        vec![provider_card("target", "pty", "codex", Some("old"))],
        vec![provider_card("archived", "old-pty", "codex", None)],
    ));
    let store = fixture.store();
    assert_eq!(
        store
            .commit(bind(7, false, "target", "pty", "codex", "new"))
            .unwrap(),
        StartupEffectCommitOutcome::Conflict
    );
    assert_eq!(
        store
            .commit(bind(8, true, "target", "pty", "codex", "new"))
            .unwrap(),
        StartupEffectCommitOutcome::Obsolete
    );
    assert_eq!(
        store
            .commit(bind(9, false, "archived", "old-pty", "codex", "new"))
            .unwrap(),
        StartupEffectCommitOutcome::Applied
    );
    assert_eq!(
        fixture.read()["state"]["archivedCards"][0]["providerSessionState"],
        "bound"
    );
}
