use crate::providers::ProviderError;
use serde_json::Value;

pub(crate) fn validate_response(response: &Value, runtime_owned: bool) -> Result<(), ProviderError> {
    let action = response.get("action").and_then(Value::as_str);
    if !matches!(action, Some("approve" | "request_changes" | "abandon")) {
        return Err(ProviderError::new("answer_invalid", "Invalid plan decision"));
    }
    if let Some(feedback) = response.get("feedback") {
        if feedback.as_str().is_none_or(|text| text.encode_utf16().count() > 16_000) {
            return Err(ProviderError::new("answer_invalid", "Plan feedback must be text up to 16000 characters"));
        }
    }
    if action == Some("request_changes") && !runtime_owned && response.get("feedback").and_then(Value::as_str).is_none_or(|text| text.trim().is_empty()) {
        return Err(ProviderError::new("answer_invalid", "Explain the requested plan changes"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn plan_response_validation_preserves_native_feedback_and_composer_flow() {
        assert!(validate_response(&json!({"action":"approve"}), false).is_ok());
        assert!(validate_response(&json!({"action":"abandon"}), false).is_ok());
        assert!(validate_response(&json!({"action":"request_changes","feedback":"Add tests"}), false).is_ok());
        assert!(validate_response(&json!({"action":"request_changes"}), true).is_ok());
        assert!(validate_response(&json!({"action":"request_changes","feedback":" "}), false).is_err());
        assert!(validate_response(&json!({"action":"submit"}), true).is_err());
        assert!(validate_response(&json!({"action":"approve","feedback":4}), true).is_err());
        assert!(validate_response(&json!({"action":"request_changes","feedback":"😀".repeat(8000)}), false).is_ok());
        assert!(validate_response(&json!({"action":"request_changes","feedback":"😀".repeat(8001)}), false).is_err());
    }
}
