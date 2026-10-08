//! Validation and display summaries for questions sharing the approval lifecycle.
use crate::providers::ProviderError;
use serde_json::{json, Map, Value};

fn invalid(message: &str) -> ProviderError {
    ProviderError::new("answer_invalid", message)
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

pub(crate) fn answer_summary(data: &Value, response: &Value) -> Value {
    let mut summary = Map::new();
    if let Some(values) = response["values"].as_object() {
        for (id, value) in values {
            let text = if let Some(values) = value.as_array() {
                values.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")
            } else if let Some(value) = value.as_str() { value.to_owned() }
            else { value.to_string() };
            summary.insert(id.clone(), json!(text));
        }
    }
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
}
