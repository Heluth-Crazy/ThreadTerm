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
        "mcpServer/elicitation/request" | "item/tool/requestUserInput" => {
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
        "mcpServer/elicitation/request" | "item/tool/requestUserInput" => Err(ProviderError::new(
            "approval_unsupported",
            "Codex questions must be answered with chat.answer",
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
        "interaction": "permission",
        "submittable": submittable
    })
}

/// Maps the two Codex server request families that collect user input into
/// ThreadTerm's shared question-card contract.  The stored native params are
/// deliberately retained by the adapter, so `codex_answer` can reconstruct
/// the exact app-server response without trusting renderer-supplied metadata.
pub fn codex_question_payload(method: &str, params: &Value) -> Value {
    let mut payload = match method {
        "item/tool/requestUserInput" => {
            let questions = params
                .get("questions")
                .and_then(Value::as_array)
                .map(|questions| {
                    questions
                        .iter()
                        .filter_map(|question| {
                            let id = question.get("id").and_then(Value::as_str)?;
                            let text = question.get("question").and_then(Value::as_str)?;
                            let options = question
                                .get("options")
                                .and_then(Value::as_array)
                                .map(|options| {
                                    options
                                        .iter()
                                        .filter_map(|option| {
                                            Some(json!({
                                                "label": option.get("label")?.as_str()?,
                                                "description": option.get("description").and_then(Value::as_str),
                                            }))
                                        })
                                        .collect::<Vec<_>>()
                                })
                                .unwrap_or_default();
                            let allow_other = question
                                .get("isOther")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                                || options.is_empty();
                            Some(json!({
                                "id": id,
                                "header": question.get("header").and_then(Value::as_str),
                                "question": text,
                                "options": options,
                                "multiSelect": false,
                                "allowOther": allow_other,
                                "secret": question.get("isSecret").and_then(Value::as_bool).unwrap_or(false),
                            }))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            json!({
                "interaction":"question",
                "form":{"kind":"questions","questions":questions},
                "answerable":true,
                "isBlocking":params.get("isBlocking").and_then(Value::as_bool).unwrap_or(true),
                "autoResolutionMs":params.get("autoResolutionMs").cloned().unwrap_or(Value::Null),
            })
        }
        "mcpServer/elicitation/request" => codex_elicitation_payload(params),
        _ => json!({"interaction":"question","answerable":false}),
    };
    omit_null_optional_fields(&mut payload);
    payload
}

pub fn codex_answer(method: &str, params: &Value, response: &Value) -> Result<Value, ProviderError> {
    let action = response.get("action").and_then(Value::as_str).ok_or_else(|| {
        ProviderError::new("answer_invalid", "question response has no action")
    })?;
    match (method, action) {
        ("item/tool/requestUserInput", "dismiss") => Ok(json!({"answers":{}})),
        ("item/tool/requestUserInput", "submit") => {
            let values = response.get("values").and_then(Value::as_object).ok_or_else(|| {
                ProviderError::new("answer_invalid", "question response has no values")
            })?;
            let answers = values.iter().map(|(id, value)| {
                let selected = value.as_array().cloned().unwrap_or_default();
                (id.clone(), json!({"answers":selected}))
            }).collect::<serde_json::Map<_, _>>();
            Ok(json!({"answers":answers}))
        }
        ("mcpServer/elicitation/request", "dismiss") => Ok(json!({"action":"decline"})),
        ("mcpServer/elicitation/request", "submit") => {
            let mode = params.get("mode").and_then(Value::as_str);
            if mode == Some("url") {
                Ok(json!({"action":"accept"}))
            } else {
                Ok(json!({"action":"accept","content":response.get("values").cloned().unwrap_or_else(|| json!({}))}))
            }
        }
        _ => Err(ProviderError::new("answer_invalid", "unsupported Codex question response")),
    }
}

fn codex_elicitation_payload(params: &Value) -> Value {
    let mode = params.get("mode").and_then(Value::as_str);
    let message = params.get("message").and_then(Value::as_str).unwrap_or_default();
    if mode == Some("url") {
        return json!({
            "interaction":"question", "answerable": params.get("url").and_then(Value::as_str).is_some(),
            "form":{"kind":"url","message":message,"url":params.get("url").and_then(Value::as_str).unwrap_or_default()}
        });
    }
    let supported_mode = matches!(mode, Some("form" | "openai/form" | "openaiForm"));
    let schema = params.get("requestedSchema");
    if !supported_mode
        || schema.and_then(Value::as_object).is_none()
        || schema.and_then(|value| value.get("type")).and_then(Value::as_str) != Some("object")
    {
        return json!({"interaction":"question","answerable":false,"form":{"kind":"form","message":message,"fields":[]}});
    }
    let required_values = match schema.and_then(|value| value.get("required")) {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(values)) => match values.iter().map(Value::as_str).collect::<Option<Vec<_>>>() {
            Some(values) => values,
            None => return json!({"interaction":"question","answerable":false,"form":{"kind":"form","message":message,"fields":[]}}),
        },
        Some(_) => return json!({"interaction":"question","answerable":false,"form":{"kind":"form","message":message,"fields":[]}}),
    };
    let required = required_values.iter().copied().collect::<std::collections::HashSet<_>>();
    let Some(properties) = params.pointer("/requestedSchema/properties").and_then(Value::as_object) else {
        return json!({"interaction":"question","answerable":false,"form":{"kind":"form","message":message,"fields":[]}});
    };
    let mut answerable = !required.iter().any(|id| !properties.contains_key(*id));
    let fields = properties.iter().filter_map(|(id, schema)| {
        let field = codex_form_field(id, schema, required.contains(id.as_str()));
        if field.is_none() { answerable = false; }
        field
    }).collect::<Vec<_>>();
    json!({"interaction":"question","answerable":answerable,"form":{"kind":"form","message":message,"fields":fields}})
}

fn omit_null_optional_fields(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.retain(|_, value| !value.is_null());
            for value in object.values_mut() {
                omit_null_optional_fields(value);
            }
        }
        Value::Array(values) => {
            for value in values {
                omit_null_optional_fields(value);
            }
        }
        _ => {}
    }
}

fn codex_form_field(id: &str, schema: &Value, required: bool) -> Option<Value> {
    let source_type = schema.get("type").and_then(Value::as_str)?;
    if has_unsupported_schema_keywords(schema, source_type) {
        return None;
    }
    let mut field = json!({
        "id":id, "title":schema.get("title").and_then(Value::as_str),
        "description":schema.get("description").and_then(Value::as_str), "required":required,
        "default":schema.get("default").cloned().unwrap_or(Value::Null),
        "minimum":schema.get("minimum").cloned().unwrap_or(Value::Null),
        "maximum":schema.get("maximum").cloned().unwrap_or(Value::Null),
        "minLength":schema.get("minLength").cloned().unwrap_or(Value::Null),
        "maxLength":schema.get("maxLength").cloned().unwrap_or(Value::Null),
        "format":schema.get("format").cloned().unwrap_or(Value::Null),
        "minItems":schema.get("minItems").cloned().unwrap_or(Value::Null),
        "maxItems":schema.get("maxItems").cloned().unwrap_or(Value::Null),
    });
    match source_type {
        "string" => {
            if let Some(raw_options) = schema.get("oneOf").or_else(|| schema.get("enum")) {
                let mut options = codex_options(raw_options)?;
                if raw_options == schema.get("enum").unwrap_or(&Value::Null) {
                    if let Some(names) = schema.get("enumNames").and_then(Value::as_array) {
                        if names.len() != options.len() { return None; }
                        for (option, name) in options.iter_mut().zip(names) {
                            *option.get_mut("label")? = Value::String(name.as_str()?.to_owned());
                        }
                    }
                }
                field["type"] = json!("enum");
                field["options"] = json!(options);
            } else {
                field["type"] = json!("string");
            }
        }
        "number" | "integer" | "boolean" => field["type"] = json!(source_type),
        "array" => {
            let options = codex_options(
                schema
                    .pointer("/items/anyOf")
                    .or_else(|| schema.pointer("/items/enum"))?,
            )?;
            field["type"] = json!("multiEnum"); field["options"] = json!(options);
        }
        _ => return None,
    }
    Some(field)
}

fn has_unsupported_schema_keywords(schema: &Value, source_type: &str) -> bool {
    let allowed: &[&str] = match source_type {
        "string" => &["type", "title", "description", "default", "enum", "enumNames", "oneOf", "minLength", "maxLength", "format"],
        "number" | "integer" => &["type", "title", "description", "default", "minimum", "maximum"],
        "boolean" => &["type", "title", "description", "default"],
        "array" => &["type", "title", "description", "default", "items", "minItems", "maxItems"],
        _ => return true,
    };
    schema.as_object().is_none_or(|object| object.keys().any(|key| !allowed.contains(&key.as_str())))
}

fn codex_options(value: &Value) -> Option<Vec<Value>> {
    match value {
        Value::Array(values) => values.iter().map(|value| match value {
            Value::String(value) => Some(json!({"value":value,"label":value})),
            Value::Object(value) => Some(json!({"value":value.get("const")?.as_str()?,"label":value.get("title").and_then(Value::as_str).unwrap_or(value.get("const")?.as_str()?)})),
            _ => None,
        }).collect(),
        _ => None,
    }
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
    fn codex_question_mapping_handles_null_options_and_native_responses() {
        let payload = codex_question_payload("item/tool/requestUserInput", &json!({
            "isBlocking":false,"autoResolutionMs":1000,
            "questions":[{"id":"q0","header":"Pick","question":"Which?","options":null,"isSecret":true}]
        }));
        assert_eq!(payload["interaction"], "question");
        assert_eq!(payload["form"]["questions"][0]["options"], json!([]));
        assert_eq!(payload["form"]["questions"][0]["allowOther"], true);
        assert_eq!(payload["form"]["questions"][0]["secret"], true);
        assert_eq!(payload["isBlocking"], false);
        assert_eq!(codex_answer("item/tool/requestUserInput", &json!({}), &json!({"action":"submit","values":{"q0":["x"]}})).unwrap(), json!({"answers":{"q0":{"answers":["x"]}}}));
        assert_eq!(codex_answer("item/tool/requestUserInput", &json!({}), &json!({"action":"dismiss"})).unwrap(), json!({"answers":{}}));
    }

    #[test]
    fn codex_elicitation_maps_form_and_rejects_unrepresentable_schema() {
        let params = json!({"mode":"form","message":"Configure","requestedSchema":{"type":"object","required":["name"],"properties":{"name":{"type":"string","minLength":2,"maxLength":8,"format":"email"},"count":{"type":"integer","minimum":1,"maximum":3},"enabled":{"type":"boolean"},"colour":{"type":"string","oneOf":[{"const":"blue","title":"Blue"}]},"tags":{"type":"array","items":{"enum":["one","two"]},"minItems":1,"maxItems":2}}}});
        let payload = codex_question_payload("mcpServer/elicitation/request", &params);
        assert_eq!(payload["answerable"], true);
        let fields = payload.pointer("/form/fields").and_then(Value::as_array).unwrap();
        assert_eq!(fields.iter().find(|field| field["id"] == "colour").unwrap()["type"], "enum");
        assert_eq!(fields.iter().find(|field| field["id"] == "tags").unwrap()["type"], "multiEnum");
        for mode in ["openai/form", "openaiForm"] {
            let mut alias = params.clone();
            alias["mode"] = json!(mode);
            assert_eq!(codex_question_payload("mcpServer/elicitation/request", &alias)["answerable"], true);
        }
        assert_eq!(codex_answer("mcpServer/elicitation/request", &params, &json!({"action":"submit","values":{"name":"x"}})).unwrap(), json!({"action":"accept","content":{"name":"x"}}));
        let unsupported = codex_question_payload("mcpServer/elicitation/request", &json!({"mode":"form","message":"x","requestedSchema":{"type":"object","properties":{"nested":{"type":"object"}}}}));
        assert_eq!(unsupported["answerable"], false);
        let vendor_malformed = codex_question_payload("mcpServer/elicitation/request", &json!({"mode":"openai/form","message":"x","requestedSchema":{"properties":{}}}));
        assert_eq!(vendor_malformed["answerable"], false);
        assert_eq!(codex_answer("mcpServer/elicitation/request", &params, &json!({"action":"dismiss"})).unwrap(), json!({"action":"decline"}));
        assert_eq!(codex_answer("mcpServer/elicitation/request", &json!({"mode":"url"}), &json!({"action":"submit","values":{}})).unwrap(), json!({"action":"accept"}));
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
