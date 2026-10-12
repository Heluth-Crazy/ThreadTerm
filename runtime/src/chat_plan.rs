//! Shared projection for the agent plan/todo part (B4).
//!
//! Providers normalize their native plan/todo updates into one additive
//! `ChatPart{type:"plan"}` shape. The renderer paints the latest one in the
//! pinned plan panel; the part is never rendered inline in the transcript.
use serde_json::{json, Value};

/// Native plans are short; cap what the renderer must lay out.
pub(crate) const MAX_PLAN_ENTRIES: usize = 256;

/// Canonical entry status shared by every adapter.
pub(crate) fn normalized_status(status: &str) -> &'static str {
    match status {
        "in_progress" | "inProgress" | "active" | "running" => "in_progress",
        "completed" | "complete" | "done" | "success" => "completed",
        _ => "pending",
    }
}

fn normalized_priority(priority: &str) -> Option<&'static str> {
    match priority {
        "high" | "medium" | "low" => Some(match priority {
            "high" => "high",
            "medium" => "medium",
            _ => "low",
        }),
        _ => None,
    }
}

/// Build the plan data object. Entries are `(content, status, priority?)`.
/// Returns `None` when no entry has usable content.
pub(crate) fn plan_data(
    entries: impl IntoIterator<Item = (String, String, Option<String>)>,
    explanation: Option<&str>,
) -> Option<Value> {
    let mut out = Vec::new();
    for (content, status, priority) in entries.into_iter().take(MAX_PLAN_ENTRIES) {
        let content = content.trim();
        if content.is_empty() {
            continue;
        }
        let mut entry = json!({"content": content, "status": normalized_status(&status)});
        if let Some(priority) = priority.as_deref().and_then(normalized_priority) {
            entry["priority"] = json!(priority);
        }
        out.push(entry);
    }
    if out.is_empty() {
        return None;
    }
    let mut data = json!({"entries": out});
    if let Some(explanation) = explanation.map(str::trim).filter(|text| !text.is_empty()) {
        data["explanation"] = json!(explanation);
    }
    Some(data)
}

/// One plan part per turn; the tool id makes repeated updates replace in place.
pub(crate) fn plan_tool_id(turn_id: Option<&str>) -> String {
    format!(
        "plan:{}",
        turn_id.filter(|id| !id.trim().is_empty()).unwrap_or("current")
    )
}

/// The additive `ChatPart` every adapter emits through the existing merge path.
pub(crate) fn plan_part(data: Value, turn_id: Option<&str>) -> Value {
    json!({
        "type": "plan",
        "toolId": plan_tool_id(turn_id),
        "status": "complete",
        "data": data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_statuses_and_priorities() {
        let data = plan_data(
            vec![
                ("First".into(), "inProgress".into(), Some("high".into())),
                ("Second".into(), "completed".into(), None),
                ("Third".into(), "whatever".into(), Some("urgent".into())),
            ],
            Some("  why  "),
        )
        .unwrap();
        assert_eq!(data["entries"][0]["status"], "in_progress");
        assert_eq!(data["entries"][0]["priority"], "high");
        assert_eq!(data["entries"][1]["status"], "completed");
        assert_eq!(data["entries"][2]["status"], "pending");
        assert!(data["entries"][2].get("priority").is_none());
        assert_eq!(data["explanation"], "why");
    }

    #[test]
    fn empty_plans_are_dropped() {
        assert!(plan_data(Vec::new(), None).is_none());
        assert!(plan_data(vec![("  ".into(), "pending".into(), None)], None).is_none());
    }

    #[test]
    fn tool_id_is_one_per_turn() {
        assert_eq!(plan_tool_id(Some("turn-1")), "plan:turn-1");
        assert_eq!(plan_tool_id(None), "plan:current");
        let part = plan_part(json!({"entries": []}), Some("turn-1"));
        assert_eq!(part["type"], "plan");
        assert_eq!(part["toolId"], "plan:turn-1");
        assert_eq!(part["status"], "complete");
    }
}
