//! Schema-only tests for the additive terminal startup projection.
//!
//! This module is test-wired until the merge/IPC slice is added.  Keeping the
//! model here first gives the later store code one strict parser to reuse.

use serde::{Deserialize, Serialize};
use serde_json::Value;

const STARTUP_EFFECT_SCHEMA: u8 = 1;

#[cfg(test)]
mod bound_session_tests;
mod card_merge;
#[cfg(test)]
mod card_merge_reconfigure_tests;
#[cfg(test)]
mod card_merge_tests;
#[allow(dead_code)]
mod commit;
#[allow(dead_code)]
mod commit_binding;
#[cfg(test)]
mod commit_binding_tests;
#[cfg(test)]
mod commit_concurrency_tests;
#[cfg(test)]
mod commit_submit_tests;
#[allow(dead_code)]
mod commit_target;
#[cfg(test)]
mod commit_test_support;
#[allow(dead_code)]
mod effect;
#[cfg(test)]
mod effect_tests;
mod envelope_merge;
#[cfg(test)]
mod envelope_merge_tests;
mod projection;
mod snapshot_merge;
mod store;
#[cfg(test)]
mod store_tests;
mod timeline;
#[cfg(test)]
mod timeline_tests;

#[allow(unused_imports)]
pub(crate) use effect::{StartupEffectCommit, StartupEffectCommitOutcome};
pub(crate) use store::{TerminalSnapshotMergeOutcome, TerminalStartupEffectStore};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartupSideEffects {
    schema: u8,
    projection_epoch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_projection_epoch: Option<String>,
    applied: Vec<StartupEffectRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartupEffectRecord {
    token: String,
    kind: StartupEffectKind,
    at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    timeline: Option<StartupTimelineState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    binding: Option<StartupBindingState>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum StartupEffectKind {
    RecordUserSubmit,
    BindProviderSession,
    DiscoverProviderSession,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum StartupTimelineState {
    Present,
    Retired,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum StartupBindingState {
    Active,
    Retired,
}

fn is_lower_hex_32(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_token(value: &str, field: &str) -> Result<(), String> {
    if is_lower_hex_32(value) {
        Ok(())
    } else {
        Err(format!("{field} must be 32 lowercase hex characters"))
    }
}

impl StartupSideEffects {
    fn validate(&self) -> Result<(), String> {
        if self.schema != STARTUP_EFFECT_SCHEMA {
            return Err(format!(
                "startupSideEffects schema must be {STARTUP_EFFECT_SCHEMA}"
            ));
        }
        validate_token(&self.projection_epoch, "projectionEpoch")?;
        if let Some(parent) = &self.parent_projection_epoch {
            validate_token(parent, "parentProjectionEpoch")?;
        }

        let mut tokens = std::collections::HashSet::new();
        for record in &self.applied {
            validate_token(&record.token, "startup effect token")?;
            if !tokens.insert(record.token.as_str()) {
                return Err(format!("duplicate startup effect token {}", record.token));
            }
            match record.kind {
                StartupEffectKind::RecordUserSubmit => {
                    if record.timeline.is_none() || record.binding.is_some() {
                        return Err(
                            "recordUserSubmit requires timeline and forbids binding".to_string()
                        );
                    }
                }
                StartupEffectKind::BindProviderSession
                | StartupEffectKind::DiscoverProviderSession => {
                    if record.binding.is_none() || record.timeline.is_some() {
                        return Err(
                            "provider binding effects require binding and forbid timeline"
                                .to_string(),
                        );
                    }
                }
            }
        }
        Ok(())
    }
}

fn parse_startup_side_effects(value: &Value) -> Result<StartupSideEffects, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "startupSideEffects must be an object".to_string())?;
    if matches!(object.get("parentProjectionEpoch"), Some(Value::Null)) {
        return Err("parentProjectionEpoch must be omitted or a token".to_string());
    }
    let parsed: StartupSideEffects = serde_json::from_value(value.clone())
        .map_err(|error| format!("invalid startupSideEffects: {error}"))?;
    parsed.validate()?;
    Ok(parsed)
}

fn envelope_card_arrays(value: &Value) -> Result<(&[Value], &[Value]), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "Zustand envelope must be an object".to_string())?;
    let state = root
        .get("state")
        .and_then(Value::as_object)
        .ok_or_else(|| "Zustand envelope.state must be an object".to_string())?;
    let cards = state
        .get("cards")
        .and_then(Value::as_array)
        .ok_or_else(|| "Zustand envelope.state.cards must be an array".to_string())?;
    let archived = match state.get("archivedCards") {
        None => &[] as &[Value],
        Some(value) => value
            .as_array()
            .map(Vec::as_slice)
            .ok_or_else(|| "Zustand envelope.state.archivedCards must be an array".to_string())?,
    };
    validate_card_array(cards, "state.cards")?;
    validate_card_array(archived, "state.archivedCards")?;
    Ok((cards, archived))
}

fn validate_card_array(cards: &[Value], field: &str) -> Result<(), String> {
    for (index, card) in cards.iter().enumerate() {
        let object = card
            .as_object()
            .ok_or_else(|| format!("{field}[{index}] must be an object"))?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{field}[{index}].id must be a string"))?;
        if id.is_empty() {
            return Err(format!("{field}[{index}].id must not be empty"));
        }
    }
    Ok(())
}

fn find_card_by_id<'a>(envelope: &'a Value, card_id: &str) -> Result<Option<&'a Value>, String> {
    if card_id.is_empty() {
        return Err("card id must not be empty".to_string());
    }
    let (cards, archived) = envelope_card_arrays(envelope)?;
    let mut found = None;
    for card in cards.iter().chain(archived.iter()) {
        if card.get("id").and_then(Value::as_str) != Some(card_id) {
            continue;
        }
        if found.is_some() {
            return Err(format!(
                "card id {card_id} appears in active and archived cards"
            ));
        }
        found = Some(card);
    }
    Ok(found)
}

fn card_startup_side_effects(card: &Value) -> Result<Option<StartupSideEffects>, String> {
    let object = card
        .as_object()
        .ok_or_else(|| "terminal card must be an object".to_string())?;
    match object.get("startupSideEffects") {
        None => Ok(None),
        Some(Value::Null) => Err("startupSideEffects must be omitted or an object".to_string()),
        Some(value) => parse_startup_side_effects(value).map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn token(number: u8) -> String {
        format!("{number:032x}")
    }

    fn submit_record(token: &str, timeline: &str) -> Value {
        json!({
            "token": token,
            "kind": "recordUserSubmit",
            "at": 100,
            "timeline": timeline,
        })
    }

    fn binding_record(token: &str, kind: &str, binding: &str) -> Value {
        json!({
            "token": token,
            "kind": kind,
            "at": 100,
            "binding": binding,
        })
    }

    fn startup(applied: Vec<Value>) -> Value {
        json!({
            "schema": 1,
            "projectionEpoch": token(1),
            "applied": applied,
        })
    }

    #[test]
    fn parses_valid_schema_and_all_supported_kinds() {
        let value = startup(vec![
            submit_record(&token(2), "present"),
            binding_record(&token(3), "bindProviderSession", "active"),
            binding_record(&token(4), "discoverProviderSession", "retired"),
        ]);
        let parsed = parse_startup_side_effects(&value).expect("valid startup projection");
        assert_eq!(parsed.schema, STARTUP_EFFECT_SCHEMA);
        assert_eq!(parsed.projection_epoch, token(1));
        assert_eq!(parsed.applied.len(), 3);
        assert_eq!(parsed.applied[0].at, 100);
        assert_eq!(parsed.applied[1].at, 100);
        assert_eq!(parsed.applied[2].at, 100);
        assert_eq!(
            parsed.applied[0].timeline,
            Some(StartupTimelineState::Present)
        );
        assert_eq!(parsed.applied[1].binding, Some(StartupBindingState::Active));
        assert_eq!(
            parsed.applied[2].binding,
            Some(StartupBindingState::Retired)
        );
    }

    #[test]
    fn rejects_missing_negative_and_string_record_at() {
        let missing = json!({
            "schema": 1,
            "projectionEpoch": token(1),
            "applied": [{
                "token": token(2),
                "kind": "recordUserSubmit",
                "timeline": "present",
            }],
        });
        let negative = json!({
            "schema": 1,
            "projectionEpoch": token(1),
            "applied": [{
                "token": token(2),
                "kind": "recordUserSubmit",
                "at": -1,
                "timeline": "present",
            }],
        });
        let string = json!({
            "schema": 1,
            "projectionEpoch": token(1),
            "applied": [{
                "token": token(2),
                "kind": "recordUserSubmit",
                "at": "100",
                "timeline": "present",
            }],
        });
        assert!(parse_startup_side_effects(&missing).is_err());
        assert!(parse_startup_side_effects(&negative).is_err());
        assert!(parse_startup_side_effects(&string).is_err());
    }

    #[test]
    fn rejects_invalid_tokens_epochs_kinds_statuses_and_unknown_fields() {
        let cases = vec![
            json!({
                "schema": 1,
                "projectionEpoch": "short",
                "applied": [],
            }),
            json!({
                "schema": 1,
                "projectionEpoch": "0000000000000000000000000000000A",
                "applied": [],
            }),
            json!({
                "schema": 1,
                "projectionEpoch": token(1),
                "applied": [submit_record("short", "present")],
            }),
            json!({
                "schema": 1,
                "projectionEpoch": token(1),
                "applied": [{
                    "token": token(2),
                    "kind": "unknown",
                    "at": 100,
                    "timeline": "present",
                }],
            }),
            json!({
                "schema": 1,
                "projectionEpoch": token(1),
                "applied": [submit_record(&token(2), "active")],
            }),
            json!({
                "schema": 1,
                "projectionEpoch": token(1),
                "applied": [binding_record(&token(2), "bindProviderSession", "present")],
            }),
            json!({
                "schema": 1,
                "projectionEpoch": token(1),
                "applied": [{
                    "token": token(2),
                    "kind": "recordUserSubmit",
                    "at": 100,
                    "binding": "active",
                }],
            }),
            json!({
                "schema": 1,
                "projectionEpoch": token(1),
                "applied": [{
                    "token": token(2),
                    "kind": "bindProviderSession",
                    "at": 100,
                    "timeline": "present",
                }],
            }),
            json!({
                "schema": 1,
                "projectionEpoch": token(1),
                "applied": [submit_record(&token(2), "present")],
                "command": "must-not-persist",
            }),
            json!({
                "schema": 1,
                "projectionEpoch": token(1),
                "applied": [{
                    "token": token(2),
                    "kind": "bindProviderSession",
                    "at": 100,
                    "binding": "active",
                    "providerSessionId": "forbidden",
                }],
            }),
        ];
        for value in cases {
            assert!(parse_startup_side_effects(&value).is_err(), "{value}");
        }
    }

    #[test]
    fn rejects_wrong_schema_null_parent_and_duplicate_tokens() {
        let wrong_schema = json!({
            "schema": 2,
            "projectionEpoch": token(1),
            "applied": [],
        });
        assert!(parse_startup_side_effects(&wrong_schema).is_err());

        let null_parent = json!({
            "schema": 1,
            "projectionEpoch": token(1),
            "parentProjectionEpoch": null,
            "applied": [],
        });
        assert!(parse_startup_side_effects(&null_parent).is_err());

        let duplicate = startup(vec![
            submit_record(&token(2), "present"),
            submit_record(&token(2), "retired"),
        ]);
        assert!(parse_startup_side_effects(&duplicate).is_err());
    }

    #[test]
    fn finds_active_and_archived_cards_by_id_without_mutating_envelope() {
        let envelope = json!({
            "state": {
                "cards": [{"id": "active", "messageCount": 1}],
                "archivedCards": [{"id": "archived", "messageCount": 2}],
            },
            "version": 22,
        });
        let before = envelope.clone();
        assert_eq!(
            find_card_by_id(&envelope, "active")
                .expect("active lookup")
                .expect("active card")["id"],
            "active"
        );
        assert_eq!(
            find_card_by_id(&envelope, "archived")
                .expect("archived lookup")
                .expect("archived card")["id"],
            "archived"
        );
        assert_eq!(
            find_card_by_id(&envelope, "missing").expect("missing lookup"),
            None
        );
        assert_eq!(envelope, before);
    }

    #[test]
    fn rejects_malformed_envelopes_and_duplicate_card_locations() {
        for envelope in [
            json!(null),
            json!({}),
            json!({"state": {}}),
            json!({"state": {"cards": {}}}),
            json!({"state": {"cards": [{}]}}),
            json!({"state": {"cards": [{"id": "a"}], "archivedCards": {}}}),
        ] {
            assert!(find_card_by_id(&envelope, "a").is_err(), "{envelope}");
        }
        let duplicate = json!({
            "state": {
                "cards": [{"id": "same"}],
                "archivedCards": [{"id": "same"}],
            },
        });
        assert!(find_card_by_id(&duplicate, "same").is_err());
    }

    #[test]
    fn legacy_card_without_startup_side_effects_is_none() {
        let card = json!({"id": "legacy", "ptyId": "legacy"});
        assert_eq!(
            card_startup_side_effects(&card).expect("legacy card parse"),
            None
        );
    }
}
