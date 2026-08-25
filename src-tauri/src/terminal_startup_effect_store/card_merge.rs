use super::projection::{classify_projection, ProjectionDecision};
use super::snapshot_merge::{merge_effect_records, set_retired};
use super::timeline::project_timeline;
use super::{card_startup_side_effects, StartupEffectRecord, StartupSideEffects};
use serde_json::{Map, Value};

const PROVIDER_FIELDS: [&str; 4] = [
    "providerSessionId",
    "providerSessionState",
    "providerSessionBoundAt",
    "providerSessionLastResumeAt",
];

fn card_object(value: &Value) -> Result<&Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| "terminal card must be an object".to_string())
}

fn card_identity(value: &Value) -> Result<(&str, &str), String> {
    let object = card_object(value)?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "terminal card id must be a non-empty string".to_string())?;
    let pty_id = object
        .get("ptyId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "terminal card ptyId must be a non-empty string".to_string())?;
    Ok((id, pty_id))
}

fn card_message_count(value: &Value) -> Result<u64, String> {
    card_object(value)?
        .get("messageCount")
        .and_then(Value::as_u64)
        .ok_or_else(|| "terminal card messageCount must be a u64".to_string())
}

fn card_events(value: &Value) -> Result<&[Value], String> {
    card_object(value)?
        .get("events")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| "terminal card events must be an array".to_string())
}

fn encode_projection(
    projection: &StartupSideEffects,
    records: Vec<StartupEffectRecord>,
) -> Result<Value, String> {
    let mut projection = projection.clone();
    projection.applied = records;
    let mut value = serde_json::to_value(projection)
        .map_err(|error| format!("encode startup projection: {error}"))?;
    if projection_value_parent_is_none(&value) {
        value
            .as_object_mut()
            .ok_or_else(|| "encoded startup projection must be an object".to_string())?
            .remove("parentProjectionEpoch");
    }
    Ok(value)
}

fn projection_value_parent_is_none(value: &Value) -> bool {
    value
        .get("parentProjectionEpoch")
        .is_some_and(Value::is_null)
}

fn canonicalize(
    output: &mut Map<String, Value>,
    authority: Option<&StartupSideEffects>,
    current_records: &[StartupEffectRecord],
    incoming: Option<&StartupSideEffects>,
    incoming_count: u64,
    events: &[Value],
) -> Result<(), String> {
    let incoming_records = incoming.map_or(&[][..], |projection| projection.applied.as_slice());
    let (mut records, message_count) =
        merge_effect_records(current_records, incoming_records, incoming_count)?;
    let events = project_timeline(&mut records, events)?;
    output.insert("messageCount".to_string(), Value::from(message_count));
    output.insert("events".to_string(), Value::Array(events));
    match authority {
        Some(projection) => output.insert(
            "startupSideEffects".to_string(),
            encode_projection(projection, records)?,
        ),
        None => output.remove("startupSideEffects"),
    };
    Ok(())
}

fn apply_provider_authority(output: &mut Map<String, Value>, current: &Map<String, Value>) {
    for field in PROVIDER_FIELDS {
        match current.get(field) {
            Some(value) => {
                output.insert(field.to_string(), value.clone());
            }
            None => {
                output.remove(field);
            }
        }
    }
}

pub(super) fn merge_card(current: Option<&Value>, incoming: &Value) -> Result<Value, String> {
    let (incoming_id, incoming_pty_id) = card_identity(incoming)?;
    let incoming_projection = card_startup_side_effects(incoming)?;
    let Some(current) = current else {
        if incoming_projection.is_none() {
            return Ok(incoming.clone());
        }
        let incoming_count = card_message_count(incoming)?;
        let incoming_events = card_events(incoming)?;
        let mut output = card_object(incoming)?.clone();
        canonicalize(
            &mut output,
            incoming_projection.as_ref(),
            &[],
            incoming_projection.as_ref(),
            incoming_count,
            incoming_events,
        )?;
        return Ok(Value::Object(output));
    };

    let (current_id, current_pty_id) = card_identity(current)?;
    if current_id != incoming_id {
        return Err("terminal card ids do not match".to_string());
    }
    let current_object = card_object(current)?;
    let current_projection = card_startup_side_effects(current)?;
    let decision = classify_projection(
        current_pty_id,
        incoming_pty_id,
        current_projection.as_ref(),
        incoming_projection.as_ref(),
    )?;
    if decision == ProjectionDecision::RejectStale {
        return Ok(current.clone());
    }
    if decision == ProjectionDecision::LegacyPassThrough {
        return Ok(incoming.clone());
    }

    let incoming_count = card_message_count(incoming)?;
    let incoming_events = card_events(incoming)?;
    let mut output = card_object(incoming)?.clone();
    let mut current_records = current_projection
        .as_ref()
        .map_or_else(Vec::new, |projection| projection.applied.clone());
    if decision == ProjectionDecision::AcceptReconfigure {
        for record in &mut current_records {
            set_retired(record);
        }
    }
    let authority = match decision {
        ProjectionDecision::AcceptIncoming | ProjectionDecision::AcceptReconfigure => {
            incoming_projection.as_ref()
        }
        ProjectionDecision::MergeSamePty => current_projection.as_ref(),
        ProjectionDecision::LegacyPassThrough | ProjectionDecision::RejectStale => None,
    };
    canonicalize(
        &mut output,
        authority,
        &current_records,
        incoming_projection.as_ref(),
        incoming_count,
        incoming_events,
    )?;
    if decision == ProjectionDecision::MergeSamePty {
        apply_provider_authority(&mut output, current_object);
    }
    Ok(Value::Object(output))
}
