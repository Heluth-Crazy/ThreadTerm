//! Deterministic shared-runner service dependency decisions; no wall-clock waits.
use super::setup::{service_decision, ServiceDecision};
use chrono::{Duration, TimeZone, Utc};

fn at(seconds: i64) -> chrono::DateTime<Utc> {
    Utc.timestamp_opt(seconds, 0).single().unwrap()
}

#[test]
fn service_dependency_requires_ready_or_the_none_grace_period() {
    let started = at(10_000);
    assert_eq!(
        service_decision(started + Duration::milliseconds(2999), started, started, "running", Some("none"), false),
        ServiceDecision::Wait,
    );
    assert_eq!(
        service_decision(started + Duration::seconds(3), started, started, "running", Some("none"), false),
        ServiceDecision::Satisfied,
    );
    assert_eq!(
        service_decision(started, started, started, "starting", Some("ready"), false),
        ServiceDecision::Satisfied,
    );
}

#[test]
fn service_dependency_times_out_at_the_injected_deadline() {
    let started = at(20_000);
    assert_eq!(
        service_decision(started + Duration::milliseconds(119_999), started, started, "running", Some("waiting"), false),
        ServiceDecision::Wait,
    );
    assert_eq!(
        service_decision(started + Duration::seconds(120), started, started, "running", Some("waiting"), false),
        ServiceDecision::Failed,
    );
}

#[test]
fn service_dependency_stops_for_process_failure_or_cancellation() {
    let started = at(30_000);
    assert_eq!(
        service_decision(started, started, started, "exited", Some("waiting"), false),
        ServiceDecision::Failed,
    );
    assert_eq!(
        service_decision(started, started, started, "running", Some("ready"), true),
        ServiceDecision::Cancelled,
    );
}
