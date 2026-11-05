use super::adapters::language_id;
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Map, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

pub(super) const MAX_DOCUMENTS: usize = 128;
pub(super) const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
pub(super) const MAX_CONTEXT_BYTES: usize = 8 * 1024 * 1024;
pub(super) const MAX_TARGETS: usize = 100;
pub(super) const MAX_SYMBOLS: usize = 2_000;

#[derive(Clone)]
pub(super) struct Document {
    pub(super) canonical: PathBuf,
    pub(super) uri: String,
    pub(super) language_id: &'static str,
    pub(super) content: String,
    pub(super) version: i64,
}

impl Document {
    pub(super) fn open_params(&self) -> Value {
        json!({"textDocument":{
            "uri":self.uri,
            "languageId":self.language_id,
            "version":self.version,
            "text":self.content
        }})
    }

    pub(super) fn close_params(&self) -> Value {
        json!({"textDocument":{"uri":self.uri}})
    }

    pub(super) fn change_params(&self, old: &Document, incremental: bool) -> Value {
        let changes = if incremental {
            vec![incremental_change(&old.content, &self.content)]
        } else {
            vec![json!({"text":self.content})]
        };
        json!({
            "textDocument":{"uri":self.uri,"version":self.version},
            "contentChanges":changes
        })
    }
}

pub(super) fn document(
    root: &Path,
    relative: &str,
    content: String,
    version: i64,
) -> Result<Document> {
    if relative.is_empty() || relative.len() > 4_096 {
        return Err(anyhow!(
            "navigation_invalid_path: document path is empty or too long"
        ));
    }
    if version < 0 {
        return Err(anyhow!(
            "navigation_invalid_version: document version must be nonnegative"
        ));
    }
    if content.len() > MAX_DOCUMENT_BYTES {
        return Err(anyhow!(
            "navigation_document_too_large: document exceeds 1 MiB"
        ));
    }
    let canonical = crate::workspace_services::scoped_path(root, relative, true).map_err(|_| {
        anyhow!(
            "navigation_invalid_path: document is outside the registered root or does not exist"
        )
    })?;
    if !canonical.is_file() {
        return Err(anyhow!(
            "navigation_invalid_path: document is not a regular source file"
        ));
    }
    let language_id = language_id(&canonical).ok_or_else(|| {
        anyhow!("navigation_unsupported_document: document is not a supported source file")
    })?;
    relative_path(root, &canonical)?;
    Ok(Document {
        uri: file_uri(&canonical),
        canonical,
        language_id,
        content,
        version,
    })
}

pub(super) fn validate_position(content: &str, line: i64, column: i64) -> Result<(u64, u64)> {
    if line <= 0 || column <= 0 {
        return Err(anyhow!(
            "navigation_invalid_position: line and column are one-based"
        ));
    }
    let wanted_line =
        usize::try_from(line - 1).map_err(|_| anyhow!("navigation_invalid_position"))?;
    let wanted_column =
        usize::try_from(column - 1).map_err(|_| anyhow!("navigation_invalid_position"))?;
    let mut lines = content.split('\n');
    let mut text = lines.nth(wanted_line).ok_or_else(|| {
        anyhow!("navigation_invalid_position: line is outside the synchronized document")
    })?;
    if text.ends_with('\r') {
        text = &text[..text.len() - 1];
    }
    let mut units = 0usize;
    for character in text.chars() {
        if units == wanted_column {
            return Ok((wanted_line as u64, wanted_column as u64));
        }
        units += character.len_utf16();
        if units > wanted_column {
            return Err(anyhow!(
                "navigation_invalid_position: column splits a UTF-16 surrogate pair"
            ));
        }
    }
    if units == wanted_column {
        Ok((wanted_line as u64, wanted_column as u64))
    } else {
        Err(anyhow!(
            "navigation_invalid_position: column is outside the synchronized line"
        ))
    }
}

fn incremental_change(old: &str, new: &str) -> Value {
    let mut prefix = 0usize;
    for (left, right) in old.chars().zip(new.chars()) {
        if left != right {
            break;
        }
        prefix += left.len_utf8();
    }
    let old_tail = &old[prefix..];
    let new_tail = &new[prefix..];
    let mut suffix = 0usize;
    for (left, right) in old_tail.chars().rev().zip(new_tail.chars().rev()) {
        if left != right {
            break;
        }
        suffix += left.len_utf8();
    }
    let old_end = old.len() - suffix;
    let new_end = new.len() - suffix;
    let start = offset_position(old, prefix);
    let end = offset_position(old, old_end);
    let removed_utf16 = old[prefix..old_end].encode_utf16().count();
    json!({
        "range":{"start":start,"end":end},
        "rangeLength":removed_utf16,
        "text":&new[prefix..new_end]
    })
}

fn offset_position(text: &str, byte_offset: usize) -> Value {
    let before = &text[..byte_offset];
    let line = before.bytes().filter(|byte| *byte == b'\n').count();
    let line_start = before.rfind('\n').map_or(0, |position| position + 1);
    let character = before[line_start..]
        .trim_end_matches('\r')
        .encode_utf16()
        .count();
    json!({"line":line,"character":character})
}

pub(super) fn definition_result(root: &Path, response: &Value) -> Result<Value> {
    let (targets, truncated) = normalize_locations(root, response);
    let has_candidates = response
        .as_array()
        .map_or(response.is_object(), |values| !values.is_empty());
    if targets.is_empty() && has_candidates {
        return Err(anyhow!("navigation_unsupported_target: the definition is not an accessible source file within this project"));
    }
    Ok(json!({"targets":targets,"truncated":truncated}))
}

pub(super) fn normalize_locations(root: &Path, response: &Value) -> (Vec<Value>, bool) {
    let values = if response.is_null() {
        Vec::new()
    } else if let Some(values) = response.as_array() {
        values.iter().collect::<Vec<_>>()
    } else {
        vec![response]
    };
    let mut targets = Vec::new();
    let mut seen = HashSet::new();
    let mut truncated = false;
    for value in values {
        let uri = value
            .get("targetUri")
            .or_else(|| value.get("uri"))
            .and_then(Value::as_str);
        let range = value
            .get("targetSelectionRange")
            .or_else(|| value.get("targetRange"))
            .or_else(|| value.get("range"));
        let Some((uri, range)) = uri.zip(range) else {
            continue;
        };
        let Ok(path) = authorized_uri(root, uri) else {
            continue;
        };
        let Ok((line, column, end_line, end_column)) = wire_range(range) else {
            continue;
        };
        let Ok(relative) = relative_path(root, &path) else {
            continue;
        };
        let key = (relative.clone(), line, column, end_line, end_column);
        if !seen.insert(key) {
            continue;
        }
        if targets.len() == MAX_TARGETS {
            truncated = true;
            break;
        }
        targets.push(json!({
            "path":relative,
            "line":line,
            "column":column,
            "endLine":end_line,
            "endColumn":end_column
        }));
    }
    (targets, truncated)
}

pub(super) fn normalize_symbols(
    root: &Path,
    requested: &Path,
    response: &Value,
) -> (Vec<Value>, bool) {
    let mut output = Vec::new();
    let mut truncated = false;
    if let Some(values) = response.as_array() {
        for value in values {
            symbol(root, requested, value, None, 0, &mut output, &mut truncated);
            if truncated {
                break;
            }
        }
    }
    (output, truncated)
}

fn symbol(
    root: &Path,
    requested: &Path,
    value: &Value,
    parent: Option<&str>,
    depth: usize,
    output: &mut Vec<Value>,
    truncated: &mut bool,
) {
    if depth > 64 || *truncated {
        return;
    }
    if output.len() == MAX_SYMBOLS {
        *truncated = true;
        return;
    }
    let Some(name) = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty() && name.len() <= 1_024)
    else {
        return;
    };
    let Some(kind) = value
        .get("kind")
        .and_then(Value::as_u64)
        .filter(|kind| (1..=26).contains(kind))
    else {
        return;
    };
    let (path, range, container) = if let Some(location) = value.get("location") {
        let Some(uri) = location.get("uri").and_then(Value::as_str) else {
            return;
        };
        let Ok(path) = authorized_uri(root, uri) else {
            return;
        };
        (
            path,
            location.get("range"),
            value
                .get("containerName")
                .and_then(Value::as_str)
                .or(parent),
        )
    } else {
        (
            requested.to_path_buf(),
            value.get("selectionRange").or_else(|| value.get("range")),
            parent,
        )
    };
    let Some(range) = range else { return };
    let Ok((line, column, _, _)) = wire_range(range) else {
        return;
    };
    let Ok(relative) = relative_path(root, &path) else {
        return;
    };
    let mut item = Map::new();
    item.insert("name".into(), json!(name));
    item.insert("kind".into(), json!(kind));
    item.insert("path".into(), json!(relative));
    item.insert("line".into(), json!(line));
    item.insert("column".into(), json!(column));
    if let Some(container) = container.filter(|value| !value.is_empty() && value.len() <= 1_024) {
        item.insert("container".into(), json!(container));
    }
    output.push(Value::Object(item));
    if let Some(children) = value.get("children").and_then(Value::as_array) {
        for child in children {
            symbol(
                root,
                requested,
                child,
                Some(name),
                depth + 1,
                output,
                truncated,
            );
            if *truncated {
                break;
            }
        }
    }
}

fn wire_range(range: &Value) -> Result<(u64, u64, u64, u64)> {
    let start = range
        .get("start")
        .ok_or_else(|| anyhow!("missing range start"))?;
    let end = range.get("end").unwrap_or(start);
    let line = coordinate(start.get("line"))? + 1;
    let column = coordinate(start.get("character"))? + 1;
    let end_line = coordinate(end.get("line"))? + 1;
    let end_column = coordinate(end.get("character"))? + 1;
    Ok((line, column, end_line, end_column))
}

fn coordinate(value: Option<&Value>) -> Result<u64> {
    value
        .and_then(Value::as_u64)
        // Wire coordinates become one-based and are bounded at 1,000,000.
        .filter(|value| *value < 1_000_000)
        .ok_or_else(|| anyhow!("invalid LSP coordinate"))
}

fn authorized_uri(root: &Path, uri: &str) -> Result<PathBuf> {
    let path = path_from_file_uri(uri)?;
    let canonical = path
        .canonicalize()
        .context("canonicalizing language server target")?;
    let root = root
        .canonicalize()
        .context("canonicalizing registered root")?;
    if !canonical.starts_with(&root)
        || !fs::metadata(&canonical)?.is_file()
        || language_id(&canonical).is_none()
    {
        return Err(anyhow!("navigation_target_outside_scope"));
    }
    Ok(canonical)
}

pub(super) fn relative_path(root: &Path, path: &Path) -> Result<String> {
    let root = root
        .canonicalize()
        .context("canonicalizing registered root")?;
    let path = path.canonicalize().context("canonicalizing source path")?;
    let relative = path
        .strip_prefix(&root)
        .map_err(|_| anyhow!("navigation_target_outside_scope"))?;
    let value = relative.to_string_lossy().replace('\\', "/");
    if value.is_empty() {
        Err(anyhow!("navigation_invalid_path"))
    } else {
        Ok(value)
    }
}

pub(super) fn file_uri(path: &Path) -> String {
    let mut value = path.to_string_lossy().into_owned();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        value = format!(r"\\{rest}");
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        value = rest.to_owned();
    }
    value = value.replace('\\', "/");
    if value.starts_with("//") {
        format!("file:{}", percent_encode(&value))
    } else if value.as_bytes().get(1) == Some(&b':') {
        format!("file:///{}", percent_encode(&value))
    } else {
        format!("file://{}", percent_encode(&value))
    }
}

fn path_from_file_uri(uri: &str) -> Result<PathBuf> {
    let raw = uri
        .strip_prefix("file://")
        .ok_or_else(|| anyhow!("navigation_unsupported_uri"))?;
    if raw.contains('?') || raw.contains('#') || raw.is_empty() {
        return Err(anyhow!("navigation_unsupported_uri"));
    }
    let decoded = percent_decode(raw)?;
    #[cfg(windows)]
    let decoded = {
        if decoded.starts_with('/') && decoded.as_bytes().get(2) == Some(&b':') {
            decoded[1..].replace('/', "\\")
        } else if !decoded.starts_with('/') {
            format!(r"\\{}", decoded.replace('/', "\\"))
        } else {
            decoded.replace('/', "\\")
        }
    };
    #[cfg(not(windows))]
    let decoded = {
        if !decoded.starts_with('/') {
            return Err(anyhow!("navigation_unsupported_uri"));
        }
        decoded
    };
    Ok(PathBuf::from(decoded))
}

fn percent_encode(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/' | b':') {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn percent_decode(value: &str) -> Result<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(anyhow!("navigation_unsupported_uri"));
            }
            let high =
                hex(bytes[index + 1]).ok_or_else(|| anyhow!("navigation_unsupported_uri"))?;
            let low = hex(bytes[index + 2]).ok_or_else(|| anyhow!("navigation_unsupported_uri"))?;
            output.push(high * 16 + low);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| anyhow!("navigation_unsupported_uri"))
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_positions_respect_surrogates_crlf_and_one_based_wire_coordinates() {
        let text = "a🙂b\r\nλ";
        assert_eq!(validate_position(text, 1, 1).unwrap(), (0, 0));
        assert_eq!(validate_position(text, 1, 2).unwrap(), (0, 1));
        assert!(
            validate_position(text, 1, 3).is_err(),
            "middle of surrogate pair"
        );
        assert_eq!(validate_position(text, 1, 4).unwrap(), (0, 3));
        assert_eq!(validate_position(text, 2, 2).unwrap(), (1, 1));
        assert_eq!(validate_position(text, 1, 5).unwrap(), (0, 4));
        assert!(
            validate_position(text, 1, 6).is_err(),
            "CR is not an editor column"
        );
    }

    #[test]
    fn incremental_change_is_a_minimal_utf16_edit() {
        let change = incremental_change("a🙂b\r\nc", "a🙂B\r\nc");
        assert_eq!(change["range"]["start"], json!({"line":0,"character":3}));
        assert_eq!(change["range"]["end"], json!({"line":0,"character":4}));
        assert_eq!(change["rangeLength"], 1);
        assert_eq!(change["text"], "B");
    }

    #[test]
    fn location_normalization_rejects_external_and_non_source_targets() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let outside = temp.path().join("outside.rs");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("inside.rs"), "fn inside() {}").unwrap();
        fs::write(root.join("note.txt"), "not source").unwrap();
        fs::write(&outside, "fn outside() {}").unwrap();
        let response = json!([
            {"uri":file_uri(&root.join("inside.rs")),"range":{"start":{"line":1,"character":2},"end":{"line":1,"character":4}}},
            {"targetUri":file_uri(&outside),"targetSelectionRange":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}}},
            {"uri":file_uri(&root.join("note.txt")),"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}}}
        ]);
        let (targets, truncated) = normalize_locations(&root, &response);
        assert!(!truncated);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0]["path"], "inside.rs");
        assert_eq!(targets[0]["line"], 2);
        assert_eq!(targets[0]["column"], 3);
    }

    #[test]
    fn definition_feedback_distinguishes_empty_and_unsupported_answers() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("source.rs"), "fn target() {}").unwrap();
        let range = json!({"start":{"line":0,"character":3},"end":{"line":0,"character":9}});
        let unsupported = json!({"uri":"jdt://archive/Library.class","range":range});
        for response in [Value::Null, json!([])] {
            assert_eq!(
                definition_result(root, &response).unwrap()["targets"],
                json!([])
            );
        }
        assert!(definition_result(root, &json!([unsupported.clone()]))
            .unwrap_err()
            .to_string()
            .contains("navigation_unsupported_target"));
        let mixed = json!([unsupported, {"uri":file_uri(&root.join("source.rs")),"range":range}]);
        let result = definition_result(root, &mixed).unwrap();
        assert_eq!(result["targets"].as_array().unwrap().len(), 1);
        assert_eq!(result["targets"][0]["path"], "source.rs");
    }

    #[test]
    fn file_uri_round_trips_unicode_and_spaces() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("空 白.rs");
        fs::write(&path, "").unwrap();
        let uri = file_uri(&path.canonicalize().unwrap());
        assert!(uri.contains("%20"));
        assert_eq!(
            path_from_file_uri(&uri).unwrap().canonicalize().unwrap(),
            path.canonicalize().unwrap()
        );
    }
}
