//! Opt-in, correlation-only timing records for the desktop-to-provider send path.
//!
//! A desktop-launched runtime has stderr appended to `<v3 data>/runtime.log`.
//! `monotonicUs` is relative to this process only: join desktop and runtime
//! records by correlation ID and compare durations, never subtract their clocks.

use serde::Serialize;
use std::{
    cell::RefCell,
    ffi::OsStr,
    io::{self, Write},
    marker::PhantomData,
    rc::Rc,
    sync::OnceLock,
    time::Instant,
};

const ENABLE_ENV: &str = "THREADTERM_V3_SEND_TRACE";
const MAX_CORRELATION_ID_LEN: usize = 128;

static ENABLED: OnceLock<bool> = OnceLock::new();
static ORIGIN: OnceLock<Instant> = OnceLock::new();

thread_local! {
    static CONTEXT: RefCell<Option<Context>> = const { RefCell::new(None) };
}

#[derive(Debug)]
pub(crate) struct Context {
    request_id: Option<String>,
    operation_id: Option<String>,
    session_id: Option<String>,
}

impl Context {
    /// Captures correlation IDs only when tracing is enabled. Invalid IDs are
    /// omitted so arbitrary request content cannot cross the trace boundary.
    pub(crate) fn capture(
        request_id: Option<&str>,
        operation_id: Option<&str>,
        session_id: Option<&str>,
    ) -> Option<Self> {
        if !enabled() {
            return None;
        }

        let explicit = Self {
            request_id: owned_correlation_id(request_id),
            operation_id: owned_correlation_id(operation_id),
            session_id: owned_correlation_id(session_id),
        };
        Some(CONTEXT.with(|slot| merge_context(explicit, slot.borrow().as_ref())))
    }

    /// Installs this context on the current thread until the returned guard is
    /// dropped. The guard is deliberately thread-bound because it restores a
    /// thread-local value.
    pub(crate) fn enter(self) -> ContextGuard {
        let previous = CONTEXT.with(|slot| slot.replace(Some(self)));
        ContextGuard {
            previous,
            _thread_bound: PhantomData,
        }
    }
}

pub(crate) struct ContextGuard {
    previous: Option<Context>,
    _thread_bound: PhantomData<Rc<()>>,
}

impl Drop for ContextGuard {
    fn drop(&mut self) {
        let previous = self.previous.take();
        CONTEXT.with(|slot| {
            slot.replace(previous);
        });
    }
}

#[derive(Debug, Default)]
pub(crate) struct Event<'a> {
    stage: &'static str,
    request_id: Option<&'a str>,
    operation_id: Option<&'a str>,
    session_id: Option<&'a str>,
    method: Option<&'static str>,
    outcome: Option<&'static str>,
    step: Option<&'static str>,
    duration_us: Option<u64>,
    queue_wait_us: Option<u64>,
    active_request_id: Option<&'a str>,
    active_method: Option<&'static str>,
}

impl<'a> Event<'a> {
    pub(crate) fn new(stage: &'static str) -> Self {
        Self {
            stage,
            ..Self::default()
        }
    }

    pub(crate) fn request_id(mut self, value: &'a str) -> Self {
        self.request_id = safe_correlation_id(value);
        self
    }

    pub(crate) fn operation_id(mut self, value: &'a str) -> Self {
        self.operation_id = safe_correlation_id(value);
        self
    }

    pub(crate) fn session_id(mut self, value: &'a str) -> Self {
        self.session_id = safe_correlation_id(value);
        self
    }

    pub(crate) fn method(mut self, value: &'static str) -> Self {
        self.method = Some(value);
        self
    }

    pub(crate) fn outcome(mut self, value: &'static str) -> Self {
        self.outcome = Some(value);
        self
    }

    pub(crate) fn step(mut self, value: &'static str) -> Self {
        self.step = Some(value);
        self
    }

    pub(crate) fn duration_us(mut self, value: Option<u64>) -> Self {
        self.duration_us = value;
        self
    }

    pub(crate) fn queue_wait_us(mut self, value: Option<u64>) -> Self {
        self.queue_wait_us = value;
        self
    }

    pub(crate) fn active_request_id(mut self, value: &'a str) -> Self {
        self.active_request_id = safe_correlation_id(value);
        self
    }

    pub(crate) fn active_method(mut self, value: &'static str) -> Self {
        self.active_method = Some(value);
        self
    }
}

#[derive(Debug)]
pub(crate) struct Timer(Option<Instant>);

impl Timer {
    pub(crate) fn start() -> Self {
        if !enabled() {
            return Self(None);
        }

        ORIGIN.get_or_init(Instant::now);
        Self(Some(Instant::now()))
    }

    pub(crate) fn elapsed_us(&self) -> Option<u64> {
        self.0.map(|started| micros(started.elapsed().as_micros()))
    }
}

pub(crate) struct Span {
    end_stage: &'static str,
    method: &'static str,
    timer: Timer,
}

impl Span {
    pub(crate) fn begin(
        begin_stage: &'static str,
        end_stage: &'static str,
        method: &'static str,
    ) -> Self {
        let timer = Timer::start();
        emit(Event::new(begin_stage).method(method));
        Self {
            end_stage,
            method,
            timer,
        }
    }
}

impl Drop for Span {
    fn drop(&mut self) {
        emit(
            Event::new(self.end_stage)
                .method(self.method)
                .duration_us(self.timer.elapsed_us()),
        );
    }
}

pub(crate) fn enabled() -> bool {
    *ENABLED.get_or_init(|| enabled_from(std::env::var_os(ENABLE_ENV).as_deref()))
}

pub(crate) fn emit(event: Event<'_>) {
    if !enabled() {
        return;
    }

    CONTEXT.with(|slot| {
        let context = slot.borrow();
        if !has_correlation(&event, context.as_ref()) {
            return;
        }
        let stderr = io::stderr();
        let mut writer = stderr.lock();
        let at_us = micros(ORIGIN.get_or_init(Instant::now).elapsed().as_micros());
        let mut line = Vec::with_capacity(384);
        if write_event(&mut line, &event, context.as_ref(), at_us).is_ok() {
            line.push(b'\n');
            let _ = writer.write_all(&line);
        }
    });
}

fn has_correlation(event: &Event<'_>, context: Option<&Context>) -> bool {
    event.request_id.is_some()
        || event.operation_id.is_some()
        || event.session_id.is_some()
        || context.is_some_and(|value| {
            value.request_id.is_some() || value.operation_id.is_some() || value.session_id.is_some()
        })
}

fn enabled_from(value: Option<&OsStr>) -> bool {
    value == Some(OsStr::new("1"))
}

pub(crate) fn safe_correlation_id(value: &str) -> Option<&str> {
    (!value.is_empty()
        && value.len() <= MAX_CORRELATION_ID_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')))
    .then_some(value)
}

fn owned_correlation_id(value: Option<&str>) -> Option<String> {
    value.and_then(safe_correlation_id).map(str::to_owned)
}

fn merge_context(explicit: Context, current: Option<&Context>) -> Context {
    let Some(current) = current else { return explicit };
    Context {
        request_id: explicit.request_id.or_else(|| current.request_id.clone()),
        operation_id: explicit.operation_id.or_else(|| current.operation_id.clone()),
        session_id: explicit.session_id.or_else(|| current.session_id.clone()),
    }
}

fn micros(value: u128) -> u64 {
    value.min(u64::MAX as u128) as u64
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Record<'a> {
    kind: &'static str,
    schema: u8,
    source: &'static str,
    monotonic_us: u64,
    stage: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    step: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    queue_wait_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_request_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_method: Option<&'static str>,
}

fn write_event<W: Write>(
    writer: W,
    event: &Event<'_>,
    context: Option<&Context>,
    at_us: u64,
) -> serde_json::Result<()> {
    let record = Record {
        kind: "threadterm.sendTrace",
        schema: 1,
        source: "runtime",
        monotonic_us: at_us,
        stage: event.stage,
        request_id: event.request_id.or_else(|| context?.request_id.as_deref()),
        operation_id: event
            .operation_id
            .or_else(|| context?.operation_id.as_deref()),
        session_id: event.session_id.or_else(|| context?.session_id.as_deref()),
        method: event.method,
        outcome: event.outcome,
        step: event.step,
        duration_us: event.duration_us,
        queue_wait_us: event.queue_wait_us,
        active_request_id: event.active_request_id,
        active_method: event.active_method,
    };
    serde_json::to_writer(writer, &record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn trace_flag_requires_exact_one() {
        assert!(enabled_from(Some(OsStr::new("1"))));
        for value in [
            None,
            Some(""),
            Some("true"),
            Some("01"),
            Some(" 1"),
            Some("1 "),
        ] {
            assert!(!enabled_from(value.map(OsStr::new)));
        }
    }

    #[test]
    fn correlation_ids_are_bounded_and_content_safe() {
        for value in ["request-1", "op_2", "session.example:3"] {
            assert_eq!(safe_correlation_id(value), Some(value));
        }
        for value in [
            "",
            "prompt text",
            "C:\\private",
            "../../secret",
            "snowman-☃",
        ] {
            assert_eq!(safe_correlation_id(value), None);
        }
        assert_eq!(safe_correlation_id(&"x".repeat(129)), None);
    }

    #[test]
    fn event_schema_uses_only_whitelisted_fields_and_omits_absent_values() {
        let context = Context {
            request_id: Some("request-1".to_owned()),
            operation_id: Some("operation-1".to_owned()),
            session_id: None,
        };
        let event = Event::new("provider.handoff.end")
            .method("chat.send")
            .outcome("ok")
            .duration_us(Some(42));
        let mut output = Vec::new();
        write_event(&mut output, &event, Some(&context), 7).unwrap();
        let value: Value = serde_json::from_slice(&output).unwrap();

        assert_eq!(value["kind"], "threadterm.sendTrace");
        assert_eq!(value["schema"], 1);
        assert_eq!(value["source"], "runtime");
        assert_eq!(value["monotonicUs"], 7);
        assert_eq!(value["stage"], "provider.handoff.end");
        assert_eq!(value["requestId"], "request-1");
        assert_eq!(value["operationId"], "operation-1");
        assert_eq!(value["method"], "chat.send");
        assert_eq!(value["outcome"], "ok");
        assert_eq!(value["durationUs"], 42);
        assert!(value.get("sessionId").is_none());
        assert!(value.get("prompt").is_none());
        assert!(value.get("path").is_none());
        assert!(value.get("credential").is_none());
    }

    #[test]
    fn explicit_ids_override_scoped_context() {
        let context = Context {
            request_id: Some("request-outer".to_owned()),
            operation_id: Some("operation-outer".to_owned()),
            session_id: Some("session-outer".to_owned()),
        };
        let event = Event::new("transport.dequeue")
            .request_id("request-inner")
            .operation_id("operation-inner")
            .session_id("session-inner");
        let mut output = Vec::new();
        write_event(&mut output, &event, Some(&context), 1).unwrap();
        let value: Value = serde_json::from_slice(&output).unwrap();

        assert_eq!(value["requestId"], "request-inner");
        assert_eq!(value["operationId"], "operation-inner");
        assert_eq!(value["sessionId"], "session-inner");
    }

    #[test]
    fn events_without_a_safe_correlation_are_rejected() {
        let empty_context = Context {
            request_id: None,
            operation_id: None,
            session_id: None,
        };
        assert!(!has_correlation(&Event::new("provider.background"), None));
        assert!(!has_correlation(
            &Event::new("provider.background"),
            Some(&empty_context)
        ));
        assert!(has_correlation(
            &Event::new("transport.enqueue").request_id("request-1"),
            None
        ));
    }

    #[test]
    fn nested_context_guard_restores_the_previous_context() {
        let outer = Context {
            request_id: Some("request-outer".to_owned()),
            operation_id: None,
            session_id: None,
        };
        let inner = Context {
            request_id: Some("request-inner".to_owned()),
            operation_id: None,
            session_id: None,
        };

        let outer_guard = outer.enter();
        CONTEXT.with(|slot| {
            assert_eq!(
                slot.borrow().as_ref().unwrap().request_id.as_deref(),
                Some("request-outer")
            );
        });
        {
            let _inner_guard = inner.enter();
            CONTEXT.with(|slot| {
                assert_eq!(
                    slot.borrow().as_ref().unwrap().request_id.as_deref(),
                    Some("request-inner")
                );
            });
        }
        CONTEXT.with(|slot| {
            assert_eq!(
                slot.borrow().as_ref().unwrap().request_id.as_deref(),
                Some("request-outer")
            );
        });
        drop(outer_guard);
        CONTEXT.with(|slot| assert!(slot.borrow().is_none()));
    }

    #[test]
    fn nested_capture_inherits_missing_request_id() {
        let current = Context {
            request_id: Some("request-outer".to_owned()),
            operation_id: Some("operation-outer".to_owned()),
            session_id: Some("session-outer".to_owned()),
        };
        let explicit = Context {
            request_id: None,
            operation_id: Some("operation-inner".to_owned()),
            session_id: None,
        };

        let merged = merge_context(explicit, Some(&current));
        assert_eq!(merged.request_id.as_deref(), Some("request-outer"));
        assert_eq!(merged.operation_id.as_deref(), Some("operation-inner"));
        assert_eq!(merged.session_id.as_deref(), Some("session-outer"));
    }
}
