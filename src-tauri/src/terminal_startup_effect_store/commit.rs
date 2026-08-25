use super::{
    card_startup_side_effects, envelope_merge, find_card_by_id, StartupEffectCommit,
    StartupEffectCommitOutcome, StartupEffectKind, StartupSideEffects, STARTUP_EFFECT_SCHEMA,
};
use crate::managed_state::{ManagedStateStore, TERMINAL_STORE_KEY};
use serde_json::Value;

fn projection_value(projection: StartupSideEffects) -> Result<Value, String> {
    serde_json::to_value(projection).map_err(|error| format!("encode startup projection: {error}"))
}

fn next_projection(
    current: Option<&StartupSideEffects>,
    effect: &StartupEffectCommit,
) -> Result<StartupSideEffects, String> {
    let record = effect.to_record()?;
    let mut projection = current.cloned().unwrap_or_else(|| StartupSideEffects {
        schema: STARTUP_EFFECT_SCHEMA,
        projection_epoch: effect.token().to_string(),
        parent_projection_epoch: None,
        applied: Vec::new(),
    });
    projection.applied.push(record.clone());
    projection
        .applied
        .sort_by(|left, right| left.token.cmp(&right.token));
    Ok(projection)
}

fn existing_outcome(
    projection: Option<&StartupSideEffects>,
    effect: &StartupEffectCommit,
) -> Option<StartupEffectCommitOutcome> {
    projection.and_then(|projection| {
        projection
            .applied
            .iter()
            .find(|record| record.token == effect.token())
            .map(|record| {
                if record.kind == effect.kind() {
                    StartupEffectCommitOutcome::AlreadyApplied
                } else {
                    StartupEffectCommitOutcome::Conflict
                }
            })
    })
}

pub(super) fn commit(
    managed_state: &ManagedStateStore,
    effect: StartupEffectCommit,
) -> Result<StartupEffectCommitOutcome, String> {
    effect.validate()?;
    managed_state.update_value(TERMINAL_STORE_KEY, move |current| {
        let Some(raw) = current else {
            return Ok((None, StartupEffectCommitOutcome::Obsolete));
        };
        let mut envelope = envelope_merge::parse_envelope(raw, "current")?;
        let Some(target) = find_card_by_id(&envelope, effect.card_id())?.cloned() else {
            return Ok((Some(raw.to_string()), StartupEffectCommitOutcome::Obsolete));
        };
        if super::commit_target::effective_pty(&target)? != effect.pty_id() {
            return Ok((Some(raw.to_string()), StartupEffectCommitOutcome::Obsolete));
        }
        let projection = card_startup_side_effects(&target)?;
        if let Some(outcome) = existing_outcome(projection.as_ref(), &effect) {
            return Ok((Some(raw.to_string()), outcome));
        }
        if let Some(outcome) = super::commit_binding::conflict(&envelope, &target, &effect)? {
            return Ok((Some(raw.to_string()), outcome));
        }
        let card = super::commit_target::card_at_mut(&mut envelope, effect.card_id())?;
        let mut projection = next_projection(projection.as_ref(), &effect)?;
        match effect.kind() {
            StartupEffectKind::RecordUserSubmit => {
                let count = card
                    .get("messageCount")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| "terminal card messageCount must be a u64".to_string())?;
                let events = card
                    .get("events")
                    .and_then(Value::as_array)
                    .ok_or_else(|| "terminal card events must be an array".to_string())?;
                let next_count = count
                    .checked_add(1)
                    .ok_or_else(|| "terminal card messageCount overflow".to_string())?;
                let events = super::timeline::project_timeline(&mut projection.applied, events)?;
                card.insert("messageCount".to_string(), Value::from(next_count));
                card.insert("events".to_string(), Value::Array(events));
            }
            StartupEffectKind::BindProviderSession | StartupEffectKind::DiscoverProviderSession => {
                let Some((_, session)) = effect.binding_target() else {
                    return Err("binding effect target is missing".to_string());
                };
                let bound_at = card
                    .get("providerSessionBoundAt")
                    .and_then(Value::as_u64)
                    .unwrap_or(effect.at_ms());
                card.insert("providerSessionId".to_string(), Value::from(session));
                card.insert("providerSessionState".to_string(), Value::from("bound"));
                card.insert("providerSessionBoundAt".to_string(), Value::from(bound_at));
                card.insert(
                    "providerSessionLastResumeAt".to_string(),
                    Value::from(effect.at_ms()),
                );
            }
        }
        card.insert(
            "startupSideEffects".to_string(),
            projection_value(projection)?,
        );
        let encoded = serde_json::to_string(&envelope)
            .map_err(|error| format!("encode terminal startup effect: {error}"))?;
        Ok((Some(encoded), StartupEffectCommitOutcome::Applied))
    })
}
