use super::*;

#[test]
fn framing_rejects_bounds_before_body_allocation_and_round_trips_chunks() {
    assert_eq!(encode_frame(&[]), Err(FrameError::ZeroLength));
    assert_eq!(
        encode_frame(&vec![0; MAX_FRAME_BYTES + 1]),
        Err(FrameError::TooLarge)
    );
    let maximum = encode_frame(&vec![b'x'; MAX_FRAME_BYTES]).unwrap();
    assert_eq!(maximum.len(), MAX_FRAME_BYTES + 4);
    let mut decoder = FrameDecoder::default();
    assert!(decoder.push(&maximum[..3]).unwrap().is_empty());
    assert_eq!(
        decoder.push(&maximum[3..]).unwrap(),
        vec![vec![b'x'; MAX_FRAME_BYTES]]
    );
    let mut zero = FrameDecoder::default();
    assert_eq!(zero.push(&0_u32.to_le_bytes()), Err(FrameError::ZeroLength));
    let mut oversize = FrameDecoder::default();
    assert_eq!(
        oversize.push(&((MAX_FRAME_BYTES + 1) as u32).to_le_bytes()),
        Err(FrameError::TooLarge)
    );
    let mut hello_decoder = FrameDecoder::with_max_frame_bytes(MAX_HELLO_FRAME_BYTES);
    assert_eq!(
        hello_decoder.push(&((MAX_HELLO_FRAME_BYTES + 1) as u32).to_le_bytes()),
        Err(FrameError::TooLarge)
    );
    assert_eq!(FrameDecoder::default().finish(), Ok(()));
    let mut truncated_header = FrameDecoder::default();
    truncated_header.push(&[1, 0]).unwrap();
    assert_eq!(truncated_header.finish(), Err(FrameError::TruncatedHeader));
    let mut truncated_body = FrameDecoder::default();
    truncated_body.push(&[2, 0, 0, 0, b'x']).unwrap();
    assert_eq!(truncated_body.finish(), Err(FrameError::TruncatedBody));
}

#[test]
fn framing_handles_multiple_and_bad_json_utf8() {
    let one = encode_json_frame(&serde_json::json!({"n": 1})).unwrap();
    let two = encode_json_frame(&serde_json::json!({"n": 2})).unwrap();
    let mut decoder = FrameDecoder::default();
    let mut combined = one;
    combined.extend(two);
    let received: Vec<serde_json::Value> = decoder.decode_json(&combined).unwrap();
    assert_eq!(
        received,
        vec![serde_json::json!({"n": 1}), serde_json::json!({"n": 2})]
    );
    let mut bad_utf8 = FrameDecoder::default();
    assert_eq!(
        bad_utf8.decode_json::<serde_json::Value>(&encode_frame(&[0xff]).unwrap()),
        Err(FrameError::InvalidUtf8)
    );
    let mut bad_json = FrameDecoder::default();
    assert_eq!(
        bad_json.decode_json::<serde_json::Value>(&encode_frame(b"{").unwrap()),
        Err(FrameError::InvalidJson)
    );
}

#[test]
fn strict_envelopes_and_negotiation_hold_invariants() {
    let range = ProtocolRange {
        min: ProtocolVersion { major: 1, minor: 0 },
        max: ProtocolVersion { major: 1, minor: 4 },
    };
    let peer = ProtocolRange {
        min: ProtocolVersion { major: 1, minor: 2 },
        max: ProtocolVersion { major: 1, minor: 6 },
    };
    assert_eq!(
        range.negotiate(&peer),
        Some(ProtocolVersion { major: 1, minor: 4 })
    );
    assert_eq!(
        range.negotiate(&ProtocolRange {
            min: ProtocolVersion { major: 2, minor: 0 },
            max: ProtocolVersion { major: 2, minor: 1 }
        }),
        None
    );
    let inverted = ProtocolRange {
        min: ProtocolVersion { major: 1, minor: 3 },
        max: ProtocolVersion { major: 1, minor: 2 },
    };
    assert_eq!(inverted.validate(), Err(IpcError::InvalidProtocolRange));
    assert_eq!(range.negotiate(&inverted), None);
    let response = ResponseEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Response,
        id: 1,
        result: Some(serde_json::json!({})),
        error: None,
    };
    assert!(response.validate().is_ok());
    assert!(ResponseEnvelope {
        result: None,
        error: None,
        ..response.clone()
    }
    .validate()
    .is_err());
    assert!(ResponseEnvelope {
        result: Some(serde_json::json!({})),
        error: Some(TransportError {
            code: TransportErrorCode::InvalidRequest,
            message: "private request data".into(),
            effect: None,
            request_id: None,
            handle: None,
            retryable: false
        }),
        ..response
    }
    .validate()
    .is_err());
    assert!(serde_json::from_value::<RequestEnvelope>(serde_json::json!({"version":{"major":1,"minor":0},"kind":"request","id":1,"method":"runtime.health","params":{},"unexpected":true})).is_err());
    assert!(serde_json::from_value::<RequestEnvelope>(serde_json::json!({"version":{"major":1,"minor":0},"kind":"request","id":1,"method":"unknown","params":{}})).is_err());
    assert!(RequestEnvelope {
        version: ProtocolVersion { major: 9, minor: 0 },
        kind: EnvelopeKind::Request,
        id: 1,
        method: Method::SessionList,
        params: serde_json::json!({})
    }
    .validate()
    .is_err());
    let selected = ProtocolVersion { major: 1, minor: 2 };
    let selected_request = RequestEnvelope {
        version: selected,
        kind: EnvelopeKind::Request,
        id: 2,
        method: Method::SessionList,
        params: serde_json::json!({}),
    };
    assert!(selected_request.validate_for(&selected).is_ok());
    assert_eq!(
        selected_request.validate_for(&PROTOCOL_VERSION),
        Err(IpcError::UnsupportedVersion)
    );
    let selected_response = ResponseEnvelope {
        version: selected,
        kind: EnvelopeKind::Response,
        id: 2,
        result: Some(serde_json::json!({})),
        error: None,
    };
    assert!(selected_response.validate_for(&selected).is_ok());
    let selected_event = EventEnvelope {
        version: selected,
        kind: EnvelopeKind::Event,
        event: EventName::SessionState,
        payload: serde_json::json!({
            "runtime_id": "runtime",
            "handle": "handle",
            "stream_id": "stream",
            "state": "running",
            "revision": 1
        }),
    };
    assert!(selected_event.validate_for(&selected).is_ok());
    assert!(serde_json::from_value::<HelloRequest>(serde_json::json!({
        "protocol": {"min": {"major": 1, "minor": 0}, "max": {"major": 1, "minor": 0}},
        "client": "unknown", "capabilities": [], "secret": "secret"
    }))
    .is_err());
    assert!(serde_json::from_value::<HelloRequest>(serde_json::json!({
        "protocol": {"min": {"major": 1, "minor": 0}, "max": {"major": 1, "minor": 0}},
        "client": "desktop", "capabilities": [], "secret": "secret", "unknown": true
    }))
    .is_err());
    let methods = [
        Method::Hello,
        Method::Health,
        Method::RuntimeStop,
        Method::SessionCreate,
        Method::SessionGet,
        Method::SessionList,
        Method::SessionAttach,
        Method::SessionDetach,
        Method::SessionInput,
        Method::SessionResize,
        Method::SessionAck,
        Method::SessionResync,
        Method::SessionClose,
        Method::SessionPresent,
        Method::DesktopRegister,
        Method::SurfaceReady,
        Method::SurfaceHidden,
    ];
    for method in methods {
        let wire = serde_json::to_string(&method).unwrap();
        assert_eq!(wire, format!("\"{}\"", method.as_str()));
        assert_eq!(serde_json::from_str::<Method>(&wire).unwrap(), method);
    }
    assert!(serde_json::from_str::<Method>("\"session.unknown\"").is_err());
    for (code, wire) in [
        (TransportErrorCode::RequestConflict, "request_conflict"),
        (TransportErrorCode::TerminalNotFound, "terminal_not_found"),
        (TransportErrorCode::SpawnFailed, "spawn_failed"),
        (TransportErrorCode::AppUnavailable, "app_unavailable"),
        (TransportErrorCode::SurfaceFailed, "surface_failed"),
        (
            TransportErrorCode::IncompatibleRuntime,
            "incompatible_runtime",
        ),
        (TransportErrorCode::StalePresentation, "stale_presentation"),
        (TransportErrorCode::RuntimeBusy, "runtime_busy"),
    ] {
        assert_eq!(serde_json::to_string(&code).unwrap(), format!("\"{wire}\""));
        assert_eq!(
            serde_json::from_str::<TransportErrorCode>(&format!("\"{wire}\"")).unwrap(),
            code
        );
    }
}

#[test]
fn sensitive_diagnostics_are_redacted_and_phase_zero_fixtures_round_trip() {
    let hello = HelloRequest {
        protocol: ProtocolRange {
            min: PROTOCOL_VERSION,
            max: PROTOCOL_VERSION,
        },
        client: ClientClass::Desktop,
        capabilities: vec!["client-supplied-capability".into()],
        secret: "do-not-log".into(),
    };
    let hello_debug = format!("{hello:?}");
    assert!(!hello_debug.contains("do-not-log"));
    assert!(!hello_debug.contains("client-supplied-capability"));
    assert_eq!(
        serde_json::to_value(&hello).unwrap()["secret"],
        "do-not-log"
    );
    assert!(serde_json::from_value::<HelloRequest>(serde_json::json!({
        "protocol": {"min": {"major": 1, "minor": 0}, "max": {"major": 1, "minor": 0}},
        "client": "desktop", "capabilities": []
    }))
    .is_err());
    let error = TransportError {
        code: TransportErrorCode::InvalidRequest,
        message: "command body must not appear in diagnostics".into(),
        effect: None,
        request_id: None,
        handle: None,
        retryable: false,
    };
    assert!(!format!("{error:?}").contains("command body"));
    let request = RequestEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Request,
        id: 1,
        method: Method::Health,
        params: serde_json::json!({"body":"secret-params"}),
    };
    assert!(!format!("{request:?}").contains("secret-params"));
    let launch = TerminalLaunchV1 {
        version: 1,
        request_id: "private-request".into(),
        executable: "C:\\private\\tool.exe".into(),
        args: vec!["private-argument".into()],
        cwd: "C:\\private".into(),
        title: Some("private-title".into()),
        placement: Placement::Window,
        presentation: None,
        exit_behavior: None,
    };
    let launch_debug = format!("{launch:?}");
    for secret in [
        "private-request",
        "C:\\private\\tool.exe",
        "private-argument",
        "C:\\private",
        "private-title",
    ] {
        assert!(!launch_debug.contains(secret));
    }
    assert_eq!(launch.normalize().unwrap().workspace_path, "C:\\private");
    let response = ResponseEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Response,
        id: 1,
        result: Some(serde_json::json!({"body":"secret-result"})),
        error: None,
    };
    assert!(!format!("{response:?}").contains("secret-result"));
    let event = EventEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Event,
        event: EventName::SessionOutput,
        payload: serde_json::json!({"body":"secret-payload"}),
    };
    assert!(!format!("{event:?}").contains("secret-payload"));
    let terminal_error = TerminalErrorEnvelope {
        code: TerminalErrorCode::InternalError,
        message: "command body must not appear in diagnostics".into(),
        effect: EffectClassification::NoEffect,
        request_id: None,
        handle: None,
        retryable: false,
    };
    assert!(!format!("{terminal_error:?}").contains("command body"));
    assert!(!terminal_error.to_string().contains("command body"));
    assert_eq!(terminal_error.to_string(), "internal_error");
    let hello_response = HelloResponse {
        protocol: PROTOCOL_VERSION,
        runtime_id: "runtime".into(),
        connection_id: "connection-secret".into(),
        capabilities: vec!["desktop.present".into()],
    };
    assert!(hello_response.validate().is_ok());
    let hello_response_debug = format!("{hello_response:?}");
    assert!(!hello_response_debug.contains("connection-secret"));
    assert!(!hello_response_debug.contains("desktop.present"));
    assert!(serde_json::to_value(&hello_response)
        .unwrap()
        .get("connection_id")
        .is_some());
    assert!(HelloRequest {
        protocol: ProtocolRange {
            min: PROTOCOL_VERSION,
            max: PROTOCOL_VERSION,
        },
        client: ClientClass::Desktop,
        capabilities: vec![" ".into()],
        secret: "do-not-log".into(),
    }
    .validate()
    .is_err());
    let status: TerminalHostStatus = serde_json::from_str(include_str!(
        "../../tests/fixtures/terminal_host/status-compatible.json"
    ))
    .unwrap();
    assert!(status.supports_terminal_launch_v1());
    let launch: TerminalLaunchV1 = serde_json::from_str(include_str!(
        "../../tests/fixtures/terminal_host/terminal-launch-v1-defaults.json"
    ))
    .unwrap();
    assert_eq!(
        launch.normalize().unwrap().workspace_path,
        "C:\\workspaces\\demo"
    );
    assert!(SessionSelector {
        handle: Some(" ".into()),
        request_id: None
    }
    .validate()
    .is_err());
    assert!(SessionSelector {
        handle: None,
        request_id: Some(" ".into())
    }
    .validate()
    .is_err());
}

#[test]
fn phase_three_dtos_are_strict_typed_and_bounded() {
    let runtime_stop = RequestEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Request,
        id: 8,
        method: Method::RuntimeStop,
        params: serde_json::json!({}),
    };
    assert!(matches!(
        runtime_stop.decode_params(),
        Ok(RequestParams::RuntimeStop(RuntimeStopRequest {
            terminate_live_sessions: false,
        }))
    ));
    assert!(matches!(
        RequestEnvelope {
            params: serde_json::json!({"unexpected": true}),
            ..runtime_stop
        }
        .decode_params(),
        Err(IpcError::InvalidRequest)
    ));
    assert!(matches!(
        ResponseEnvelope {
            version: PROTOCOL_VERSION,
            kind: EnvelopeKind::Response,
            id: 8,
            result: Some(serde_json::json!({})),
            error: None,
        }
        .decode_result(Method::RuntimeStop),
        Ok(ResponseResult::Empty(_))
    ));

    let create = serde_json::json!({
        "request_id": "client:request", "executable": "C:\\bin\\tool.exe",
        "args": ["--flag"], "cwd": "C:\\work", "title": "private title",
        "placement": "workspace", "presentation": "background", "exit_behavior": "close-on-exit",
        "rows": 24, "cols": 80
    });
    let envelope = RequestEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Request,
        id: 9,
        method: Method::SessionCreate,
        params: create.clone(),
    };
    assert!(matches!(
        envelope.decode_params(),
        Ok(RequestParams::SessionCreate(_))
    ));
    assert_eq!(serde_json::to_value(&envelope).unwrap()["params"], create);
    assert!(!format!("{envelope:?}").contains("private title"));
    let session = serde_json::json!({
        "runtime_id": "runtime", "handle": "handle", "stream_id": "stream",
        "state": "running", "revision": 1, "placement": "workspace",
        "presentation": "background", "exit_behavior": "close-on-exit",
        "workspace_target": "C:\\work", "surface_hidden": false
    });
    let create_response = ResponseEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Response,
        id: 9,
        result: Some(serde_json::json!({
            "disposition": "reused",
            "session": session,
        })),
        error: None,
    };
    assert!(matches!(
        create_response.decode_result(Method::SessionCreate),
        Ok(ResponseResult::SessionCreate(SessionCreateResponse {
            disposition: CreateDisposition::Reused,
            ..
        }))
    ));
    assert!(matches!(
        ResponseEnvelope {
            result: Some(serde_json::json!({
                "disposition": "created",
                "session": {
                    "runtime_id": "runtime", "handle": "handle", "stream_id": "stream",
                    "state": "running", "revision": 1, "placement": "workspace",
                    "presentation": "background", "exit_behavior": "close-on-exit",
                    "surface_hidden": false, "unexpected": true
                }
            })),
            ..create_response
        }
        .decode_result(Method::SessionCreate),
        Err(IpcError::InvalidRequest)
    ));
    for missing in ["placement", "presentation", "exit_behavior"] {
        let mut missing_intent = create.clone();
        missing_intent.as_object_mut().unwrap().remove(missing);
        assert!(matches!(
            RequestEnvelope {
                params: missing_intent,
                ..envelope.clone()
            }
            .decode_params(),
            Err(IpcError::InvalidRequest)
        ));
    }

    for (method, params) in [
        (
            Method::SessionGet,
            serde_json::json!({"selector":{"handle":"handle"}}),
        ),
        (Method::SessionList, serde_json::json!({})),
        (
            Method::SessionAttach,
            serde_json::json!({"handle":"handle"}),
        ),
        (
            Method::SessionDetach,
            serde_json::json!({"attach_id":"attach","stream_id":"stream"}),
        ),
        (
            Method::SessionInput,
            serde_json::json!({"attach_id":"attach","stream_id":"stream","data_base64":"aGk="}),
        ),
        (
            Method::SessionResize,
            serde_json::json!({"attach_id":"attach","stream_id":"stream","rows":24,"cols":80}),
        ),
        (
            Method::SessionAck,
            serde_json::json!({"attach_id":"attach","stream_id":"stream","through_seq":7}),
        ),
        (
            Method::SessionResync,
            serde_json::json!({"attach_id":"attach","stream_id":"stream"}),
        ),
        (
            Method::SessionClose,
            serde_json::json!({"handle":"handle","mode":"graceful"}),
        ),
        (
            Method::SessionPresent,
            serde_json::json!({"handle":"handle","placement":"window","presentation":"focused"}),
        ),
        (
            Method::DesktopRegister,
            serde_json::json!({
                "surface_protocol_version": SURFACE_PRESENTATION_V1,
                "placements": ["workspace", "window"],
                "background_presentation": true,
            }),
        ),
    ] {
        let request = RequestEnvelope {
            version: PROTOCOL_VERSION,
            kind: EnvelopeKind::Request,
            id: 1,
            method: method.clone(),
            params,
        };
        assert!(
            request.decode_params().is_ok(),
            "{}",
            request.method.as_str()
        );
        assert_eq!(
            serde_json::from_value::<RequestEnvelope>(serde_json::to_value(&request).unwrap())
                .unwrap(),
            request
        );
    }
    let bad_selector = RequestEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Request,
        id: 1,
        method: Method::SessionGet,
        params: serde_json::json!({"selector":{"handle":"h","request_id":"r"}}),
    };
    assert!(matches!(
        bad_selector.decode_params(),
        Err(IpcError::InvalidRequest)
    ));
    let zero_dimensions = RequestEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Request,
        id: 1,
        method: Method::SessionResize,
        params: serde_json::json!({"attach_id":"a","stream_id":"stream","rows":0,"cols":80}),
    };
    assert!(matches!(
        zero_dimensions.decode_params(),
        Err(IpcError::InvalidRequest)
    ));
    let unknown_field = RequestEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Request,
        id: 1,
        method: Method::SessionList,
        params: serde_json::json!({"unknown":true}),
    };
    assert!(matches!(
        unknown_field.decode_params(),
        Err(IpcError::InvalidRequest)
    ));

    let oversized_launch = TerminalLaunchV1 {
        version: 1,
        request_id: "request".into(),
        executable: "tool".into(),
        args: vec!["x".repeat(MAX_LAUNCH_COMMAND_BYTES + 1)],
        cwd: "C:\\work".into(),
        title: None,
        placement: Placement::Window,
        presentation: None,
        exit_behavior: None,
    };
    assert_eq!(oversized_launch.normalize(), Err("invalid_request"));
    let too_many_args = TerminalLaunchV1 {
        version: 1,
        request_id: "request".into(),
        executable: "tool".into(),
        args: vec!["x".into(); MAX_LAUNCH_ARGUMENTS + 1],
        cwd: "C:\\work".into(),
        title: None,
        placement: Placement::Window,
        presentation: None,
        exit_behavior: None,
    };
    assert_eq!(too_many_args.normalize(), Err("invalid_request"));

    let output = serde_json::json!({"runtime_id":"runtime","handle":"handle","stream_id":"stream","attach_id":"attach","seq":4,"data_base64":"c2VjcmV0"});
    let event = EventEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Event,
        event: EventName::SessionOutput,
        payload: output.clone(),
    };
    assert!(matches!(
        event.decode_payload(),
        Ok(EventPayload::SessionOutput(_))
    ));
    assert_eq!(
        serde_json::to_value(&event).unwrap()["event"],
        "session.output"
    );
    assert_eq!(
        serde_json::from_value::<EventEnvelope>(serde_json::to_value(&event).unwrap()).unwrap(),
        event
    );
    assert!(!format!("{event:?}").contains("c2VjcmV0"));
    let mismatch = EventEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Event,
        event: EventName::SessionExit,
        payload: output,
    };
    assert_eq!(mismatch.validate(), Err(IpcError::InvalidRequest));
    let exit = EventEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Event,
        event: EventName::SessionExit,
        payload: serde_json::json!({
            "runtime_id":"runtime", "handle":"handle", "stream_id":"stream",
            "revision":2, "exit_code":0, "exit_behavior":"close-on-success"
        }),
    };
    assert!(matches!(
        exit.decode_payload(),
        Ok(EventPayload::SessionExit(SessionExitEvent {
            exit_behavior: ExitBehavior::CloseOnSuccess,
            ..
        }))
    ));
    assert_eq!(
        serde_json::from_value::<EventEnvelope>(serde_json::to_value(&exit).unwrap()).unwrap(),
        exit
    );
    for payload in [
        serde_json::json!({
            "runtime_id":"runtime", "handle":"handle", "stream_id":"stream",
            "revision":2, "exit_code":0
        }),
        serde_json::json!({
            "runtime_id":"runtime", "handle":"handle", "stream_id":"stream",
            "revision":2, "exit_code":0, "exit_behavior":"close-on-exit", "unexpected":true
        }),
    ] {
        assert_eq!(
            EventEnvelope {
                payload,
                ..exit.clone()
            }
            .validate(),
            Err(IpcError::InvalidRequest)
        );
    }
    let stale = EventEnvelope {
        version: ProtocolVersion { major: 1, minor: 1 },
        kind: EnvelopeKind::Event,
        event: EventName::SessionState,
        payload: serde_json::json!({"runtime_id":"runtime","handle":"handle","stream_id":"stream","state":"running","revision":1}),
    };
    assert_eq!(stale.validate(), Err(IpcError::UnsupportedVersion));
    let resync = EventEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Event,
        event: EventName::SessionResyncRequired,
        payload: serde_json::json!({"runtime_id":"runtime","handle":"handle","stream_id":"stream","attach_id":"attach","last_delivered_seq":9,"current_seq":8,"reason":"queue_overflow"}),
    };
    assert_eq!(resync.validate(), Err(IpcError::InvalidRequest));
}

#[test]
fn surface_presentation_contract_is_strict_bounded_and_redacted() {
    let register = RequestEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Request,
        id: 10,
        method: Method::DesktopRegister,
        params: serde_json::json!({
            "surface_protocol_version": SURFACE_PRESENTATION_V1,
            "placements": ["workspace", "window"],
            "background_presentation": true,
        }),
    };
    assert!(matches!(
        register.decode_params(),
        Ok(RequestParams::DesktopRegister(_))
    ));
    for params in [
        serde_json::json!({"surface_protocol_version":"wrong","placements":["window"],"background_presentation":true}),
        serde_json::json!({"surface_protocol_version":SURFACE_PRESENTATION_V1,"placements":[],"background_presentation":true}),
        serde_json::json!({"surface_protocol_version":SURFACE_PRESENTATION_V1,"placements":["window","window"],"background_presentation":true}),
        serde_json::json!({"surface_protocol_version":SURFACE_PRESENTATION_V1,"placements":["window","workspace","window"],"background_presentation":true}),
    ] {
        assert!(matches!(
            RequestEnvelope {
                params,
                ..register.clone()
            }
            .decode_params(),
            Err(IpcError::InvalidRequest)
        ));
    }
    let present = RequestEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Request,
        id: 11,
        method: Method::SessionPresent,
        params: serde_json::json!({
            "handle":"private-handle", "placement":"workspace",
            "workspace_target":"C:\\private", "presentation":"background"
        }),
    };
    assert!(matches!(
        present.decode_params(),
        Ok(RequestParams::SessionPresent(_))
    ));
    assert!(!format!("{present:?}").contains("private-handle"));
    for params in [
        serde_json::json!({"handle":"h","placement":"window","workspace_target":"C:\\private","presentation":"focused"}),
        serde_json::json!({"handle":"h","placement":"workspace","workspace_target":" ","presentation":"focused"}),
        serde_json::json!({"handle":"h","placement":"workspace","presentation":"focused","unexpected":true}),
    ] {
        assert!(matches!(
            RequestEnvelope {
                params,
                ..present.clone()
            }
            .decode_params(),
            Err(IpcError::InvalidRequest)
        ));
    }

    let surface = serde_json::json!({
        "runtime_id":"runtime", "handle":"handle", "stream_id":"stream", "state":"running",
        "revision":2, "placement":"workspace", "presentation":"background", "exit_behavior":"keep",
        "workspace_target":"C:\\work", "surface_hidden":false, "child_pid":42
    });
    for (method, params) in [
        (
            Method::SurfaceReady,
            serde_json::json!({"handle":"handle","revision":2,"attach_id":"attach","stream_id":"stream"}),
        ),
        (
            Method::SurfaceHidden,
            serde_json::json!({"handle":"handle","revision":2,"attach_id":"attach","stream_id":"stream"}),
        ),
    ] {
        let request = RequestEnvelope {
            version: PROTOCOL_VERSION,
            kind: EnvelopeKind::Request,
            id: 12,
            method: method.clone(),
            params,
        };
        assert!(request.decode_params().is_ok());
        assert_eq!(
            serde_json::from_value::<RequestEnvelope>(serde_json::to_value(&request).unwrap())
                .unwrap(),
            request
        );
        let response = ResponseEnvelope {
            version: PROTOCOL_VERSION,
            kind: EnvelopeKind::Response,
            id: 12,
            result: Some(surface.clone()),
            error: None,
        };
        assert!(matches!(
            response.decode_result(method),
            Ok(ResponseResult::SurfaceReady(_)) | Ok(ResponseResult::SurfaceHidden(_))
        ));
    }
    for (method, params) in [
        (
            Method::SurfaceReady,
            serde_json::json!({"handle":"handle","revision":2,"attach_id":"attach","stream_id":"stream","unexpected":true}),
        ),
        (
            Method::SurfaceHidden,
            serde_json::json!({"handle":"handle","revision":2,"attach_id":"attach"}),
        ),
        (
            Method::SurfaceReady,
            serde_json::json!({"handle":"handle","revision":0,"attach_id":"attach","stream_id":"stream"}),
        ),
        (
            Method::SurfaceHidden,
            serde_json::json!({"handle":"handle","revision":0,"attach_id":"attach","stream_id":"stream"}),
        ),
    ] {
        assert!(matches!(
            RequestEnvelope {
                version: PROTOCOL_VERSION,
                kind: EnvelopeKind::Request,
                id: 12,
                method,
                params,
            }
            .decode_params(),
            Err(IpcError::InvalidRequest)
        ));
    }
    let response = ResponseEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Response,
        id: 13,
        result: Some(surface.clone()),
        error: None,
    };
    assert!(matches!(
        response.decode_result(Method::SessionPresent),
        Ok(ResponseResult::SessionPresent(_))
    ));
    let mut bad_surface = surface;
    bad_surface["child_pid"] = serde_json::json!(0);
    let bad_pid = ResponseEnvelope {
        result: Some(bad_surface),
        ..response
    };
    assert!(matches!(
        bad_pid.decode_result(Method::SessionPresent),
        Err(IpcError::InvalidRequest)
    ));

    let event = EventEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Event,
        event: EventName::SurfacePresentRequested,
        payload: serde_json::json!({
            "handle":"private-handle", "revision":3, "placement":"workspace",
            "workspace_target":"C:\\private", "presentation":"focused"
        }),
    };
    assert!(matches!(
        event.decode_payload(),
        Ok(EventPayload::SurfacePresentRequested(_))
    ));
    assert!(!format!("{event:?}").contains("private-handle"));
    assert_eq!(EventEnvelope { payload: serde_json::json!({"handle":"h","revision":1,"placement":"window","workspace_target":"C:\\bad","presentation":"focused"}), ..event.clone() }.validate(), Err(IpcError::InvalidRequest));
    assert_eq!(EventEnvelope { payload: serde_json::json!({"handle":"h","revision":0,"placement":"workspace","presentation":"focused"}), ..event }.validate(), Err(IpcError::InvalidRequest));

    let error = TransportError {
        code: TransportErrorCode::SurfaceFailed,
        message: "private message".into(),
        effect: Some(EffectClassification::SessionCreated),
        request_id: Some("private-request".into()),
        handle: Some("private-handle".into()),
        retryable: true,
    };
    assert!(error.validate().is_ok());
    let debug = format!("{error:?}");
    for private in ["private message", "private-request", "private-handle"] {
        assert!(!debug.contains(private));
    }
    assert!(TransportError {
        effect: Some(EffectClassification::OutcomeUnknown),
        handle: Some("h".into()),
        ..error.clone()
    }
    .validate()
    .is_err());
    assert!(TransportError {
        effect: None,
        ..error
    }
    .validate()
    .is_err());
}
