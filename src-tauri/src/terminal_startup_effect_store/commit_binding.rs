use super::{envelope_card_arrays, StartupEffectCommit, StartupEffectCommitOutcome};
use serde_json::Value;

fn conflict_outcome(effect: &StartupEffectCommit) -> StartupEffectCommitOutcome {
    if effect.is_discovery() {
        StartupEffectCommitOutcome::Obsolete
    } else {
        StartupEffectCommitOutcome::Conflict
    }
}

pub(super) fn conflict(
    value: &Value,
    target: &Value,
    effect: &StartupEffectCommit,
) -> Result<Option<StartupEffectCommitOutcome>, String> {
    let Some((provider, session)) = effect.binding_target() else {
        return Ok(None);
    };
    let target = target
        .as_object()
        .ok_or_else(|| "terminal card must be an object".to_string())?;
    let terminal_type = target
        .get("terminalType")
        .and_then(Value::as_str)
        .filter(|provider| !provider.is_empty())
        .ok_or_else(|| "terminal card terminalType must be a non-empty string".to_string())?;
    if terminal_type != provider {
        return Ok(Some(conflict_outcome(effect)));
    }
    if let Some(existing) = target.get("providerSessionId") {
        match existing {
            Value::Null => {}
            Value::String(existing) if existing == session => {}
            Value::String(_) => return Ok(Some(conflict_outcome(effect))),
            _ => return Err("providerSessionId must be a string or null".to_string()),
        }
    }
    let (cards, archived) = envelope_card_arrays(value)?;
    for card in cards.iter().chain(archived.iter()) {
        if card.get("id").and_then(Value::as_str) == Some(effect.card_id()) {
            continue;
        }
        let Some(card_session) = card.get("providerSessionId") else {
            continue;
        };
        let Some(card_session) = card_session.as_str() else {
            if card_session.is_null() {
                continue;
            }
            return Err("providerSessionId must be a string or null".to_string());
        };
        if card_session.is_empty() {
            return Err("providerSessionId must not be empty".to_string());
        }
        let card_provider = card
            .get("terminalType")
            .and_then(Value::as_str)
            .filter(|provider| !provider.is_empty())
            .ok_or_else(|| "terminal card terminalType must be a non-empty string".to_string())?;
        if card_provider == provider && card_session == session {
            return Ok(Some(conflict_outcome(effect)));
        }
    }
    Ok(None)
}
