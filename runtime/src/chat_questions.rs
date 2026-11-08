//! Validation and display summaries for questions sharing the approval lifecycle.
use crate::providers::ProviderError;
use serde_json::{json, Map, Value};
mod opencode_v2;

fn invalid(message: &str) -> ProviderError {
    ProviderError::new("answer_invalid", message)
}

/// Adapter boundary for the 2.2.5 form contract: map a native `Info` onto the
/// stored canonical form that cards, validation and summaries all share. Native
/// identities stay in the adapter; the returned payload carries none.
pub(crate) fn canonical_form(native: &Value) -> Result<Value, ProviderError> {
    opencode_v2::canonical_from_info(native)
}

pub(crate) fn validate_response(data: &Value, response: &Value) -> Result<(), ProviderError> {
    let object = response.as_object().ok_or_else(|| invalid("Expected an answer response"))?;
    if response.get("action").and_then(Value::as_str) == Some("dismiss") {
        return if object.len() == 1 { Ok(()) } else { Err(invalid("Dismiss has no values")) };
    }
    if response.get("action").and_then(Value::as_str) != Some("submit") || object.len() != 2 {
        return Err(invalid("Expected submit or dismiss"));
    }
    if data.get("answerable").and_then(Value::as_bool) != Some(true) {
        return Err(invalid("This request can only be dismissed"));
    }
    let values = response.get("values").and_then(Value::as_object)
        .ok_or_else(|| invalid("Expected answer values"))?;
    let form = &data["form"];
    match form.get("kind").and_then(Value::as_str) {
        Some("url") if values.is_empty() => Ok(()),
        Some("questions") => {
            let questions = form["questions"].as_array().ok_or_else(|| invalid("Invalid questions"))?;
            known_ids(questions, values)?;
            for question in questions {
                let id = question["id"].as_str().ok_or_else(|| invalid("Invalid question id"))?;
                let answers = values.get(id).and_then(Value::as_array)
                    .filter(|answers| !answers.is_empty()).ok_or_else(|| invalid("Answer each question"))?;
                if question["multiSelect"] != true && answers.len() > 1 {
                    return Err(invalid("Choose one answer"));
                }
                let options = question["options"].as_array().ok_or_else(|| invalid("Invalid options"))?;
                let mut unique = std::collections::HashSet::new();
                for answer in answers {
                    let label = answer.as_str().filter(|s| !s.trim().is_empty())
                        .ok_or_else(|| invalid("Expected a nonempty answer label"))?;
                    if !unique.insert(label) { return Err(invalid("Duplicate answer")); }
                    if question["allowOther"] != true && !options.iter().any(|option| option["label"] == label) {
                        return Err(invalid("Answer label was not offered"));
                    }
                }
            }
            Ok(())
        }
        Some("form") => {
            // Select semantics only from the stored approval, never the answer.
            // Unknown policies fail explicitly instead of loosening legacy checks.
            if form.get("validation").is_some() {
                return opencode_v2::validate(form, values);
            }
            let fields = form["fields"].as_array().ok_or_else(|| invalid("Invalid form"))?;
            known_ids(fields, values)?;
            for field in fields {
                let id = field["id"].as_str().ok_or_else(|| invalid("Invalid field id"))?;
                let Some(value) = values.get(id) else {
                    if field["required"] == true { return Err(invalid("Required field is missing")); }
                    continue;
                };
                validate_field(field, value)?;
            }
            Ok(())
        }
        _ => Err(invalid("Unsupported answer form")),
    }
}

fn known_ids(fields: &[Value], values: &Map<String, Value>) -> Result<(), ProviderError> {
    if values.keys().any(|id| !fields.iter().any(|field| field["id"].as_str() == Some(id))) {
        return Err(invalid("Unknown answer id"));
    }
    Ok(())
}

fn in_bounds(field: &Value, value: f64, min: &str, max: &str) -> bool {
    field[min].as_f64().is_none_or(|bound| value >= bound)
        && field[max].as_f64().is_none_or(|bound| value <= bound)
}

fn validate_field(field: &Value, value: &Value) -> Result<(), ProviderError> {
    let offered = |value: &Value| field["options"].as_array()
        .is_some_and(|options| options.iter().any(|option| &option["value"] == value));
    let valid = match field["type"].as_str() {
        Some("string") => value.as_str().is_some_and(|s| {
            (field["required"] != true || !s.trim().is_empty())
                && in_bounds(field, s.chars().count() as f64, "minLength", "maxLength")
                && (s.is_empty() || valid_format(field["format"].as_str(), s))
        }),
        Some("number" | "integer") => value.as_f64().is_some_and(|n| {
            n.is_finite() && (field["type"] != "integer" || n.fract() == 0.0)
                && in_bounds(field, n, "minimum", "maximum")
        }),
        Some("boolean") => value.is_boolean(),
        Some("enum") => value.is_string() && offered(value),
        Some("multiEnum") => value.as_array().is_some_and(|values| {
            (field["required"] != true || !values.is_empty())
                && in_bounds(field, values.len() as f64, "minItems", "maxItems")
                && values.iter().all(|v| v.is_string() && offered(v))
                && values.iter().enumerate().all(|(i, v)| !values[..i].contains(v))
        }),
        _ => false,
    };
    if valid { Ok(()) } else { Err(invalid("Answer has the wrong type, option or bounds")) }
}

fn valid_format(format: Option<&str>, value: &str) -> bool {
    match format {
        None => true,
        Some("email") => value.split_once('@').is_some_and(|(name, host)| {
            !name.is_empty() && host.contains('.') && !host.starts_with('.') && !host.ends_with('.')
                && !host.contains('@') && !value.chars().any(char::is_whitespace)
        }),
        Some("uri") => reqwest::Url::parse(value).is_ok(),
        Some("date") => chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok(),
        Some("date-time") => chrono::DateTime::parse_from_rfc3339(value).is_ok(),
        _ => false,
    }
}

fn legacy_strings(values: &Map<String, Value>) -> Map<String, Value> {
    values
        .iter()
        .map(|(id, value)| {
            let text = if let Some(values) = value.as_array() {
                values.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")
            } else if let Some(value) = value.as_str() { value.to_owned() }
            else { value.to_string() };
            (id.clone(), json!(text))
        })
        .collect()
}

pub(crate) fn answer_summary(data: &Value, response: &Value) -> Value {
    let summary = response["values"].as_object().map_or_else(Map::new, |values| {
        // Target forms filter on typed values first: activation is decided from
        // the answer, never reconstructed from a displayed string.
        match data.pointer("/form") {
            Some(form) if opencode_v2::target_policy(form) => opencode_v2::typed_summary(form, values),
            _ => legacy_strings(values),
        }
    });
    mask_answer_summary(data, &Value::Object(summary))
}

/// Mask again at the persistence boundary, including externally supplied summaries.
pub(crate) fn mask_answer_summary(data: &Value, summary: &Value) -> Value {
    let fields = match data.pointer("/form/kind").and_then(Value::as_str) {
        Some("questions") => data.pointer("/form/questions"),
        Some("form") => data.pointer("/form/fields"),
        _ => None,
    };
    let mut masked = Map::new();
    if let (Some(fields), Some(summary)) = (fields.and_then(Value::as_array), summary.as_object()) {
        for field in fields {
            if field["hidden"] == true { continue; }
            if let Some(id) = field["id"].as_str() {
                if let Some(value) = summary.get(id).filter(|value| value.is_string()) {
                    masked.insert(id.to_owned(), if field["secret"] == true { json!("••••") } else { value.clone() });
                }
            }
        }
    }
    Value::Object(masked)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summaries_mask_question_and_form_secrets_and_drop_unknown_ids() {
        for (kind, field_key) in [("questions", "questions"), ("form", "fields")] {
            let mut data = json!({"form":{"kind":kind}});
            data["form"][field_key] = json!([{"id":"public"},{"id":"private","secret":true}]);
            let response = json!({"action":"submit","values":{"public":["Red","Blue"],"private":"hunter2","unknown":"omit"}});
            assert_eq!(answer_summary(&data, &response), json!({"public":"Red, Blue","private":"••••"}));
            assert_eq!(mask_answer_summary(&data, &json!({"private":"raw secret"})), json!({"private":"••••"}));
        }
    }

    #[test]
    fn opencode_v2_form_contract_vectors_preserve_native_and_legacy_semantics() {
        let corpus: Value = serde_json::from_str(include_str!("../tests/fixtures/opencode-v2-canonical-forms.json")).unwrap();
        let mut mismatches = Vec::new();
        for row in corpus["vectors"].as_array().unwrap() {
            let data = json!({"answerable":true,"form":row["form"]});
            let response = json!({"action":"submit","values":row["values"]});
            let original = response.clone();
            let actual = validate_response(&data, &response);
            if actual.is_ok() != row["expectedValid"].as_bool().unwrap() {
                mismatches.push(format!("{} expected {}, got {:?}", row["id"], row["expectedValid"], actual));
            }
            assert_eq!(response, original, "validation must not insert defaults, strip keys or coerce values");
            assert!(validate_response(&data, &json!({"action":"dismiss"})).is_ok(), "malformed schemas remain dismissible");
            if let Some(expected) = row.get("activeIds") {
                let fields = opencode_v2::active_fields(&row["form"], row["values"].as_object().unwrap()).unwrap();
                assert_eq!(json!(fields.iter().map(|field| field["id"].as_str().unwrap()).collect::<Vec<_>>()), *expected, "{} active fields", row["id"]);
            }
        }
        assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
    }

    #[test]
    fn hidden_answers_are_omitted_while_secrets_remain_masked_at_both_summary_boundaries() {
        let data = json!({"form":{"kind":"form","fields":[
            {"id":"hidden","type":"string","hidden":true},
            {"id":"secret","type":"string","secret":true},
            {"id":"public","type":"string"}
        ]}});
        let response = json!({"action":"submit","values":{"hidden":"never display","secret":"private","public":"visible"}});
        assert_eq!(answer_summary(&data,&response), json!({"secret":"••••","public":"visible"}));
        assert_eq!(mask_answer_summary(&data,&json!({"hidden":"never display","secret":"private","public":"visible"})), json!({"secret":"••••","public":"visible"}));
    }

    #[test]
    fn caller_answer_metadata_cannot_select_target_form_validation() {
        let data = json!({"answerable":true,"form":{"kind":"form","fields":[{"id":"value","type":"string","required":true}]}});
        let response = json!({"action":"submit","values":{"value":"   "},"validation":{"semantics":"opencode-v2","patternAndFormat":"native"}});
        assert!(validate_response(&data,&response).is_err());
        assert!(validate_response(&data,&json!({"action":"submit","values":{"value":"   "}})).is_err());
    }
}
