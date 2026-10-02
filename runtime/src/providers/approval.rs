//! Shared Chat approval choice mapping.
//!
//! Renderer only submits `choiceId`. Adapters keep the native payload mapping
//! and must never pick the first allow/deny option by array order.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::ProviderError;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalChoice {
    pub choice_id: String,
    pub label: String,
    pub kind: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct PendingApprovalState {
    pub submitting_operation: Option<String>,
    pub outcome_unknown: bool,
}

impl PendingApprovalState {
    pub fn begin_submit(&mut self, operation_id: &str) -> Result<(), ProviderError> {
        if self.outcome_unknown {
            return Err(ProviderError::new(
                "approval_outcome_unknown",
                "the previous approval response may already have been sent",
            ));
        }
        if let Some(existing) = self.submitting_operation.as_deref() {
            if existing == operation_id {
                return Err(ProviderError::new(
                    "approval_duplicate",
                    "this approval operation is already in progress",
                ));
            }
            return Err(ProviderError::new(
                "approval_in_progress",
                "this approval is already being submitted",
            ));
        }
        self.submitting_operation = Some(operation_id.to_owned());
        Ok(())
    }

    pub fn clear_submit(&mut self) {
        self.submitting_operation = None;
    }

    pub fn mark_unknown(&mut self) {
        self.outcome_unknown = true;
        self.submitting_operation = None;
    }
}

pub fn find_choice<'a>(
    choices: &'a [ApprovalChoice],
    choice_id: &str,
) -> Result<&'a ApprovalChoice, ProviderError> {
    choices
        .iter()
        .find(|choice| choice.choice_id == choice_id)
        .ok_or_else(|| {
            ProviderError::new(
                "approval_choice_invalid",
                format!("choice {choice_id} is not valid for this approval"),
            )
        })
}

pub fn acp_choices(options: &[Value]) -> Vec<ApprovalChoice> {
    options
        .iter()
        .filter_map(|option| {
            let choice_id = option.get("optionId").and_then(Value::as_str)?;
            if choice_id.is_empty() {
                return None;
            }
            let kind_raw = option.get("kind").and_then(Value::as_str).unwrap_or("");
            let (kind, scope) = match kind_raw {
                "allow_once" => ("allow", "once"),
                "allow_always" => ("allow", "persistent"),
                "allow" => ("allow", "unknown"),
                "reject_once" => ("deny", "once"),
                "reject_always" => ("deny", "persistent"),
                "deny" | "reject" => ("deny", "unknown"),
                _ => ("other", "unknown"),
            };
            Some(ApprovalChoice {
                choice_id: choice_id.to_owned(),
                label: option
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .unwrap_or(choice_id)
                    .to_owned(),
                kind: kind.to_owned(),
                scope: scope.to_owned(),
                description: option
                    .get("description")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            })
        })
        .collect()
}

pub fn allow_deny_choices() -> Vec<ApprovalChoice> {
    vec![
        ApprovalChoice {
            choice_id: "allow".into(),
            label: "Allow".into(),
            kind: "allow".into(),
            scope: "once".into(),
            description: None,
        },
        ApprovalChoice {
            choice_id: "deny".into(),
            label: "Deny".into(),
            kind: "deny".into(),
            scope: "once".into(),
            description: None,
        },
    ]
}

pub fn map_allow_deny_choice(choice_id: &str) -> Result<&'static str, ProviderError> {
    match choice_id {
        "allow" => Ok("allow"),
        "deny" => Ok("deny"),
        _ => Err(ProviderError::new(
            "approval_choice_invalid",
            format!("{choice_id} is not a supported allow/deny choice"),
        )),
    }
}

pub fn codex_choices(method: &str, params: &Value) -> (Vec<ApprovalChoice>, bool) {
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => (
            vec![
                choice("accept", "Allow once", "allow", "once"),
                choice(
                    "acceptForSession",
                    "Allow for this session",
                    "allow",
                    "session",
                ),
                choice("decline", "Deny", "deny", "once"),
                choice("cancel", "Cancel", "cancel", "once"),
            ],
            true,
        ),
        "execCommandApproval" | "applyPatchApproval" => (
            vec![
                choice("approved", "Allow once", "allow", "once"),
                choice(
                    "approved_for_session",
                    "Allow for this session",
                    "allow",
                    "session",
                ),
                choice("denied", "Deny", "deny", "once"),
                choice("abort", "Cancel", "cancel", "once"),
            ],
            true,
        ),
        "item/permissions/requestApproval" => (
            vec![
                choice("turn", "Allow this turn", "allow", "turn"),
                choice("session", "Allow this session", "allow", "session"),
                choice("deny", "Deny", "deny", "turn"),
            ],
            true,
        ),
        "mcpServer/elicitation/request" => (
            vec![
                choice("accept", "Accept", "allow", "once"),
                choice("decline", "Decline", "deny", "once"),
            ],
            true,
        ),
        "item/tool/requestUserInput" => {
            let _ = params;
            (Vec::new(), false)
        }
        _ => (Vec::new(), false),
    }
}

pub fn codex_response(
    method: &str,
    choice_id: &str,
    params: &Value,
) -> Result<Value, ProviderError> {
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            let decision = match choice_id {
                "accept" => "accept",
                "acceptForSession" => "acceptForSession",
                "decline" => "decline",
                "cancel" => "cancel",
                _ => return invalid_codex(choice_id),
            };
            Ok(json!({"decision": decision}))
        }
        "execCommandApproval" | "applyPatchApproval" => {
            let decision = match choice_id {
                "approved" => json!("approved"),
                "approved_for_session" => json!("approved_for_session"),
                "denied" => json!({"denied":{"rejection":"Denied by user"}}),
                "abort" => json!("abort"),
                _ => return invalid_codex(choice_id),
            };
            Ok(json!({"decision": decision}))
        }
        "item/permissions/requestApproval" => {
            let (permissions, scope) = match choice_id {
                "turn" => (
                    params
                        .get("permissions")
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                    "turn",
                ),
                "session" => (
                    params
                        .get("permissions")
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                    "session",
                ),
                "deny" => (json!({}), "turn"),
                _ => return invalid_codex(choice_id),
            };
            Ok(json!({"permissions": permissions, "scope": scope}))
        }
        "mcpServer/elicitation/request" => {
            let action = match choice_id {
                "accept" => "accept",
                "decline" => "decline",
                _ => return invalid_codex(choice_id),
            };
            Ok(json!({"action": action}))
        }
        "item/tool/requestUserInput" => Err(ProviderError::new(
            "approval_unsupported",
            "Codex user-input requests cannot be answered as permission choices",
        )),
        _ => Err(ProviderError::new(
            "approval_unsupported",
            format!("Codex request {method} cannot be answered with a permission choice"),
        )),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn approval_payload(
    approval_id: &str,
    provider: &str,
    request_type: &str,
    title: &str,
    details: &Value,
    choices: &[ApprovalChoice],
    turn_id: Option<&str>,
    submittable: bool,
) -> Value {
    json!({
        "approvalId": approval_id,
        "provider": provider,
        "requestType": request_type,
        "title": title,
        "details": details,
        "choices": choices,
        "turnId": turn_id,
        "interaction": if request_type == "item/tool/requestUserInput" { "userInput" } else if request_type.contains("elicitation") { "elicitation" } else { "permission" },
        "submittable": submittable
    })
}

pub fn write_failed_not_sent(error: &ProviderError) -> bool {
    matches!(
        error.code.as_str(),
        "provider_protocol" | "provider_internal"
    )
}

fn choice(id: &str, label: &str, kind: &str, scope: &str) -> ApprovalChoice {
    ApprovalChoice {
        choice_id: id.to_owned(),
        label: label.to_owned(),
        kind: kind.to_owned(),
        scope: scope.to_owned(),
        description: None,
    }
}

fn invalid_codex(choice_id: &str) -> Result<Value, ProviderError> {
    Err(ProviderError::new(
        "approval_choice_invalid",
        format!("{choice_id} is not valid for this Codex approval"),
    ))
}

pub fn acp_title(params: &Value) -> String {
    params
        .pointer("/toolCall/title")
        .or_else(|| params.get("title"))
        .or_else(|| params.pointer("/toolCall/kind"))
        .and_then(Value::as_str)
        .unwrap_or("Permission request")
        .to_owned()
}

pub fn validate_turn(
    pending_turn: Option<&str>,
    active_turn: Option<&str>,
    submitted_turn: &str,
) -> Result<(), ProviderError> {
    let Some(active) = active_turn else {
        return Err(ProviderError::new(
            "approval_stale",
            "approval is not bound to a live turn",
        ));
    };
    if active != submitted_turn {
        return Err(ProviderError::new(
            "approval_turn_mismatch",
            "approval belongs to a different turn",
        ));
    }
    if let Some(expected) = pending_turn {
        if expected != submitted_turn {
            return Err(ProviderError::new(
                "approval_turn_mismatch",
                "approval belongs to a different turn",
            ));
        }
    }
    Ok(())
}

/// Codex stores a public turn id on pending cards. The native turn id is a
/// different namespace and must never make a stale public id look live.
pub fn validate_codex_turn(
    pending_public_turn: Option<&str>,
    active_public_turn: Option<&str>,
    active_native_turn: Option<&str>,
    submitted_turn: &str,
) -> Result<(), ProviderError> {
    if active_native_turn.is_some_and(|native| native == submitted_turn)
        && active_public_turn.is_some_and(|public| public != submitted_turn)
    {
        return Err(ProviderError::new(
            "approval_turn_mismatch",
            "Codex native turn id cannot authorize a different public turn",
        ));
    }
    validate_turn(pending_public_turn, active_public_turn, submitted_turn)
}

pub fn drain_inactive_approvals<T>(
    pending: &mut std::collections::HashMap<String, T>,
    turn_of: impl Fn(&T) -> Option<&str>,
    live_turn: Option<&str>,
) -> Vec<String> {
    let mut removed = Vec::new();
    pending.retain(|id, value| {
        let keep = live_turn
            .zip(turn_of(value))
            .is_some_and(|(live, turn)| live == turn);
        if !keep {
            removed.push(id.clone());
        }
        keep
    });
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acp_mapping_is_order_independent() {
        let options = vec![
            json!({"optionId":"always","kind":"allow_always","name":"Always"}),
            json!({"optionId":"once","kind":"allow_once","name":"Once"}),
            json!({"optionId":"reject-always","kind":"reject_always","name":"Reject always"}),
            json!({"optionId":"reject-once","kind":"reject_once","name":"Reject once"}),
        ];
        let choices = acp_choices(&options);
        assert_eq!(choices[0].choice_id, "always");
        assert_eq!(choices[0].scope, "persistent");
        assert_eq!(choices[1].choice_id, "once");
        assert_eq!(choices[1].scope, "once");
        assert_eq!(find_choice(&choices, "once").unwrap().kind, "allow");
        assert_eq!(
            find_choice(&choices, "reject-always").unwrap().scope,
            "persistent"
        );
        assert!(find_choice(&choices, "missing").is_err());
    }

    #[test]
    fn acp_does_not_synthesize_once_when_only_always_exists() {
        let choices =
            acp_choices(&[json!({"optionId":"always","kind":"allow_always","name":"Always"})]);
        assert_eq!(choices.len(), 1);
        assert!(find_choice(&choices, "once").is_err());
        assert_eq!(find_choice(&choices, "always").unwrap().scope, "persistent");
    }

    #[test]
    fn reject_scope_survives_reordering() {
        let choices = acp_choices(&[
            json!({"optionId":"ra","kind":"reject_always"}),
            json!({"optionId":"ro","kind":"reject_once"}),
        ]);
        assert_eq!(find_choice(&choices, "ro").unwrap().scope, "once");
        assert_eq!(find_choice(&choices, "ra").unwrap().scope, "persistent");
    }

    #[test]
    fn unknown_acp_kind_is_other_not_guessed() {
        let choices = acp_choices(&[json!({"optionId":"custom","kind":"allow_session"})]);
        assert_eq!(choices[0].kind, "other");
        assert_eq!(choices[0].scope, "unknown");
    }

    #[test]
    fn codex_command_choices_keep_session_scope_off_once() {
        let (choices, submittable) =
            codex_choices("item/commandExecution/requestApproval", &json!({}));
        assert!(submittable);
        assert_eq!(find_choice(&choices, "accept").unwrap().scope, "once");
        assert_eq!(
            find_choice(&choices, "acceptForSession").unwrap().scope,
            "session"
        );
        let response = codex_response(
            "item/commandExecution/requestApproval",
            "accept",
            &json!({}),
        )
        .unwrap();
        assert_eq!(response["decision"], "accept");
        assert!(
            codex_response(
                "item/commandExecution/requestApproval",
                "acceptForSession",
                &json!({})
            )
            .unwrap()["decision"]
                == "acceptForSession"
        );
    }

    #[test]
    fn codex_user_input_is_not_submittable() {
        let (choices, submittable) =
            codex_choices("item/tool/requestUserInput", &json!({"questions":[]}));
        assert!(choices.is_empty());
        assert!(!submittable);
        assert_eq!(
            codex_response("item/tool/requestUserInput", "allow", &json!({}))
                .unwrap_err()
                .code,
            "approval_unsupported"
        );
    }

    #[test]
    fn pending_submit_is_single_flight_and_unknown_blocks_retry() {
        let mut state = PendingApprovalState::default();
        state.begin_submit("op-1").unwrap();
        assert_eq!(
            state.begin_submit("op-1").unwrap_err().code,
            "approval_duplicate"
        );
        assert_eq!(
            state.begin_submit("op-2").unwrap_err().code,
            "approval_in_progress"
        );
        state.mark_unknown();
        assert_eq!(
            state.begin_submit("op-3").unwrap_err().code,
            "approval_outcome_unknown"
        );
    }

    #[test]
    fn turn_validation_requires_the_active_turn_even_when_pending_matches() {
        assert!(validate_turn(Some("t1"), Some("t1"), "t1").is_ok());
        assert_eq!(
            validate_turn(Some("t1"), None, "t1").unwrap_err().code,
            "approval_stale"
        );
        assert_eq!(
            validate_turn(Some("t1"), Some("t2"), "t1")
                .unwrap_err()
                .code,
            "approval_turn_mismatch"
        );
        assert_eq!(
            validate_turn(Some("t1"), Some("t2"), "t2")
                .unwrap_err()
                .code,
            "approval_turn_mismatch"
        );
        assert_eq!(
            validate_turn(None, None, "t1").unwrap_err().code,
            "approval_stale"
        );
        assert!(validate_turn(None, Some("t1"), "t1").is_ok());
    }

    #[test]
    fn drain_inactive_approvals_drops_ended_and_other_turns() {
        let mut pending = std::collections::HashMap::from([
            ("a1".to_owned(), Some("t1".to_owned())),
            ("a2".to_owned(), Some("t2".to_owned())),
            ("a3".to_owned(), None),
        ]);
        let removed = drain_inactive_approvals(&mut pending, |turn| turn.as_deref(), Some("t1"));
        assert!(removed.contains(&"a2".to_owned()));
        assert!(removed.contains(&"a3".to_owned()));
        assert_eq!(pending.len(), 1);
        let removed = drain_inactive_approvals(&mut pending, |turn| turn.as_deref(), None);
        assert_eq!(removed, vec!["a1".to_owned()]);
        assert!(pending.is_empty());
    }

    #[test]
    fn codex_native_turn_id_does_not_authorize_a_different_public_turn() {
        assert_eq!(
            validate_codex_turn(
                Some("public-1"),
                Some("public-1"),
                Some("native-9"),
                "native-9"
            )
            .unwrap_err()
            .code,
            "approval_turn_mismatch"
        );
        assert!(validate_codex_turn(
            Some("public-1"),
            Some("public-1"),
            Some("native-9"),
            "public-1"
        )
        .is_ok());
    }
}
