use super::{PtyCreateSessionV2Request, PtyStartupIntent};

fn request(startup: &str) -> String {
    format!(
        r#"{{"id":"pty-1","workingDir":"C:\\work","rows":24,"cols":80,"launchAttemptId":"attempt-1","startup":{startup}}}"#
    )
}

#[test]
fn serde_accepts_camel_case_and_all_intent_variants() {
    let none: PtyCreateSessionV2Request =
        serde_json::from_str(&request(r#"{"kind":"none"}"#)).unwrap();
    assert!(matches!(none.startup, PtyStartupIntent::None));

    let one_shot: PtyCreateSessionV2Request = serde_json::from_str(&request(
        r#"{"kind":"oneShot","descriptor":{"executionMode":"oneShot","command":"run"}}"#,
    ))
    .unwrap();
    assert!(matches!(one_shot.startup, PtyStartupIntent::OneShot { .. }));

    let provider: PtyCreateSessionV2Request = serde_json::from_str(&request(
        r#"{"kind":"provider","provider":"codex","command":"run","cardId":"card","action":"start","sideEffectPlan":{"kind":"discover"}}"#,
    ))
    .unwrap();
    assert!(matches!(
        provider.startup,
        PtyStartupIntent::Provider { .. }
    ));
    assert_eq!(provider.working_dir, r"C:\work");
}

#[test]
fn serde_rejects_snake_case_wire_names() {
    let error = serde_json::from_str::<PtyCreateSessionV2Request>(
        r#"{"id":"pty","working_dir":"/tmp","rows":1,"cols":1,"startup":{"kind":"none"}}"#,
    );
    assert!(error.is_err());
}

#[test]
fn validation_is_empty_sensitive_and_dimension_safe() {
    let mut valid: PtyCreateSessionV2Request =
        serde_json::from_str(&request(r#"{"kind":"none"}"#)).unwrap();
    assert!(valid.validate().is_ok());

    valid.id = " ".into();
    assert!(valid.validate().is_ok());
    valid.id.clear();
    assert_eq!(valid.validate(), Err("pty_id_required"));

    valid.id = "pty".into();
    valid.working_dir.clear();
    assert_eq!(valid.validate(), Err("working_dir_required"));
    valid.working_dir = " ".into();
    valid.rows = 0;
    assert_eq!(valid.validate(), Err("pty_dimensions_invalid"));
    valid.rows = 1;
    valid.cols = 0;
    assert_eq!(valid.validate(), Err("pty_dimensions_invalid"));
}

#[test]
fn validation_delegates_startup_without_echoing_input() {
    let mut invalid: PtyCreateSessionV2Request =
        serde_json::from_str(&request(r#"{"kind":"none"}"#)).unwrap();
    invalid.startup = PtyStartupIntent::Provider {
        provider: super::AgentSessionProvider::Codex,
        command: String::new(),
        card_id: "card".into(),
        action: super::PtyStartupAction::Start,
        side_effect_plan: super::PtyStartupSideEffectPlan::Discover,
    };
    assert_eq!(invalid.validate(), Err("startup_command_required"));
}
