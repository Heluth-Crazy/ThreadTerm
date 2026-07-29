//! NDJSON line classification for the Claude chat sidecar transport.
//!
//! Requests flow Rust -> sidecar as `{id, op, ...}`; the sidecar answers with
//! `{id, ok}` or `{id, error: {message}}` and emits standalone events shaped
//! `{ev, cardId, ...}`. Event payloads are forwarded to the frontend as-is so
//! the sidecar JSON stays the single schema authority.

use serde_json::Value;

pub(crate) const EVENT_EVENT: &str = "claude-chat://event";
pub(crate) const REQUEST_EVENT: &str = "claude-chat://request";
pub(crate) const DISCONNECTED_EVENT: &str = "claude-chat://disconnected";

pub(crate) const EV_SESSION_REQUEST: &str = "session.request";
pub(crate) const EV_SESSION_REQUEST_CANCELLED: &str = "session.request_cancelled";
pub(crate) const EV_HOST_FATAL: &str = "host.fatal";

#[derive(Debug)]
pub(crate) enum SidecarLine {
    Response {
        id: u64,
        result: Result<Value, String>,
    },
    Event {
        ev: String,
        raw: Value,
    },
    Malformed(String),
}

pub(crate) fn classify_line(line: &str) -> SidecarLine {
    let raw: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(err) => return SidecarLine::Malformed(format!("invalid JSON: {err}")),
    };
    if let Some(id) = raw.get("id").and_then(Value::as_u64) {
        if let Some(error) = raw.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| error.to_string());
            return SidecarLine::Response {
                id,
                result: Err(message),
            };
        }
        let ok = raw.get("ok").cloned().unwrap_or(Value::Null);
        return SidecarLine::Response { id, result: Ok(ok) };
    }
    if let Some(ev) = raw.get("ev").and_then(Value::as_str) {
        return SidecarLine::Event {
            ev: ev.to_owned(),
            raw,
        };
    }
    SidecarLine::Malformed("line is neither a response nor an event".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_ok_responses() {
        match classify_line(r#"{"id":3,"ok":{"sessionId":"s1"}}"#) {
            SidecarLine::Response { id, result } => {
                assert_eq!(id, 3);
                assert_eq!(result.unwrap()["sessionId"], "s1");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn classifies_error_responses() {
        match classify_line(r#"{"id":4,"error":{"message":"boom"}}"#) {
            SidecarLine::Response { id, result } => {
                assert_eq!(id, 4);
                assert_eq!(result.unwrap_err(), "boom");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn classifies_events() {
        match classify_line(r#"{"ev":"session.status","cardId":"c1","phase":"ready"}"#) {
            SidecarLine::Event { ev, raw } => {
                assert_eq!(ev, "session.status");
                assert_eq!(raw["cardId"], "c1");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn flags_malformed_lines() {
        assert!(matches!(classify_line("{oops"), SidecarLine::Malformed(_)));
        assert!(matches!(
            classify_line(r#"{"neither":true}"#),
            SidecarLine::Malformed(_)
        ));
    }
}
