use super::card_merge::merge_card;
use super::{card_startup_side_effects, envelope_card_arrays, find_card_by_id};
use serde_json::Value;
use std::collections::HashSet;

pub(super) struct SnapshotMerge {
    pub(super) value: String,
    pub(super) reconciled: bool,
}

fn validate_envelope(value: &Value) -> Result<bool, String> {
    let (cards, archived) = envelope_card_arrays(value)?;
    let mut ids = HashSet::new();
    let mut has_projection = false;
    for card in cards.iter().chain(archived.iter()) {
        let id = card
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "card id must be a non-empty string".to_string())?;
        if !ids.insert(id) {
            return Err("card ids must be globally unique".to_string());
        }
        if card_startup_side_effects(card)?.is_some() {
            has_projection = true;
        }
    }
    Ok(has_projection)
}

pub(super) fn parse_envelope(raw: &str, label: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|error| format!("{label} Zustand envelope is invalid JSON: {error}"))?;
    validate_envelope(&value)?;
    Ok(value)
}

fn merge_cards(cards: &mut [Value], current: Option<&Value>) -> Result<(), String> {
    for card in cards {
        let id = card
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "card id must be a non-empty string".to_string())?;
        let current_card = match current {
            Some(envelope) => find_card_by_id(envelope, id)?,
            None => None,
        };
        *card = merge_card(current_card, card)?;
    }
    Ok(())
}

pub(super) fn merge_snapshot(
    current: Option<&str>,
    incoming: &str,
) -> Result<SnapshotMerge, String> {
    let incoming_value = parse_envelope(incoming, "incoming")?;
    let current_value = current
        .map(|raw| parse_envelope(raw, "current"))
        .transpose()?;
    let incoming_has_projection = validate_envelope(&incoming_value)?;
    let current_has_projection = match current_value.as_ref() {
        Some(value) => validate_envelope(value)?,
        None => false,
    };
    if !incoming_has_projection && !current_has_projection {
        return Ok(SnapshotMerge {
            value: incoming.to_string(),
            reconciled: false,
        });
    }

    let mut output_value = incoming_value.clone();
    {
        let root = output_value
            .as_object_mut()
            .ok_or_else(|| "Zustand envelope must be an object".to_string())?;
        let state = root
            .get_mut("state")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "Zustand envelope.state must be an object".to_string())?;
        let cards = state
            .get_mut("cards")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "Zustand envelope.state.cards must be an array".to_string())?;
        merge_cards(cards, current_value.as_ref())?;
        if let Some(archived) = state.get_mut("archivedCards") {
            let archived = archived.as_array_mut().ok_or_else(|| {
                "Zustand envelope.state.archivedCards must be an array".to_string()
            })?;
            merge_cards(archived, current_value.as_ref())?;
        }
    }
    if output_value == incoming_value {
        return Ok(SnapshotMerge {
            value: incoming.to_string(),
            reconciled: false,
        });
    }
    let value = serde_json::to_string(&output_value)
        .map_err(|error| format!("encode reconciled Zustand envelope: {error}"))?;
    Ok(SnapshotMerge {
        value,
        reconciled: true,
    })
}
