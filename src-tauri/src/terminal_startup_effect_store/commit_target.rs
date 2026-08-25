use serde_json::{Map, Value};

pub(super) fn card_at_mut<'a>(
    value: &'a mut Value,
    card_id: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    let (field, index) = {
        let state = value
            .get("state")
            .and_then(Value::as_object)
            .ok_or_else(|| "Zustand envelope.state must be an object".to_string())?;
        let mut found = None;
        for field in ["cards", "archivedCards"] {
            let Some(cards) = state.get(field).and_then(Value::as_array) else {
                continue;
            };
            if let Some(index) = cards
                .iter()
                .position(|card| card.get("id").and_then(Value::as_str) == Some(card_id))
            {
                found = Some((field, index));
                break;
            }
        }
        found.ok_or_else(|| "target terminal card disappeared".to_string())?
    };
    let state = value
        .get_mut("state")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Zustand envelope.state must be an object".to_string())?;
    state
        .get_mut(field)
        .and_then(Value::as_array_mut)
        .and_then(|cards| cards.get_mut(index))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "terminal card must be an object".to_string())
}

pub(super) fn effective_pty(card: &Value) -> Result<String, String> {
    let object = card
        .as_object()
        .ok_or_else(|| "terminal card must be an object".to_string())?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "terminal card id must be a non-empty string".to_string())?;
    match object.get("ptyId") {
        None => Ok(id.to_string()),
        Some(Value::String(pty_id)) if !pty_id.is_empty() => Ok(pty_id.clone()),
        Some(_) => Err("terminal card ptyId must be a non-empty string".to_string()),
    }
}
