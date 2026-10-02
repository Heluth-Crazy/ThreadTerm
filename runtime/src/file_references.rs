//! Bounded, provider-neutral extraction of *candidate* file references from
//! structured native tool payloads. Resolution and authorization happen later.
use serde_json::{json, Value};
use std::collections::HashSet;

const MAX_REFERENCES: usize = 32;
const MAX_DEPTH: usize = 8;
const MAX_VISITED_NODES: usize = 4096;
const MAX_PATH_BYTES: usize = 16 * 1024;
const MAX_POSITION: u64 = 1_000_000;

fn path_field(key: &str) -> bool {
    matches!(
        key,
        "path" | "filePath" | "file_path" | "filepath" | "filename" | "fileName" | "uri"
    )
}

fn valid_candidate(path: &str) -> bool {
    let path = path.trim();
    if path.is_empty() || path.len() > MAX_PATH_BYTES || path.chars().any(char::is_control) {
        return false;
    }
    if !path.contains("://") {
        return true;
    }
    // Match the renderer's deliberately narrow, non-decoding file:// parser.
    // The runtime resolver still makes the authoritative containment decision.
    if !path
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
    {
        return false;
    }
    let rest = &path[7..];
    if rest.contains(['%', '?', '#']) {
        return false;
    }
    if rest.starts_with('/') {
        let drive = rest.trim_start_matches('/').as_bytes();
        drive.len() >= 3
            && drive[0].is_ascii_alphabetic()
            && drive[1] == b':'
            && matches!(drive[2], b'/' | b'\\')
    } else {
        rest.split_once('/')
            .is_some_and(|(host, share)| !host.is_empty() && !share.is_empty())
    }
}

fn position(value: &Value, primary: &str, secondary: &str) -> Option<u64> {
    value
        .get(primary)
        .or_else(|| value.get(secondary))
        .and_then(Value::as_u64)
        .filter(|number| *number > 0 && *number <= MAX_POSITION)
}

fn push_path(path: &str, container: &Value, out: &mut Vec<Value>, seen: &mut HashSet<String>) {
    if out.len() >= MAX_REFERENCES || !valid_candidate(path) {
        return;
    }
    let path = path.trim();
    let line = position(container, "line", "lineNumber");
    let column = position(container, "column", "columnNumber");
    let key = format!("{path}\0{}\0{}", line.unwrap_or(0), column.unwrap_or(0));
    if !seen.insert(key) {
        return;
    }
    let mut reference = json!({"path":path});
    if let Some(line) = line {
        reference["line"] = json!(line);
    }
    if let Some(column) = column {
        reference["column"] = json!(column);
    }
    out.push(reference);
}

fn walk(
    value: &Value,
    depth: usize,
    out: &mut Vec<Value>,
    seen: &mut HashSet<String>,
    remaining: &mut usize,
) {
    if *remaining == 0 || out.len() >= MAX_REFERENCES {
        return;
    }
    *remaining -= 1;
    if depth > MAX_DEPTH {
        return;
    }
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if path_field(key) {
                    if let Some(path) = child.as_str() {
                        push_path(path, value, out, seen);
                    }
                }
                walk(child, depth + 1, out, seen, remaining);
                if out.len() >= MAX_REFERENCES || *remaining == 0 {
                    break;
                }
            }
        }
        Value::Array(items) => {
            for child in items.iter().take(256) {
                walk(child, depth + 1, out, seen, remaining);
                if out.len() >= MAX_REFERENCES || *remaining == 0 {
                    break;
                }
            }
        }
        _ => {}
    }
}

/// Preserve prior candidates on an incremental update of the same native tool.
/// Only structured path keys are collected; tool success is irrelevant.
pub fn enrich_tool_part(part: &mut Value, previous: Option<&Value>) {
    if part.get("type").and_then(Value::as_str) != Some("tool") {
        return;
    }
    let mut references = Vec::new();
    let mut seen = HashSet::new();
    let mut remaining = MAX_VISITED_NODES;
    if let Some(old) = previous.and_then(|value| value.get("fileReferences")) {
        walk(old, 0, &mut references, &mut seen, &mut remaining);
    }
    if let Some(existing) = part.get("fileReferences") {
        walk(existing, 0, &mut references, &mut seen, &mut remaining);
    }
    if let Some(data) = part.get("data") {
        walk(data, 0, &mut references, &mut seen, &mut remaining);
    }
    if !references.is_empty() {
        part["fileReferences"] = json!(references);
    }
}

pub fn enrich_parts(parts: &mut [Value]) {
    for part in parts {
        enrich_tool_part(part, None);
    }
}

/// Native ACP history can include initial and later updates for one tool.
/// Preserve its first position while letting the last status/payload win.
pub fn upsert_history_tool(items: &mut Vec<Value>, mut item: Value) {
    let Some(id) = item.get("id").and_then(Value::as_str) else {
        return;
    };
    if let Some(existing) = items
        .iter_mut()
        .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(id))
    {
        let old_part = existing.pointer("/parts/0");
        if let Some(part) = item.pointer_mut("/parts/0") {
            enrich_tool_part(part, old_part);
            if part.get("toolName").is_none() {
                if let Some(name) = old_part.and_then(|value| value.get("toolName")) {
                    part["toolName"] = name.clone();
                }
            }
        }
        *existing = item;
    } else {
        items.push(item);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_structured_paths_are_bounded_deduplicated_and_not_success_gated() {
        let mut part = json!({"type":"tool","status":"failed","data":{
            "input":{"file_path":"src/main.rs","line":7,"column":2},
            "changes":[{"path":"src/main.rs","line":7,"column":2},{"path":"README.md"}],
            "output":{"filePath":"README.md"},"url":"https://example.com/file",
            "title":"not/a/path"
        }});
        enrich_tool_part(&mut part, None);
        assert_eq!(
            part["fileReferences"],
            json!([
                {"path":"src/main.rs","line":7,"column":2},{"path":"README.md"}
            ])
        );
    }

    #[test]
    fn partial_update_retains_prior_references_without_reviving_old_status_or_payload() {
        let prior = json!({"type":"tool","toolId":"x","status":"running","data":{"input":{"path":"a.rs"}},"fileReferences":[{"path":"a.rs"}]});
        let mut update =
            json!({"type":"tool","toolId":"x","status":"failed","data":{"output":{"path":"b.rs"}}});
        enrich_tool_part(&mut update, Some(&prior));
        assert_eq!(update["status"], "failed");
        assert_eq!(update["data"], json!({"output":{"path":"b.rs"}}));
        assert_eq!(
            update["fileReferences"],
            json!([{"path":"a.rs"},{"path":"b.rs"}])
        );
    }

    #[test]
    fn ignores_urls_and_caps_large_native_path_arrays() {
        let paths: Vec<Value> = (0..128)
            .map(|index| json!({"path":format!("src/{index}.rs")}))
            .collect();
        let mut part =
            json!({"type":"tool","data":{"locations":paths,"other":{"uri":"https://host/a.rs"}}});
        enrich_tool_part(&mut part, None);
        assert_eq!(
            part["fileReferences"].as_array().unwrap().len(),
            MAX_REFERENCES
        );
        assert!(part["fileReferences"]
            .as_array()
            .unwrap()
            .iter()
            .all(|reference| { reference["path"].as_str().unwrap().starts_with("src/") }));
    }

    #[test]
    fn candidate_limits_match_resolve_and_safe_file_uris_reach_renderer() {
        assert!(valid_candidate(&"a".repeat(MAX_PATH_BYTES)));
        assert!(!valid_candidate(&"a".repeat(MAX_PATH_BYTES + 1)));
        assert!(valid_candidate("file:///C:/repo/src/main.rs"));
        assert!(valid_candidate("FILE://server/share/main.rs"));
        assert!(!valid_candidate("file:///C:/repo/%2e%2e/secret.rs"));
        assert!(!valid_candidate("https://host/main.rs"));
        let mut part = json!({"type":"tool","data":{
            "one":{"path":"src/max.rs","line":1_000_000,"column":1_000_001},
            "two":{"path":"file:///C:/repo/src/main.rs","line":1_000_001}
        }});
        enrich_tool_part(&mut part, None);
        assert_eq!(
            part["fileReferences"],
            json!([
                {"path":"src/max.rs","line":1_000_000},
                {"path":"file:///C:/repo/src/main.rs"}
            ])
        );
    }

    #[test]
    fn global_node_budget_stops_wide_objects_before_late_references() {
        let mut wide = serde_json::Map::new();
        for index in 0..MAX_VISITED_NODES + 100 {
            wide.insert(format!("a{index:05}"), json!(index));
        }
        wide.insert("z_late".to_owned(), json!({"path":"late.rs"}));
        let data = Value::Object(wide);
        let mut references = Vec::new();
        let mut seen = HashSet::new();
        let mut remaining = MAX_VISITED_NODES;
        walk(&data, 0, &mut references, &mut seen, &mut remaining);
        assert_eq!(remaining, 0);
        assert!(references.is_empty());
    }
}
