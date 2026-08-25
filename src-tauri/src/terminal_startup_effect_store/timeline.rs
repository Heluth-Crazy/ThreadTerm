use super::{snapshot_merge, StartupEffectKind, StartupEffectRecord, StartupTimelineState};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashSet};

const MAX_EVENTS: usize = 20;

struct ProjectedEvent {
    value: Value,
    at: u64,
    startup_token: Option<String>,
    ordinary_index: usize,
}

fn record_is_present_submit(record: &StartupEffectRecord) -> bool {
    record.kind == StartupEffectKind::RecordUserSubmit
        && record.timeline == Some(StartupTimelineState::Present)
}

fn event_at(event: &Map<String, Value>) -> Result<u64, String> {
    event
        .get("at")
        .and_then(Value::as_u64)
        .ok_or_else(|| "timeline event at must be a non-negative integer".to_string())
}

fn startup_token(event: &Map<String, Value>) -> Result<Option<String>, String> {
    let Some(value) = event.get("startupEffectToken") else {
        return Ok(None);
    };
    let token = value
        .as_str()
        .ok_or_else(|| "startupEffectToken must be a string".to_string())?;
    Ok(Some(token.to_string()))
}

fn canonical_startup_event(token: &str, at: u64) -> Value {
    let mut event = Map::new();
    event.insert("at".to_string(), Value::from(at));
    event.insert("kind".to_string(), Value::from("user-input"));
    event.insert("summary".to_string(), Value::from("Sent input"));
    event.insert(
        "summaryKey".to_string(),
        Value::from("terminal:view.sentInput"),
    );
    event.insert(
        "startupEffectToken".to_string(),
        Value::from(token.to_string()),
    );
    Value::Object(event)
}

/// Rebuild the restricted startup timeline from authoritative records.
pub(super) fn project_timeline(
    records: &mut [StartupEffectRecord],
    incoming_events: &[Value],
) -> Result<Vec<Value>, String> {
    let mut record_indices = BTreeMap::new();
    for (index, record) in records.iter().enumerate() {
        if record_indices.insert(record.token.clone(), index).is_some() {
            return Err(format!("duplicate startup effect token {}", record.token));
        }
    }

    let mut projected = Vec::new();
    let mut startup_seen = HashSet::new();
    for (ordinary_index, value) in incoming_events.iter().enumerate() {
        let object = value
            .as_object()
            .ok_or_else(|| "timeline event must be an object".to_string())?;
        let at = event_at(object)?;
        let Some(token) = startup_token(object)? else {
            projected.push(ProjectedEvent {
                value: value.clone(),
                at,
                startup_token: None,
                ordinary_index,
            });
            continue;
        };
        let Some(&record_index) = record_indices.get(&token) else {
            continue;
        };
        if !record_is_present_submit(&records[record_index]) || !startup_seen.insert(token.clone())
        {
            continue;
        }
        projected.push(ProjectedEvent {
            value: canonical_startup_event(&token, records[record_index].at),
            at: records[record_index].at,
            startup_token: Some(token),
            ordinary_index,
        });
    }
    for (token, &record_index) in &record_indices {
        if record_is_present_submit(&records[record_index]) && startup_seen.insert(token.clone()) {
            projected.push(ProjectedEvent {
                value: canonical_startup_event(token, records[record_index].at),
                at: records[record_index].at,
                startup_token: Some(token.clone()),
                ordinary_index: usize::MAX,
            });
        }
    }

    projected.sort_by(|left, right| {
        left.at.cmp(&right.at).then_with(|| {
            left.startup_token
                .is_some()
                .cmp(&right.startup_token.is_some())
                .then_with(|| match (&left.startup_token, &right.startup_token) {
                    (Some(left), Some(right)) => left.cmp(right),
                    (None, None) => left.ordinary_index.cmp(&right.ordinary_index),
                    _ => std::cmp::Ordering::Equal,
                })
        })
    });
    let evicted = projected.len().saturating_sub(MAX_EVENTS);
    for event in projected.drain(..evicted) {
        if let Some(token) = event.startup_token {
            if let Some(&index) = record_indices.get(&token) {
                snapshot_merge::set_retired(&mut records[index]);
            }
        }
    }
    Ok(projected.into_iter().map(|event| event.value).collect())
}
