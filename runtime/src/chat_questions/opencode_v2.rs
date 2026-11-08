//! Stored OpenCode 2.2.5 form semantics. This performs local admission checks;
//! only a native reply can adjudicate patterns/formats or settle the request.
use super::{in_bounds, invalid, known_ids};
use crate::providers::ProviderError;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

fn field_error(field: &Value, message: &str) -> ProviderError {
    let mut error = invalid(message);
    error.details = Some(json!({"fieldId":field["id"]}));
    error
}

fn offered(field: &Value, value: &Value) -> bool {
    field["options"].as_array().is_some_and(|options| {
        options
            .iter()
            .any(|option| option.get("value") == Some(value))
    })
}

fn closed(field: &Value) -> bool {
    field["custom"] != true && (field["type"] == "multiselect" || field.get("options").is_some())
}

fn number(value: &Value) -> bool {
    value.as_f64().is_some_and(f64::is_finite)
}

fn strings(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}

fn schema(fields: &[Value]) -> Result<(), ProviderError> {
    if fields.is_empty() {
        return Err(invalid("Form must contain a field"));
    }
    let mut keys = HashSet::new();
    let mut earlier: HashMap<&str, &Value> = HashMap::new();
    for field in fields {
        let object = field
            .as_object()
            .ok_or_else(|| invalid("Invalid stored form field"))?;
        let id = field["id"]
            .as_str()
            .ok_or_else(|| invalid("Invalid stored form field id"))?;
        if !keys.insert(id) {
            return Err(field_error(field, "Duplicate stored form field id"));
        }
        let kind = field["type"]
            .as_str()
            .ok_or_else(|| field_error(field, "Invalid stored form field type"))?;
        if !matches!(
            kind,
            "string" | "number" | "integer" | "boolean" | "multiselect" | "external"
        ) {
            return Err(field_error(field, "Unsupported stored form field type"));
        }
        // No target constraint may silently disappear. The native adapter must
        // explicitly reject a future schema it cannot represent in this policy.
        for key in object.keys().map(String::as_str) {
            let base = matches!(key, "id" | "type" | "title" | "description");
            let input =
                kind != "external" && matches!(key, "required" | "hidden" | "when" | "default");
            let typed = match kind {
                "string" => matches!(
                    key,
                    "options"
                        | "custom"
                        | "minLength"
                        | "maxLength"
                        | "pattern"
                        | "format"
                        | "placeholder"
                ),
                "number" | "integer" => matches!(key, "minimum" | "maximum"),
                "multiselect" => matches!(key, "options" | "custom" | "minItems" | "maxItems"),
                "external" => key == "url",
                _ => false,
            };
            if !base && !input && !typed {
                return Err(field_error(field, "Unsupported stored form field metadata"));
            }
        }
        for key in ["title", "description", "placeholder", "pattern", "url"] {
            if field.get(key).is_some_and(|value| !value.is_string()) {
                return Err(field_error(field, "Invalid stored form text metadata"));
            }
        }
        for key in ["required", "hidden", "custom"] {
            if field.get(key).is_some_and(|value| !value.is_boolean()) {
                return Err(field_error(field, "Invalid stored form boolean metadata"));
            }
        }
        for key in ["minimum", "maximum"] {
            if field.get(key).is_some_and(|value| !number(value)) {
                return Err(field_error(field, "Invalid stored form numeric bound"));
            }
        }
        for key in ["minLength", "maxLength", "minItems", "maxItems"] {
            if field.get(key).is_some_and(|value| {
                value
                    .as_f64()
                    .is_none_or(|n| !n.is_finite() || n < 0.0 || n.fract() != 0.0)
            }) {
                return Err(field_error(field, "Invalid stored form count bound"));
            }
        }
        if field.get("format").is_some_and(|value| {
            !matches!(value.as_str(), Some("email" | "uri" | "date" | "date-time"))
        }) {
            return Err(field_error(field, "Unsupported stored form format"));
        }
        if let Some(options) = field.get("options") {
            if !options.as_array().is_some_and(|options| {
                options.iter().all(|option| {
                    option.is_object()
                        && option
                            .as_object()
                            .expect("checked object")
                            .keys()
                            .all(|key| matches!(key.as_str(), "value" | "label" | "description"))
                        && option["value"].is_string()
                        && option["label"].is_string()
                        && option.get("description").is_none_or(Value::is_string)
                })
            }) {
                return Err(field_error(field, "Invalid stored form options"));
            }
        } else if kind == "multiselect" {
            return Err(field_error(field, "Stored multiselect has no options"));
        }
        if kind == "external" {
            if !field["url"].is_string() {
                return Err(field_error(
                    field,
                    "Stored external field has no destination",
                ));
            }
            // Native URLs are strings; opening policy belongs to the existing
            // desktop bridge. Opening never supplies this acknowledgement.
            continue;
        }
        if let Some(default) = field.get("default") {
            let valid = match kind {
                "string" => default.is_string(),
                "number" | "integer" => number(default),
                "boolean" => default.is_boolean(),
                "multiselect" => strings(default),
                _ => false,
            };
            if !valid {
                return Err(field_error(field, "Invalid stored form default type"));
            }
        }
        if let Some(conditions) = field.get("when") {
            let conditions = conditions
                .as_array()
                .ok_or_else(|| field_error(field, "Invalid stored form conditions"))?;
            for condition in conditions {
                if condition.as_object().is_none_or(|object| {
                    object.len() != 3
                        || object
                            .keys()
                            .any(|key| !matches!(key.as_str(), "key" | "op" | "value"))
                }) {
                    return Err(field_error(
                        field,
                        "Unsupported stored form condition metadata",
                    ));
                }
                let target = condition["key"]
                    .as_str()
                    .and_then(|key| earlier.get(key))
                    .ok_or_else(|| {
                        field_error(field, "Condition must reference an earlier input field")
                    })?;
                if !matches!(condition["op"].as_str(), Some("eq" | "neq")) {
                    return Err(field_error(
                        field,
                        "Unsupported stored form condition operation",
                    ));
                }
                let value = &condition["value"];
                let valid = match target["type"].as_str() {
                    Some("boolean") => value.is_boolean(),
                    Some("number" | "integer") => number(value),
                    _ => value.is_string() && (!closed(target) || offered(target, value)),
                };
                if !valid {
                    return Err(field_error(
                        field,
                        "Condition has an invalid type or closed option",
                    ));
                }
            }
        }
        earlier.insert(id, field);
    }
    Ok(())
}

fn matches(condition: &Value, value: Option<&&Value>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let expected = &condition["value"];
    let hit = if let Some(items) = value.as_array() {
        items.iter().any(|item| item == expected)
    } else if let (Some(actual), Some(expected)) = (value.as_f64(), expected.as_f64()) {
        actual == expected
    } else {
        *value == expected
    };
    if condition["op"] == "eq" {
        hit
    } else {
        !hit
    }
}

pub(crate) const POLICY_NAME: &str = "opencode-v2";

fn policy_value() -> Value {
    json!({"semantics":POLICY_NAME,"patternAndFormat":"native"})
}

/// True only for the stored target policy. Unknown policies are not legacy.
pub(super) fn target_policy(form: &Value) -> bool {
    form.get("validation").is_some()
}

/// Map a native 2.2.5 form `Info` onto the stored canonical form.
///
/// Field `key` becomes `id`; order, options/labels/descriptions, custom flags,
/// conditions, hidden/default/placeholder/constraint and external metadata are
/// preserved unchanged. Nothing is initialized, defaulted or reordered here:
/// a schema this policy cannot represent fails explicitly instead of losing
/// semantics.
///
/// The result is the card payload only. The native form id and owning session
/// stay in adapter/approval state beside the approval id, exactly as the 1.18.35
/// path keeps its question/permission identities, so no native identity is
/// duplicated into data that cards and the phone receive.
pub(super) fn canonical_from_info(native: &Value) -> Result<Value, ProviderError> {
    native
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| invalid("Native form has no identity"))?;
    let fields = native["fields"]
        .as_array()
        .ok_or_else(|| invalid("Native form has no fields"))?;
    let mut mapped = Vec::with_capacity(fields.len());
    for field in fields {
        let key = field
            .get("key")
            .and_then(Value::as_str)
            .filter(|key| !key.is_empty())
            .ok_or_else(|| invalid("Native form field has no key"))?;
        let mut canonical = Map::new();
        canonical.insert("id".into(), json!(key));
        for (source, target) in [
            ("type", "type"),
            ("title", "title"),
            ("description", "description"),
            ("placeholder", "placeholder"),
            ("pattern", "pattern"),
            ("format", "format"),
            ("url", "url"),
            ("options", "options"),
            ("custom", "custom"),
            ("hidden", "hidden"),
            ("default", "default"),
            ("when", "when"),
            ("required", "required"),
            ("minLength", "minLength"),
            ("maxLength", "maxLength"),
            ("minimum", "minimum"),
            ("maximum", "maximum"),
            ("minItems", "minItems"),
            ("maxItems", "maxItems"),
        ] {
            if let Some(value) = field.get(source) {
                canonical.insert(target.into(), value.clone());
            }
        }
        // Any other native metadata is a semantics loss we must not hide.
        if let Some(object) = field.as_object() {
            for key in object.keys() {
                if !matches!(key.as_str(), "key" | "type" | "title" | "description"
                    | "placeholder" | "pattern" | "format" | "url" | "options" | "custom"
                    | "hidden" | "default" | "when" | "required" | "minLength" | "maxLength"
                    | "minimum" | "maximum" | "minItems" | "maxItems")
                {
                    return Err(invalid("Native form field metadata cannot be represented"));
                }
            }
        }
        mapped.push(Value::Object(canonical));
    }
    let message = native
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("OpenCode form");
    // Local admission of the mapped schema: unknown types, broken conditions and
    // impossible metadata fail here, before any card or native write exists.
    schema(&mapped)?;
    Ok(json!({
        "kind": "form",
        "message": message,
        "validation": policy_value(),
        "fields": mapped
    }))
}

fn stringify(value: &Value) -> String {
    if let Some(values) = value.as_array() {
        values
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(", ")
    } else if let Some(value) = value.as_str() {
        value.to_owned()
    } else {
        value.to_string()
    }
}

/// Typed conditional filtering that happens BEFORE any string conversion.
///
/// Only active fields that carry an answer survive; hidden fields never do.
/// Activation is decided on typed values, so a displayed multiselect summary is
/// never split to recover a typed answer. Malformed forms yield an empty summary
/// instead of a partial or leaking one.
pub(super) fn typed_summary(
    form: &Value,
    values: &Map<String, Value>,
) -> Map<String, Value> {
    let Ok(active) = active_fields(form, values) else {
        return Map::new();
    };
    let mut summary = Map::new();
    for field in active {
        if field["hidden"] == true {
            continue;
        }
        let Some(id) = field["id"].as_str() else {
            return Map::new();
        };
        if let Some(value) = values.get(id) {
            summary.insert(id.to_owned(), json!(stringify(value)));
        }
    }
    summary
}

/// Only earlier ACTIVE answers can activate successors; inactive drafts never
/// enter this map. Does not mutate answers, insert defaults or validate regexes.
pub(super) fn active_fields<'a>(
    form: &'a Value,
    values: &Map<String, Value>,
) -> Result<Vec<&'a Value>, ProviderError> {
    if form.get("validation")
        != Some(&json!({"semantics":"opencode-v2","patternAndFormat":"native"}))
    {
        return Err(invalid("Unsupported stored form validation policy"));
    }
    let fields = form["fields"]
        .as_array()
        .ok_or_else(|| invalid("Invalid stored form fields"))?;
    schema(fields)?;
    let mut effective = HashMap::new();
    let mut active = Vec::new();
    for field in fields {
        if field.get("when").is_none_or(|conditions| {
            conditions
                .as_array()
                .expect("validated conditions")
                .iter()
                .all(|condition| {
                    matches(
                        condition,
                        effective.get(condition["key"].as_str().expect("validated condition key")),
                    )
                })
        }) {
            let id = field["id"].as_str().expect("validated field id");
            active.push(field);
            if let Some(value) = values.get(id) {
                effective.insert(id, value);
            }
        }
    }
    Ok(active)
}

pub(super) fn validate(form: &Value, values: &Map<String, Value>) -> Result<(), ProviderError> {
    let active = active_fields(form, values)?;
    known_ids(form["fields"].as_array().expect("validated fields"), values)?;
    let active_ids = active
        .iter()
        .map(|field| field["id"].as_str().expect("validated field id"))
        .collect::<HashSet<_>>();
    if values.keys().any(|key| !active_ids.contains(key.as_str())) {
        return Err(invalid("Inactive form fields cannot be answered"));
    }
    for field in active {
        let id = field["id"].as_str().expect("validated field id");
        let value = values.get(id);
        if field["type"] == "external" {
            if value != Some(&Value::Bool(true)) {
                return Err(field_error(field, "External step must be acknowledged"));
            }
            continue;
        }
        let Some(value) = value else {
            if field["required"] == true {
                return Err(field_error(field, "Required field is missing"));
            }
            continue;
        };
        let valid = match field["type"].as_str() {
            Some("string") => value.as_str().is_some_and(|text| {
                (field["required"] != true || !text.is_empty())
                    && in_bounds(
                        field,
                        text.encode_utf16().count() as f64,
                        "minLength",
                        "maxLength",
                    )
                    && (!closed(field) || offered(field, value))
            }),
            Some("number" | "integer") => value.as_f64().is_some_and(|number| {
                number.is_finite()
                    && (field["type"] != "integer" || number.fract() == 0.0)
                    && in_bounds(field, number, "minimum", "maximum")
            }),
            Some("boolean") => value.is_boolean(),
            Some("multiselect") => value.as_array().is_some_and(|items| {
                (field["required"] != true || !items.is_empty())
                    && in_bounds(field, items.len() as f64, "minItems", "maxItems")
                    && items
                        .iter()
                        .all(|item| item.is_string() && (!closed(field) || offered(field, item)))
            }),
            _ => false,
        };
        if !valid {
            return Err(field_error(
                field,
                "Answer has the wrong type, option or bounds",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn captured() -> Value {
        serde_json::from_str(include_str!("../../tests/fixtures/opencode-v2-native-form-info.json")).unwrap()
    }

    fn answers(value: &Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn captured_native_info_maps_to_the_canonical_target_form() {
        let corpus = captured();
        for row in corpus["forms"].as_array().unwrap() {
            let canonical = canonical_from_info(&row["native"]).unwrap();
            assert_eq!(canonical["kind"], "form", "{}", row["case"]);
            assert_eq!(canonical["validation"], json!({"semantics":"opencode-v2","patternAndFormat":"native"}));
            assert_eq!(canonical["message"], row["native"]["title"], "{}", row["case"]);
            assert!(canonical.get("native").is_none(), "{}", row["case"]);
            let native_fields = row["native"]["fields"].as_array().unwrap();
            let fields = canonical["fields"].as_array().unwrap();
            assert_eq!(fields.len(), native_fields.len(), "{}", row["case"]);
            for (field, native) in fields.iter().zip(native_fields) {
                assert_eq!(field["id"], native["key"], "native key becomes the canonical id in order");
                for key in ["type", "title", "description", "required", "options", "custom", "hidden",
                            "default", "when", "placeholder", "pattern", "format", "url", "minLength",
                            "maxLength", "minimum", "maximum", "minItems", "maxItems"] {
                    assert_eq!(field.get(key), native.get(key), "{}.{}", row["case"], key);
                }
            }
            // The mapped form admits the native-valid answer and the captured summary
            // is produced by typed filtering before string conversion.
            let values = answers(&row["validAnswer"]);
            validate(&canonical, &values).unwrap_or_else(|error| panic!("{}: {error:?}", row["case"]));
            assert_eq!(json!(typed_summary(&canonical, &values)), row["summary"], "{}", row["case"]);
        }
    }

    #[test]
    fn typed_summary_drops_inactive_and_hidden_answers_before_string_conversion() {
        let corpus = captured();
        let row = &corpus["forms"][0];
        let canonical = canonical_from_info(&row["native"]).unwrap();
        let values = answers(&json!({"name":"ABC","count":2,"enabled":false,"mode":["red"],"external":true,"conditional":"inactive"}));
        assert_eq!(json!(typed_summary(&canonical, &values)), row["summary"], "inactive conditional key is absent from the summary");
        // The typed answer itself stays invalid: filtering never authorizes it.
        assert!(validate(&canonical, &values).is_err());
        // Activation is decided from typed values, not from the rendered strings.
        let active = answers(&json!({"name":"ABC","count":2,"enabled":true,"mode":["red","blue"],"external":true,"conditional":"shown"}));
        let summary = typed_summary(&canonical, &active);
        assert_eq!(summary["conditional"], json!("shown"));
        assert_eq!(summary["mode"], json!("red, blue"));
        let hidden_form = canonical_from_info(&corpus["forms"][1]["native"]).unwrap();
        let mut hidden = answers(&corpus["forms"][1]["validAnswer"]);
        hidden.insert("hidden".into(), json!("H"));
        let hidden_summary = Value::Object(typed_summary(&hidden_form, &hidden));
        assert_eq!(hidden_summary["hidden"], Value::Null, "no hidden value is ever summarized");
        assert_eq!(hidden_summary["zero"], json!("0"), "zero stays distinct from missing");
        assert_eq!(hidden_summary["empty"], json!(""), "empty stays distinct from missing");
    }

    #[test]
    fn native_info_that_cannot_be_represented_fails_explicitly() {
        let field = |extra: Value| {
            let mut native = json!({"id":"frm","sessionID":"ses","title":"t",
                "fields":[{"key":"k","type":"string"}]});
            if let Some(object) = extra.as_object() {
                for (key, value) in object {
                    native["fields"][0][key] = value.clone();
                }
            }
            native
        };
        assert!(canonical_from_info(&field(json!({"futureConstraint":true}))).is_err());
        assert!(canonical_from_info(&field(json!({"type":"future-type"}))).is_err());
        assert!(canonical_from_info(&json!({"id":"frm","fields":[]})).is_err());
        assert!(canonical_from_info(&json!({"id":"frm","fields":[{"type":"string"}]})).is_err());
        assert!(canonical_from_info(&json!({"fields":[{"key":"k","type":"string"}]})).is_err());
        // A hidden required field with a default is representable and stays hidden.
        let hidden = canonical_from_info(&field(json!({"hidden":true,"required":true,"default":"H"}))).unwrap();
        assert_eq!(hidden["fields"][0]["hidden"], true);
        assert_eq!(hidden["fields"][0]["default"], "H");
    }

    #[test]
    fn malformed_or_future_constraints_fail_explicitly_without_evaluating_patterns() {
        let field = json!({"id":"choice","type":"string","options":[{"value":"a","label":"A"}]});
        let form = |fields| json!({"kind":"form","validation":{"semantics":"opencode-v2","patternAndFormat":"native"},"fields":fields});
        for changed in [
            {
                let mut changed = field.clone();
                changed["secret"] = json!(true);
                changed
            },
            {
                let mut changed = field.clone();
                changed["multiline"] = json!(true);
                changed
            },
            json!({"id":"external","type":"external","url":"x","required":false}),
            {
                let mut changed = field.clone();
                changed["futureConstraint"] = json!(true);
                changed
            },
            {
                let mut changed = field.clone();
                changed["format"] = json!("future");
                changed
            },
            {
                let mut changed = field.clone();
                changed["options"][0]["disabled"] = json!(true);
                changed
            },
            {
                let mut changed = field.clone();
                changed["minLength"] = json!(-1);
                changed
            },
            {
                let mut changed = field.clone();
                changed["default"] = json!(false);
                changed
            },
        ] {
            assert!(validate(&form(json!([changed])), &Map::new()).is_err());
        }
        let next = json!({"id":"next","type":"string","when":[{"key":"choice","op":"eq","value":"a","futureOperation":true}]});
        assert!(validate(&form(json!([field, next])), &Map::new()).is_err());
        let pattern = json!({"id":"value","type":"string","pattern":"(a+)+$","format":"date-time"});
        assert!(validate(
            &form(json!([pattern])),
            json!({"value":"native adjudicates this"})
                .as_object()
                .unwrap()
        )
        .is_ok());
    }

    #[test]
    fn values_and_error_details_preserve_keys_without_exposing_answer_contents() {
        let form = json!({"kind":"form","validation":{"semantics":"opencode-v2","patternAndFormat":"native"},"fields":[
            {"id":"__proto__","type":"string","required":true},
            {"id":"中文键","type":"string","required":true,"minLength":2}
        ]});
        assert!(validate(
            &form,
            json!({"__proto__":"value","中文键":"😀"})
                .as_object()
                .unwrap()
        )
        .is_ok());
        let error = validate(
            &form,
            json!({"__proto__":"value","中文键":"x"})
                .as_object()
                .unwrap(),
        )
        .unwrap_err();
        assert_eq!(error.details, Some(json!({"fieldId":"中文键"})));
        assert!(!serde_json::to_string(&error).unwrap().contains("\"x\""));
    }
}
