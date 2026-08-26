use super::*;

fn fixture(name: &str) -> serde_json::Value {
    let source = match name {
        "hello" => include_str!("../../tests/fixtures/terminal_host/runtime-hello.json"),
        "status" => include_str!("../../tests/fixtures/terminal_host/status-compatible.json"),
        "launch" => {
            include_str!("../../tests/fixtures/terminal_host/terminal-launch-v1-defaults.json")
        }
        "lifecycle" => include_str!("../../tests/fixtures/terminal_host/session-lifecycle.json"),
        "mcp" => include_str!("../../tests/fixtures/terminal_host/mcp-tools-and-errors.json"),
        _ => panic!("unknown fixture"),
    };
    serde_json::from_str(source).expect("fixture must be valid JSON")
}

#[test]
fn runtime_hello_and_exact_status_compatibility_are_frozen() {
    let hello: RuntimeHello = serde_json::from_value(fixture("hello")).unwrap();
    assert_eq!(
        hello.protocol_version,
        ProtocolVersion { major: 1, minor: 0 }
    );

    let status: TerminalHostStatus = serde_json::from_value(fixture("status")).unwrap();
    assert_eq!(status.platform, TerminalHostPlatform::Windows);
    assert_eq!(status.runtime_state, TerminalHostRuntimeState::Available);
    assert!(status.desktop_available);
    assert_eq!(status.protocol_version, Some(1));
    assert!(status.supports_terminal_launch_v1());

    let mut status_without_runtime_details = fixture("status");
    status_without_runtime_details
        .as_object_mut()
        .unwrap()
        .remove("runtime_id");
    status_without_runtime_details
        .as_object_mut()
        .unwrap()
        .remove("protocol_version");
    let status_without_runtime_details: TerminalHostStatus =
        serde_json::from_value(status_without_runtime_details).unwrap();
    assert_eq!(status_without_runtime_details.runtime_id, None);
    assert_eq!(status_without_runtime_details.protocol_version, None);

    let mut wrong_version = status.clone();
    wrong_version.contract_versions = vec!["terminal-launch/v1.1".into()];
    assert!(!wrong_version.supports_terminal_launch_v1());
    let mut missing_capability = status;
    missing_capability.capabilities.pop();
    assert!(!missing_capability.supports_terminal_launch_v1());

    let mut desktop_unavailable = missing_capability.clone();
    desktop_unavailable.capabilities = REQUIRED_TERMINAL_LAUNCH_V1_CAPABILITIES
        .iter()
        .map(|capability| (*capability).to_string())
        .collect();
    desktop_unavailable.desktop_available = false;
    assert!(!desktop_unavailable.supports_terminal_launch_v1());

    let mut runtime_unavailable = desktop_unavailable.clone();
    runtime_unavailable.desktop_available = true;
    runtime_unavailable.runtime_state = TerminalHostRuntimeState::Unavailable;
    assert!(!runtime_unavailable.supports_terminal_launch_v1());
    runtime_unavailable.runtime_state = TerminalHostRuntimeState::UpgradeDeferred;
    assert!(!runtime_unavailable.supports_terminal_launch_v1());

    let mut unsupported_platform = runtime_unavailable;
    unsupported_platform.runtime_state = TerminalHostRuntimeState::Available;
    unsupported_platform.platform = TerminalHostPlatform::Unsupported;
    assert!(!unsupported_platform.supports_terminal_launch_v1());
}

#[test]
fn terminal_launch_v1_defaults_and_consumer_neutral_request_id_bounds_are_frozen() {
    let launch: TerminalLaunchV1 = serde_json::from_value(fixture("launch")).unwrap();
    let normalized = launch.normalize().unwrap();
    assert_eq!(normalized.presentation, Presentation::Focused);
    assert_eq!(normalized.exit_behavior, ExitBehavior::Keep);
    assert_eq!(normalized.workspace_path, normalized.cwd);
    assert_eq!(
        normalized.request_id,
        "consumer-a:install-7:workspace-4d2c:operation-0001"
    );
    assert!(is_valid_request_id(&normalized.request_id));
    assert!(!is_valid_request_id("   "));
    assert!(!is_valid_request_id(&"a".repeat(REQUEST_ID_MAX_BYTES + 1)));
}

#[test]
fn lifecycle_fixture_requires_get_by_request_id_before_close_by_handle() {
    let lifecycle = fixture("lifecycle");
    assert_eq!(lifecycle["create"]["placement"], "window");
    assert_eq!(lifecycle["list"]["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(
        lifecycle["attach"]["handle"],
        lifecycle["get_result"]["handle"]
    );
    assert_eq!(lifecycle["resync"]["stream_generation"], "stream-1");
    let get: SessionSelector =
        serde_json::from_value(lifecycle["get_by_request_id"].clone()).unwrap();
    assert!(get.is_exactly_one());
    assert!(get.validate().is_ok());
    let get_without_null_handle: SessionSelector = serde_json::from_value(serde_json::json!({
        "request_id": "consumer-a:install-7:workspace-4d2c:operation-0001"
    }))
    .unwrap();
    assert!(get_without_null_handle.is_exactly_one());
    assert!(get_without_null_handle.validate().is_ok());
    assert!(get.handle.is_none());
    let close: SessionSelector =
        serde_json::from_value(lifecycle["close_by_handle"].clone()).unwrap();
    assert!(close.is_exactly_one());
    assert!(close.validate().is_ok());
    assert!(close.request_id.is_none());
    assert_eq!(
        lifecycle["close_by_handle"]["handle"],
        lifecycle["get_result"]["handle"]
    );
}

#[test]
fn strict_mcp_fixture_round_trips_typed_errors() {
    let mcp = fixture("mcp");
    let tools = mcp["tools"].as_array().unwrap();
    assert_eq!(
        tools,
        &vec![
            serde_json::json!("terminal_host_status"),
            serde_json::json!("terminal_create"),
            serde_json::json!("terminal_get"),
            serde_json::json!("terminal_list"),
            serde_json::json!("terminal_present"),
            serde_json::json!("terminal_close"),
        ]
    );
    let error: TerminalErrorEnvelope =
        serde_json::from_value(mcp["errors"]["surface_failed"].clone()).unwrap();
    assert_eq!(error.code, TerminalErrorCode::SurfaceFailed);
    assert_eq!(error.effect, EffectClassification::SessionCreated);
    assert!(error.handle.is_some());
    assert!(error.request_id.is_some());
    assert!(!error.retryable);
    assert!(error.validate().is_ok());
    let unavailable: TerminalErrorEnvelope =
        serde_json::from_value(mcp["errors"]["app_unavailable"].clone()).unwrap();
    assert_eq!(unavailable.effect, EffectClassification::NoEffect);
    assert!(unavailable.retryable);
    assert!(unavailable.validate().is_ok());
    let unknown: TerminalErrorEnvelope =
        serde_json::from_value(mcp["errors"]["outcome_unknown"].clone()).unwrap();
    assert_eq!(unknown.code, TerminalErrorCode::InternalError);
    assert_eq!(unknown.effect, EffectClassification::OutcomeUnknown);
    assert!(unknown.retryable);
    assert!(unknown.validate().is_ok());
    let cleanup_without_optional_keys: TerminalErrorEnvelope =
        serde_json::from_value(serde_json::json!({
            "code": "terminal_not_found",
            "message": "No live terminal remains for this handle.",
            "effect": "no_effect",
            "retryable": false
        }))
        .unwrap();
    assert!(cleanup_without_optional_keys.validate().is_ok());
    let cleanup: TerminalErrorEnvelope =
        serde_json::from_value(mcp["errors"]["terminal_not_found"].clone()).unwrap();
    assert_eq!(cleanup.code, TerminalErrorCode::TerminalNotFound);
    assert_eq!(cleanup.effect, EffectClassification::NoEffect);
    assert!(cleanup.validate().is_ok());
}

#[test]
fn public_dtos_reject_unknown_fields_and_ambiguous_selectors() {
    assert!(
        serde_json::from_value::<TerminalLaunchV1>(serde_json::json!({
            "version": 1, "request_id": "consumer/install/workspace/op", "executable": "cmd.exe",
            "args": [], "cwd": "C:/work", "placement": "window", "unexpected": true
        }))
        .is_err()
    );
    assert!(!SessionSelector {
        handle: Some("a".into()),
        request_id: Some("b".into())
    }
    .is_exactly_one());
    assert!(SessionSelector {
        handle: None,
        request_id: None,
    }
    .validate()
    .is_err());
    assert!(TerminalErrorEnvelope {
        code: TerminalErrorCode::InternalError,
        message: "create outcome unknown".into(),
        effect: EffectClassification::OutcomeUnknown,
        request_id: Some("consumer-a:install-7:workspace-4d2c:operation-0001".into()),
        handle: Some("e5f0af36-3b98-4f24-91e0-a467416e2836".into()),
        retryable: true,
    }
    .validate()
    .is_err());
    assert!(TerminalErrorEnvelope {
        code: TerminalErrorCode::SurfaceFailed,
        message: "surface not ready".into(),
        effect: EffectClassification::SessionCreated,
        request_id: Some("consumer-a:install-7:workspace-4d2c:operation-0001".into()),
        handle: None,
        retryable: false,
    }
    .validate()
    .is_err());
    assert!(
        serde_json::from_value::<TerminalLaunchV1>(serde_json::json!({
            "version": 1, "request_id": "consumer-a:install-7:workspace-4d2c:operation-0001",
            "executable": "cmd.exe", "args": [], "cwd": "C:/work", "placement": "window"
        }))
        .is_ok()
    );
}
