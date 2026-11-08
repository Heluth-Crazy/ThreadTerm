//! Authored before the P1 adapter implementation; source-derived cases are not live receipts.
use super::*;
use crate::providers::conformance::fixture;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::thread;

fn native_fixture(case: &str) -> Value {
    fixture("opencode-v2-rest-schema.jsonl")
        .into_iter()
        .find(|row| row["case"] == case)
        .unwrap()["value"]
        .clone()
}

#[test]
fn captured_225_health_session_and_idle_interrupt_keep_native_meaning() {
    let floor = fixture("opencode-v1-native-startup.jsonl");
    ApiDialect::Legacy
        .validate_health(&floor.iter().find(|row| row["case"] == "health").unwrap()["value"])
        .unwrap();
    let rows = fixture("opencode-v2-native-startup.jsonl");
    let captured = |case| rows.iter().find(|row| row["case"] == case).unwrap()["value"].clone();
    ApiDialect::V2.validate_health(&captured("info")).unwrap();
    let created = ResponseShape::Data
        .decode(captured("session_create"))
        .unwrap();
    let read = ResponseShape::Data
        .decode(captured("session_read"))
        .unwrap();
    let id = session_identity(&created, None).unwrap();
    assert_eq!(session_identity(&read, Some(&id)).unwrap(), id);
    let admitted = ResponseShape::Data
        .decode(captured("prompt_admission_execution_suppressed"))
        .unwrap();
    assert_eq!(admitted["sessionID"], id);
    assert_eq!(
        admitted["type"], "user",
        "admission is an inbox message, not completion"
    );
    assert!(
        interrupt_confirmed(ApiDialect::V2, &captured("idle_interrupt")).is_err(),
        "idle no-op never proves that a local active turn was stopped"
    );
}

#[test]
fn native_persistence_and_read_catalogue_shapes_keep_the_original_identity() {
    let rows = fixture("opencode-v2-native-persistence.jsonl");
    let captured = |case| rows.iter().find(|row| row["case"] == case).unwrap()["value"].clone();
    let created = ResponseShape::Data.decode(captured("create")).unwrap();
    let reopened = ResponseShape::Data
        .decode(captured("read_second_process"))
        .unwrap();
    let id = session_identity(&created, None).unwrap();
    assert_eq!(session_identity(&reopened, Some(&id)).unwrap(), id);
    assert!(
        ResponseShape::Data
            .decode(captured("active"))
            .unwrap()
            .is_object(),
        "an empty process-owned map is a shape, not universal idle proof"
    );
    let messages = captured("messages");
    assert_eq!(
        ResponseShape::Data.decode(messages.clone()).unwrap(),
        json!([])
    );
    assert!(
        messages.get("cursor").is_some(),
        "future snapshot/history pagination must retain the native cursor envelope"
    );
    assert!(ResponseShape::LocationData
        .decode(captured("models"))
        .unwrap()
        .is_array());
    assert!(ResponseShape::Direct
        .decode(captured("location"))
        .unwrap()
        .get("directory")
        .is_some());
}



#[test]
fn health_requires_the_native_schema_without_using_version_thresholds() {
    assert!(ApiDialect::Legacy.require_event_compatibility().is_ok());
    assert_eq!(
        ApiDialect::V2
            .require_event_compatibility()
            .unwrap_err()
            .code,
        "provider_method_unsupported"
    );
    assert!(ApiDialect::V2
        .validate_health(&native_fixture("info"))
        .is_ok());
    assert!(ApiDialect::V2
        .validate_health(&json!({"version":"future","pid":1,"urls":[],"paths":{"tmp":"x"}}))
        .is_ok());
    for value in [
        json!({}),
        json!({"version":"2.2.5"}),
        json!({"data":native_fixture("info")}),
        json!({"version":"2.2.5","pid":-1,"urls":[],"paths":{"tmp":"x"}}),
    ] {
        assert!(ApiDialect::V2.validate_health(&value).is_err(), "{value}");
    }
    assert!(ApiDialect::Legacy
        .validate_health(&json!({"healthy":true,"version":"1.18.35"}))
        .is_ok());
    assert!(ApiDialect::Legacy
        .validate_health(&json!({"healthy":false,"version":"1.18.35"}))
        .is_err());
}

#[test]
fn negotiation_requires_positive_read_only_schema_evidence() {
    let (base, worker) = peer(vec![(
        "200 OK",
        "application/json",
        native_fixture("info").to_string(),
    )]);
    assert_eq!(
        negotiate(&Client::new(), &base, "owned").unwrap(),
        Some(ApiDialect::V2)
    );
    assert!(worker.join().unwrap()[0]
        .0
        .starts_with("GET /api/info HTTP/1.1"));

    let (base, worker) = peer(vec![
        ("401 Unauthorized", "application/json", "{}".into()),
        (
            "200 OK",
            "application/json",
            json!({"healthy":true,"version":"1.18.35"}).to_string(),
        ),
    ]);
    assert_eq!(
        negotiate(&Client::new(), &base, "owned").unwrap(),
        Some(ApiDialect::Legacy)
    );
    let requests = worker.join().unwrap();
    assert!(requests[1].0.starts_with("GET /global/health HTTP/1.1"));
    for (headers, _) in requests {
        assert!(headers.starts_with("GET "));
    }

    for (status, mime, body) in [
        ("200 OK", "text/html", "<html>frontend</html>"),
        ("200 OK", "application/json", "{}"),
        ("401 Unauthorized", "application/json", "{}"),
        ("404 Not Found", "application/json", "{}"),
    ] {
        let (base, worker) = peer(vec![
            (status, mime, body.into()),
            (status, mime, body.into()),
        ]);
        assert!(negotiate(&Client::new(), &base, "owned").is_err());
        assert!(worker
            .join()
            .unwrap()
            .iter()
            .all(|(headers, _)| headers.starts_with("GET ")));
    }
}

#[test]
fn server_becoming_ready_between_probes_does_not_look_like_bad_auth() {
    let (base, worker) = peer(vec![
        ("", "", String::new()), // connection exists, but no valid HTTP response yet
        ("401 Unauthorized", "application/json", "{}".into()),
        (
            "200 OK",
            "application/json",
            native_fixture("info").to_string(),
        ),
    ]);
    let client = Client::new();
    assert_eq!(
        negotiate(&client, &base, "owned").unwrap(),
        None,
        "one rejected dialect cannot identify a server that was unavailable during its other probe"
    );
    assert_eq!(
        negotiate(&client, &base, "owned").unwrap(),
        Some(ApiDialect::V2)
    );
    assert_eq!(
        worker.join().unwrap().len(),
        3,
        "only read-only negotiation requests are retried"
    );
}

#[test]
fn endpoint_decoders_do_not_guess_envelopes_or_accept_missing_identity() {
    let session = ResponseShape::Data
        .decode(native_fixture("session"))
        .unwrap();
    assert_eq!(
        session_identity(&session, Some("ses_exact_native")).unwrap(),
        "ses_exact_native"
    );
    assert!(session_identity(&session, Some("ses_other")).is_err());
    assert!(session_identity(&json!({}), Some("ses_exact_native")).is_err());
    assert!(session_identity(&json!({"id":""}), None).is_err());
    assert!(ResponseShape::Data
        .decode(json!({"id":"ses_direct"}))
        .is_err());
    assert!(ResponseShape::LocationData
        .decode(json!({"data":[]}))
        .is_err());
    assert_eq!(
        ResponseShape::LocationData
            .decode(native_fixture("catalogue"))
            .unwrap(),
        json!([])
    );
    assert_eq!(
        ResponseShape::Direct.decode(json!({"data":17})).unwrap(),
        json!({"data":17})
    );
    assert!(interrupt_confirmed(ApiDialect::V2, &json!(true)).is_err());
    assert!(interrupt_confirmed(ApiDialect::Legacy, &json!({"interrupted":true})).is_err());
    assert!(interrupt_confirmed(ApiDialect::V2, &json!({"interrupted":false})).is_err());
    assert!(interrupt_confirmed(ApiDialect::V2, &native_fixture("interrupt")).is_ok());
    assert!(interrupt_confirmed(ApiDialect::Legacy, &json!(true)).is_ok());
}

// A bounded real HTTP peer tests the production request builder and decoder together.
fn peer(
    replies: Vec<(&'static str, &'static str, String)>,
) -> (String, thread::JoinHandle<Vec<(String, Value)>>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = listener.local_addr().unwrap();
    let worker = thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, content_type, body) in replies {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut headers = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                assert!(!line.is_empty());
                headers.push_str(&line);
            }
            let length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|s| s.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            let mut bytes = vec![0; length];
            reader.read_exact(&mut bytes).unwrap();
            let request_body = if bytes.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&bytes).unwrap()
            };
            requests.push((headers, request_body));
            write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
        requests
    });
    (format!("http://{address}"), worker)
}

#[test]
fn legacy_and_v2_requests_keep_exact_routes_auth_location_and_bodies() {
    for dialect in [ApiDialect::Legacy, ApiDialect::V2] {
        let session = json!({"id":"ses_exact_native"});
        let body = if dialect == ApiDialect::V2 {
            json!({"data":session})
        } else {
            session
        };
        let mut replies = vec![];
        if dialect == ApiDialect::V2 {
            replies.push((
                "200 OK",
                "application/json",
                json!({"directory":"C:/isolated/project","project":{"id":"global"}}).to_string(),
            ));
        }
        replies.extend([
            ("200 OK", "application/json", body.to_string()),
            ("200 OK", "application/json", body.to_string()),
            (
                "200 OK",
                "application/json",
                if dialect == ApiDialect::V2 {
                    json!({"interrupted":true})
                } else {
                    json!(true)
                }
                .to_string(),
            ),
        ]);
        let (base, worker) = peer(replies);
        let api = NativeApi::new(
            Client::new(),
            base,
            "C:/isolated/project".into(),
            "owned-password".into(),
            dialect,
        );
        assert_eq!(api.open_session(None).unwrap()["id"], "ses_exact_native");
        api.open_session(Some("ses_exact_native")).unwrap();
        api.interrupt("ses_exact_native").unwrap();
        let mut requests = worker.join().unwrap();
        if dialect == ApiDialect::V2 {
            let location = requests.remove(0);
            assert!(location
                .0
                .starts_with("GET /api/location?location%5Bdirectory%5D="));
        }
        assert_eq!(requests.len(), 3, "each mutation is sent once");
        let auth = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:owned-password", dialect.username()));
        for (headers, _) in &requests {
            assert!(headers.to_ascii_lowercase().contains(&format!(
                "authorization: basic {}",
                auth.to_ascii_lowercase()
            )));
        }
        if dialect == ApiDialect::V2 {
            assert!(requests[0].0.starts_with("POST /api/session HTTP/1.1"));
            assert_eq!(
                requests[0].1,
                json!({"location":{"directory":"C:/isolated/project"}})
            );
            assert!(requests[1]
                .0
                .starts_with("GET /api/session/ses_exact_native HTTP/1.1"));
            assert!(requests[2]
                .0
                .starts_with("POST /api/session/ses_exact_native/interrupt HTTP/1.1"));
        } else {
            assert!(requests[0].0.starts_with("POST /session?directory="));
            assert_eq!(requests[0].1, json!({}));
            assert!(requests[1]
                .0
                .starts_with("GET /session/ses_exact_native?directory="));
            assert!(requests[2]
                .0
                .starts_with("POST /session/ses_exact_native/abort?directory="));
        }
    }
}

#[test]
fn v2_prompt_is_one_admission_after_location_and_never_a_completion() {
    let receipt = json!({"id":"msg_native","sessionID":"ses_exact_native","type":"user","payload":{"text":"hello"},"delivery":"steer"});
    let (base, worker) = peer(vec![
        (
            "200 OK",
            "application/json",
            json!({"directory":"C:/isolated/project","project":{"id":"global"}}).to_string(),
        ),
        (
            "200 OK",
            "application/json",
            json!({"data":receipt}).to_string(),
        ),
    ]);
    let api = NativeApi::new(
        Client::new(),
        base,
        "C:/isolated/project".into(),
        "owned".into(),
        ApiDialect::V2,
    );
    assert_eq!(
        api.admit_prompt("ses_exact_native", "hello", &[]).unwrap(),
        receipt
    );
    let requests = worker.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0]
        .0
        .starts_with("GET /api/location?location%5Bdirectory%5D="));
    assert!(requests[1]
        .0
        .starts_with("POST /api/session/ses_exact_native/prompt HTTP/1.1"));
    assert_eq!(
        requests[1].1,
        json!({"text":"hello"}),
        "production input schedules execution; resume:false is capture-only"
    );
}

#[test]
fn failed_location_never_dispatches_a_prompt_or_creates_a_session() {
    for create in [false, true] {
        let (base, worker) = peer(vec![("404 Not Found", "application/json", "{}".into())]);
        let api = NativeApi::new(
            Client::new(),
            base,
            "C:/isolated/project".into(),
            "owned".into(),
            ApiDialect::V2,
        );
        let result = if create {
            api.open_session(None)
        } else {
            api.admit_prompt("ses_exact_native", "hello", &[])        };
        assert!(result.is_err());
        let requests = worker.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].0.starts_with("GET "));
    }
}

#[test]
fn html_missing_envelope_no_content_and_auth_failure_never_become_json_success() {
    for (status, content_type, body, shape) in [
        (
            "200 OK",
            "text/html",
            "<html>frontend</html>",
            ResponseShape::Direct,
        ),
        ("200 OK", "application/json", "{}", ResponseShape::Data),
        (
            "204 No Content",
            "application/json",
            "",
            ResponseShape::Data,
        ),
        (
            "401 Unauthorized",
            "application/json",
            "{}",
            ResponseShape::Direct,
        ),
    ] {
        let (base, worker) = peer(vec![(status, content_type, body.into())]);
        let api = NativeApi::new(
            Client::new(),
            base,
            "C:/isolated/project".into(),
            "owned".into(),
            ApiDialect::V2,
        );
        assert!(api
            .json_request(
                reqwest::Method::POST,
                "/api/session",
                Some(json!({})),
                shape
            )
            .is_err());
        assert_eq!(worker.join().unwrap().len(), 1);
    }
    let (base, worker) = peer(vec![("204 No Content", "application/json", String::new())]);
    let api = NativeApi::new(
        Client::new(),
        base,
        "C:/isolated/project".into(),
        "owned".into(),
        ApiDialect::V2,
    );
    assert_eq!(
        api.json_request(
            reqwest::Method::POST,
            "/api/session/ses/permission/p/reply",
            Some(json!({"decision":"once"})),
            ResponseShape::NoContent
        )
        .unwrap(),
        Value::Null
    );
    worker.join().unwrap();
}
