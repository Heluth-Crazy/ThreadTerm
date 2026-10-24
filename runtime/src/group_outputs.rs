//! Pure, bounded extraction of group-reply outputs.
//!
//! `output` is pure so group projection may call it while holding SQLite state.
//! `validate_files` deliberately performs its filesystem check only after that
//! transaction, so it can reject symlink/junction escapes without blocking SQLite.
use crate::domain::ChatItem;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path};

const MAX_OUTPUTS: usize = 64;
const MAX_SCAN_BYTES: usize = 64 * 1024;
const MAX_CHANGED: usize = 64;
const MAX_PATH_BYTES: usize = 4 * 1024;
// Leave room for JSON array punctuation and field names, so the serialized
// protocol payload remains below the 64 KiB reply-output budget.
const MAX_OUTPUT_BYTES: usize = 60 * 1024;
const MAX_SUGGESTIONS: usize = 32;
const MAX_SUGGESTION_BYTES: usize = 4 * 1024;

/// Build the protocol-shaped `GroupOutputs` payload from a completed reply and
/// the completed turn's Chat items. `items` must already be scoped to that turn.
pub(crate) fn output(cwd: &str, body: &str, items: &[ChatItem], _handles: &[String]) -> Value {
    let mut files = Vec::new();
    let mut urls = Vec::new();
    let mut file_seen = HashSet::new();
    let mut url_seen = HashSet::new();
    let mut output_bytes = 0;
    for token in reply_tokens(body) {
        if let Some(url) = http_url(&token) {
            push_output(
                &mut urls,
                &mut url_seen,
                url,
                MAX_OUTPUTS,
                &mut output_bytes,
            );
        } else if let Some(path) = root_relative(cwd, &token) {
            push_output(
                &mut files,
                &mut file_seen,
                path,
                MAX_OUTPUTS,
                &mut output_bytes,
            );
        }
    }

    let mut changed = Vec::new();
    let mut changed_seen = HashSet::new();
    let mut changed_incomplete = false;
    for item in items {
        for part in &item.parts {
            if !is_edit_tool(part) || !tool_succeeded(part) {
                continue;
            }
            for path in tool_paths(part) {
                if let Some(path) = authoritative_root_relative(cwd, &path) {
                    let cost = path.len().saturating_add(3);
                    if !changed_seen.contains(&path)
                        && (changed.len() >= MAX_CHANGED
                            || output_bytes.saturating_add(cost) > MAX_OUTPUT_BYTES)
                    {
                        changed_incomplete = true;
                    }
                    push_output(
                        &mut changed,
                        &mut changed_seen,
                        path,
                        MAX_CHANGED,
                        &mut output_bytes,
                    );
                }
            }
        }
    }
    let mut outputs = json!({"files":files,"urls":urls,"changed":changed});
    if changed_incomplete {
        outputs["changedIncomplete"] = Value::Bool(true);
    }
    outputs
}

/// Recheck parsed outputs with filesystem canonicalization outside the SQLite
/// transaction. Existing paths (including symlinks/junctions) must resolve
/// under `cwd`; a not-yet-created leaf is accepted only when its nearest
/// existing ancestor resolves there. URLs are never fetched.
pub(crate) fn validate_files(cwd: &str, outputs: &Value) -> Value {
    let Ok(cwd) = fs::canonicalize(cwd) else {
        return json!({"files":[],"urls":[],"changed":[],"changedIncomplete":true});
    };
    let mut output_bytes = 0;
    let files = validated_list(&cwd, outputs.get("files"), &mut output_bytes);
    let mut urls = Vec::new();
    let mut url_seen = HashSet::new();
    for value in outputs
        .get("urls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(url) = value.as_str().and_then(http_url) {
            push_output(
                &mut urls,
                &mut url_seen,
                url,
                MAX_OUTPUTS,
                &mut output_bytes,
            );
        }
    }
    let changed = validated_changed_list(&cwd, outputs.get("changed"), &mut output_bytes);
    let possibly_changed =
        validated_changed_list(&cwd, outputs.get("possiblyChanged"), &mut output_bytes);
    let (changed_details, details_incomplete) =
        validated_details(&cwd, outputs.get("changedDetails"), &mut output_bytes);
    let possibly_changed_with = validated_strings(
        outputs.get("possiblyChangedWith"),
        MAX_OUTPUTS,
        &mut output_bytes,
    );
    let mut value = json!({"files":files,"urls":urls,"changed":changed});
    if !changed_details.is_empty() {
        value["changedDetails"] = Value::Array(changed_details);
    }
    if !possibly_changed.is_empty() {
        value["possiblyChanged"] = json!(possibly_changed);
    }
    if details_incomplete || outputs.get("changedIncomplete").and_then(Value::as_bool) == Some(true)
    {
        value["changedIncomplete"] = Value::Bool(true);
    }
    if !possibly_changed_with.is_empty() {
        value["possiblyChangedWith"] = json!(possibly_changed_with);
    }
    value
}

/// Normalize a lexical child of the group root. This intentionally does not
/// require that the leaf exists: folder snapshots must retain deleted paths.
pub(crate) fn validated_path(cwd: &str, raw: &str) -> Option<String> {
    authoritative_root_relative(cwd, raw)
}

/// Return visible, user-controlled routing suggestions from explicit request
/// lines beginning with a known member handle. Descriptions are intentionally
/// excluded: when intent is unclear, do not suggest a new provider turn. No
/// suggestion is delivered to an agent automatically.
pub(crate) fn suggestions(body: &str, handles: &[String]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    for line in body.lines().take(4096) {
        let line = line.trim_start();
        let Some(rest) = line.strip_prefix('@') else {
            continue;
        };
        let Some((handle, text)) = suggestion_handle(rest, handles) else {
            continue;
        };
        let text = text
            .trim_start_matches(|c: char| c.is_whitespace() || matches!(c, ':' | ',' | '—'))
            .trim();
        if text.is_empty() || !suggestion_request(text) {
            continue;
        }
        let text = truncate_utf8(text, MAX_SUGGESTION_BYTES);
        if let Some(index) = seen.get(handle) {
            let existing = out[*index]["text"].as_str().unwrap_or_default();
            out[*index]["text"] = Value::String(
                truncate_utf8(&format!("{existing}\n{text}"), MAX_SUGGESTION_BYTES).to_owned(),
            );
        } else if out.len() < MAX_SUGGESTIONS {
            seen.insert(handle.to_owned(), out.len());
            out.push(json!({"handle":handle,"text":text}));
        }
    }
    out
}

fn suggestion_handle<'a, 'b>(rest: &'b str, handles: &'a [String]) -> Option<(&'a str, &'b str)> {
    handles
        .iter()
        .filter_map(|handle| {
            let candidate = rest.get(..handle.len())?;
            let suffix = rest.get(handle.len()..)?;
            (candidate.eq_ignore_ascii_case(handle)
                && suffix
                    .chars()
                    .next()
                    .is_none_or(|next| next.is_whitespace() || matches!(next, ':' | ',' | '—')))
            .then_some((handle.as_str(), suffix))
        })
        .max_by_key(|(handle, _)| handle.len())
}

/// Accept only an unambiguous request for another member to act. Prefixes must
/// lead to an action verb, so descriptions such as "please note" and
/// "should be commended" stay quiet. The short Chinese form is likewise kept
/// to direct action verbs. False positives spend user money.
fn suggestion_request(text: &str) -> bool {
    let english = text.trim_start().to_ascii_lowercase();
    let action = [
        "add ",
        "build ",
        "check ",
        "compare ",
        "create ",
        "fix ",
        "implement ",
        "read ",
        "review ",
        "revise ",
        "run ",
        "test ",
        "update ",
    ];
    let polite = ["please ", "can you ", "could you ", "would you ", "should "]
        .iter()
        .find_map(|prefix| english.strip_prefix(prefix));
    let english = polite.unwrap_or(english.as_str());
    let english = polite
        .and_then(|_| english.strip_prefix("also "))
        .unwrap_or(english);
    action.iter().any(|prefix| english.starts_with(prefix))
        || [
            "请运行",
            "请审查",
            "请检查",
            "请测试",
            "请实施",
            "请修改",
            "请更新",
            "请修复",
            "请阅读",
        ]
        .iter()
        .any(|prefix| text.trim_start().starts_with(prefix))
}

fn push_output(
    out: &mut Vec<String>,
    seen: &mut HashSet<String>,
    value: String,
    limit: usize,
    bytes: &mut usize,
) {
    // Three bytes conservatively cover JSON quotes and a separating comma.
    let cost = value.len().saturating_add(3);
    if out.len() < limit
        && bytes.saturating_add(cost) <= MAX_OUTPUT_BYTES
        && seen.insert(value.clone())
    {
        *bytes += cost;
        out.push(value);
    }
}

fn reply_tokens(body: &str) -> Vec<String> {
    let body = truncate_utf8(body, MAX_SCAN_BYTES);
    let mut tokens = Vec::new();
    let bytes = body.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if index + 2 < bytes.len() && bytes[index] == b']' && bytes[index + 1] == b'(' {
            let start = index + 2;
            if let Some(relative_end) = body[start..].find(')') {
                let token = body[start..start + relative_end]
                    .trim()
                    .trim_matches(['<', '>']);
                let token = if token.len() >= 4
                    && token.as_bytes()[0] == b'/'
                    && token.as_bytes()[1].is_ascii_alphabetic()
                    && token.as_bytes()[2] == b':'
                    && matches!(token.as_bytes()[3], b'/' | b'\\')
                {
                    &token[1..]
                } else {
                    token
                };
                if !token.is_empty() {
                    tokens.push(token.to_owned());
                }
                index = start + relative_end + 1;
                continue;
            }
        }
        if bytes[index] == b'`' {
            let start = index + 1;
            if let Some(relative_end) = body[start..].find('`') {
                let token = &body[start..start + relative_end];
                if explicit_path_candidate(token) || http_url(token).is_some() {
                    tokens.push(token.to_owned());
                }
                index = start + relative_end + 1;
                continue;
            }
        }
        index += 1;
    }
    for line in body.lines() {
        tokens.extend(
            line.split_whitespace()
                .filter(|token| !token.contains("](") && !token.contains('`'))
                .map(clean_token)
                .filter(|token| {
                    http_url(token).is_some()
                        || (!reply_command_line(line)
                            && bare_reply_path(token)
                            && (token.contains(['/', '\\']) || root_output_line(line, token)))
                })
                .map(str::to_owned),
        );
    }
    tokens
}

fn reply_command_line(line: &str) -> bool {
    let line = line.trim_start().to_ascii_lowercase();
    line.contains(" --")
        || line.starts_with("node ")
        || line.starts_with("npm ")
        || line.starts_with("pnpm ")
        || line.starts_with("bun ")
        || line.starts_with("git ")
        || line.starts_with("cargo ")
        || line.starts_with("powershell ")
        || line.starts_with("pwsh ")
}

fn root_output_line(line: &str, token: &str) -> bool {
    let line = line.trim().trim_start_matches(['-', '*', '>']).trim();
    if clean_token(line) == token {
        return true;
    }
    let lower = line.to_ascii_lowercase();
    [
        "created ", "wrote ", "written ", "saved ", "added ", "built ", "path:", "file:",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
}

fn bare_reply_path(token: &str) -> bool {
    if token.starts_with('-')
        || token.starts_with('.') && !token.starts_with("./") && !token.starts_with(".\\")
        || token.contains("//")
    {
        return false;
    }
    let has_separator = token.contains(['/', '\\']);
    let name = token.rsplit(['/', '\\']).next().unwrap_or(token);
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && !extension.is_empty()
        && extension.len() <= 16
        && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
        && (has_separator || known_root_extension(extension))
        && !token.contains([';', '|', '='])
}

fn explicit_path_candidate(token: &str) -> bool {
    !token.chars().any(char::is_control) && !token.contains(" --") && bare_reply_path(token)
}

fn known_root_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "html"
            | "htm"
            | "md"
            | "markdown"
            | "txt"
            | "json"
            | "yaml"
            | "yml"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "cjs"
            | "mjs"
            | "css"
            | "rs"
            | "py"
            | "java"
            | "go"
            | "c"
            | "cpp"
            | "h"
            | "hpp"
            | "cs"
            | "sh"
            | "ps1"
            | "toml"
            | "xml"
            | "csv"
            | "pdf"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "svg"
            | "webp"
    )
}

fn clean_token(token: &str) -> &str {
    token
        .trim_matches(|c: char| {
            matches!(
                c,
                '`' | '"'
                    | '\''
                    | '<'
                    | '>'
                    | '('
                    | ')'
                    | '['
                    | ']'
                    | '{'
                    | '}'
                    | ','
                    | ';'
                    | '!'
                    | '?'
            )
        })
        .trim_end_matches('.')
}

fn http_url(token: &str) -> Option<String> {
    let token = clean_token(token);
    let lower = token.get(..8).unwrap_or(token).to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://"))
        || token.len() > 8 * 1024
        || token.chars().any(char::is_control)
    {
        return None;
    }
    let rest = token.split_once("://")?.1;
    (!rest.is_empty() && !rest.starts_with('/') && !rest.chars().any(char::is_whitespace))
        .then(|| token.to_owned())
}

fn root_relative(cwd: &str, raw: &str) -> Option<String> {
    let raw = clean_token(raw);
    if raw.is_empty()
        || raw.len() > MAX_PATH_BYTES
        || raw.chars().any(char::is_control)
        || raw.contains("//") && !raw.starts_with("//?")
    {
        return None;
    }
    if http_url(raw).is_some() || raw.starts_with('@') || !looks_like_path(raw) {
        return None;
    }
    let (cwd_root, cwd_parts, cwd_absolute) = lexical_parts(cwd)?;
    if !cwd_absolute {
        return None;
    }
    let drive_path;
    let raw = if cwd_root.len() == 2
        && cwd_root.as_bytes()[1] == b':'
        && raw.len() >= 3
        && raw.as_bytes()[0] == b'/'
        && raw.as_bytes()[1].eq_ignore_ascii_case(&cwd_root.as_bytes()[0])
        && matches!(raw.as_bytes()[2], b'/' | b'\\')
    {
        drive_path = format!("{cwd_root}{}", &raw[2..]);
        drive_path.as_str()
    } else {
        raw
    };
    let (path_root, path_parts, absolute) = lexical_parts(raw)?;
    let absolute_parts = if absolute {
        if path_root != cwd_root || !path_parts.starts_with(&cwd_parts) {
            return None;
        }
        path_parts
    } else {
        let mut joined = cwd_parts.clone();
        for part in path_parts {
            if part == ".." {
                if joined.len() == cwd_parts.len() {
                    return None;
                }
                joined.pop();
            } else {
                joined.push(part);
            }
        }
        joined
    };
    let relative = &absolute_parts[cwd_parts.len()..];
    (!relative.is_empty()).then(|| relative.join("/"))
}

/// Normalize a path reported by the trusted folder snapshot. Unlike reply and
/// tool prose, a manifest may contain extensionless or punctuation-only names.
/// This remains lexical; callers that surface the path also require a safe
/// canonical existing ancestor.
fn authoritative_root_relative(cwd: &str, raw: &str) -> Option<String> {
    if raw.is_empty()
        || raw.len() > MAX_PATH_BYTES
        || raw.chars().any(char::is_control)
        || raw.contains("//") && !raw.starts_with("//?")
    {
        return None;
    }
    let (cwd_root, cwd_parts, cwd_absolute) = lexical_parts(cwd)?;
    if !cwd_absolute {
        return None;
    }
    let drive_path;
    let raw = if cwd_root.len() == 2
        && cwd_root.as_bytes()[1] == b':'
        && raw.len() >= 3
        && raw.as_bytes()[0] == b'/'
        && raw.as_bytes()[1].eq_ignore_ascii_case(&cwd_root.as_bytes()[0])
        && matches!(raw.as_bytes()[2], b'/' | b'\\')
    {
        drive_path = format!("{cwd_root}{}", &raw[2..]);
        drive_path.as_str()
    } else {
        raw
    };
    let (path_root, path_parts, absolute) = lexical_parts(raw)?;
    let absolute_parts = if absolute {
        if path_root != cwd_root || !path_parts.starts_with(&cwd_parts) {
            return None;
        }
        path_parts
    } else {
        let mut joined = cwd_parts.clone();
        for part in path_parts {
            if part == ".." {
                if joined.len() == cwd_parts.len() {
                    return None;
                }
                joined.pop();
            } else {
                joined.push(part);
            }
        }
        joined
    };
    let relative = &absolute_parts[cwd_parts.len()..];
    (!relative.is_empty()).then(|| relative.join("/"))
}

fn looks_like_path(value: &str) -> bool {
    if !value.contains(['/', '\\'])
        && value.strip_prefix('~').is_some_and(|bare| {
            bare.split_once('.').is_some_and(|(stem, extension)| {
                !stem.is_empty()
                    && !extension.is_empty()
                    && stem.bytes().all(|byte| byte.is_ascii_digit())
                    && extension.bytes().all(|byte| byte.is_ascii_digit())
            })
        })
    {
        return false;
    }
    value.contains(['/', '\\'])
        || value.starts_with('.')
        || value.rsplit('/').next().unwrap_or(value).contains('.')
}

/// Returns `(root, components, is_absolute)`. Components stay lexical; this
/// intentionally cannot promise containment through symlinks or junctions.
fn lexical_parts(value: &str) -> Option<(String, Vec<String>, bool)> {
    let mut value = value.trim().replace('\\', "/");
    // `canonicalize` emits this Windows verbatim prefix. It is normalized only
    // for lexical comparison; all security-sensitive resolution stays in std::fs.
    if let Some(stripped) = value.strip_prefix("//?/") {
        value = stripped.to_owned();
    }
    if value.is_empty() || value.starts_with("//") {
        return None;
    }
    let (root, rest, absolute) = if value.starts_with('/') {
        ("/".to_owned(), value.trim_start_matches('/'), true)
    } else if value.len() >= 3
        && value.as_bytes()[0].is_ascii_alphabetic()
        && value.as_bytes()[1] == b':'
        && value.as_bytes()[2] == b'/'
    {
        (
            format!("{}:", value.as_bytes()[0] as char).to_ascii_lowercase(),
            &value[3..],
            true,
        )
    } else {
        (String::new(), value.as_str(), false)
    };
    let mut parts = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." if absolute => {
                parts.pop()?;
            }
            ".." => parts.push("..".to_owned()),
            part if part.contains(':') => return None,
            part => parts.push(part.to_owned()),
        }
    }
    Some((root, parts, absolute))
}

fn is_edit_tool(part: &Value) -> bool {
    if part.get("type").and_then(Value::as_str) != Some("tool") {
        return false;
    }
    let data = part.get("data").unwrap_or(&Value::Null);
    let name = [
        part.get("toolName"),
        data.get("name"),
        data.get("tool"),
        data.get("type"),
        data.pointer("/state/tool"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .collect::<Vec<_>>()
    .join(" ")
    .to_ascii_lowercase();
    [
        "write",
        "edit",
        "patch",
        "create",
        "replace",
        "delete",
        "filechange",
        "file_change",
        "writing",
    ]
    .iter()
    .any(|word| name.contains(word))
        || (is_command_execution(part) && command_writes_files(part))
}

fn tool_succeeded(part: &Value) -> bool {
    let statuses = [part.get("status"), part.pointer("/data/status")];
    ![
        part.get("error"),
        part.pointer("/result/isError"),
        part.pointer("/data/error"),
        part.pointer("/data/isError"),
        part.pointer("/data/is_error"),
        part.pointer("/data/result/isError"),
    ]
    .into_iter()
    .flatten()
    .any(|value| !value.is_null() && value.as_bool() != Some(false))
        && part
            .pointer("/data/exitCode")
            .and_then(Value::as_i64)
            .is_none_or(|code| code == 0)
        && !statuses.iter().flatten().any(|status| {
            matches!(
                status.as_str(),
                Some("failed" | "error" | "cancelled" | "canceled")
            )
        })
        && statuses.iter().flatten().any(|status| {
            matches!(
                status.as_str(),
                Some("complete" | "completed" | "succeeded" | "success")
            )
        })
}

fn command_writes_files(part: &Value) -> bool {
    command_texts(part)
        .into_iter()
        .any(|command| command_may_write(command))
}

fn tool_paths(part: &Value) -> Vec<String> {
    if is_command_execution(part) {
        return command_mutation_paths(part);
    }
    let mut paths = Vec::new();
    if let Some(references) = part.get("fileReferences").and_then(Value::as_array) {
        paths.extend(
            references
                .iter()
                .filter_map(|value| value.get("path").and_then(Value::as_str))
                .map(str::to_owned),
        );
    }
    let mut remaining = 512;
    collect_paths(
        part.get("data").unwrap_or(&Value::Null),
        &mut paths,
        &mut remaining,
    );
    paths
}

/// Whether this turn could have mutated an unclaimed path. Group attribution
/// uses this conservative signal only while another delivery overlaps: a
/// command/shell may write through an arbitrary program, whereas a completed
/// file-edit tool with concrete targets cannot claim unrelated folder changes.
pub(crate) fn could_write_unclaimed(items: &[ChatItem]) -> bool {
    items.iter().flat_map(|item| &item.parts).any(|part| {
        if !is_tool_part(part) || is_command_execution(part) {
            return is_tool_part(part) && is_command_execution(part);
        }
        if !tool_succeeded(part) || known_nonwriting_tool(part) {
            return false;
        }
        let paths = tool_paths(part);
        paths.is_empty() || paths.len() >= MAX_CHANGED || !is_edit_tool(part)
    })
}

/// Successful command-tool destinations, normalized under `cwd`. Attribution
/// can mark one of these as folder evidence after the completion snapshot
/// confirms it, while ordinary file-edit tools remain direct tool evidence.
pub(crate) fn command_claims(cwd: &str, items: &[ChatItem]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut bytes = 0;
    for part in items.iter().flat_map(|item| &item.parts) {
        if !is_command_execution(part) || !tool_succeeded(part) {
            continue;
        }
        for raw in command_mutation_paths(part) {
            if let Some(path) = authoritative_root_relative(cwd, &raw) {
                push_output(&mut out, &mut seen, path, MAX_CHANGED, &mut bytes);
            }
        }
    }
    out
}

fn is_command_execution(part: &Value) -> bool {
    [part.get("toolName"), part.pointer("/data/type")]
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|name| {
            matches!(
                name.to_ascii_lowercase().as_str(),
                "commandexecution"
                    | "bash"
                    | "shell"
                    | "run_shell_command"
                    | "exec_command"
                    | "execute"
                    | "execute_command"
            )
        })
}

fn is_tool_part(part: &Value) -> bool {
    part.get("type").and_then(Value::as_str) == Some("tool")
}

fn known_nonwriting_tool(part: &Value) -> bool {
    let name = [
        part.get("toolName"),
        part.pointer("/data/name"),
        part.pointer("/data/type"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .collect::<Vec<_>>()
    .join(" ")
    .to_ascii_lowercase();
    [
        "read", "search", "find", "grep", "glob", "list", "plan", "query", "inspect",
    ]
    .iter()
    .any(|word| name.contains(word))
}

/// Extract only command arguments that name the destination of a known
/// PowerShell file mutator. Command output is useful when available, but Codex
/// may omit it for a successful here-string write.
fn command_mutation_paths(part: &Value) -> Vec<String> {
    command_texts(part)
        .into_iter()
        .flat_map(command_mutation_paths_text)
        .take(MAX_CHANGED)
        .collect()
}

fn command_texts(part: &Value) -> Vec<&str> {
    let Some(data) = part.get("data") else {
        return Vec::new();
    };
    let mut commands = data
        .get("commandActions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|action| action.get("command").and_then(Value::as_str))
        .take(16)
        .collect::<Vec<_>>();
    if commands.is_empty() {
        commands.extend(data.get("command").and_then(Value::as_str));
        commands.extend(data.pointer("/input/command").and_then(Value::as_str));
        commands.extend(part.pointer("/input/command").and_then(Value::as_str));
    }
    commands
}

fn command_mutation_paths_text(command: &str) -> Vec<String> {
    let mut paths = power_shell_mutation_paths(command);
    paths.extend(bash_mutation_paths(command));
    paths
}

fn command_may_write(command: &str) -> bool {
    let lower = truncate_utf8(command, MAX_SCAN_BYTES).to_ascii_lowercase();
    [
        "set-content",
        "add-content",
        "out-file",
        "write-file",
        "new-item",
        "copy-item",
        "move-item",
        "[io.file]::writeall",
        "[system.io.file]::writeall",
        " tee ",
        "cat >",
        "cp ",
        "mv ",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
        || lower
            .split_whitespace()
            .any(|word| matches!(word, ">" | ">>"))
}

fn power_shell_mutation_paths(command: &str) -> Vec<String> {
    let command = truncate_utf8(command, MAX_SCAN_BYTES);
    let segments = power_shell_segments(command);
    let mut variables = HashMap::new();
    for segment in &segments {
        if let Some((name, value)) = power_shell_assignment(segment, &variables) {
            variables.insert(name, value);
        }
    }
    let mut paths = Vec::new();
    for segment in segments {
        let tokens = power_shell_words(segment);
        // Mutators must be the segment command. Do not treat a command-shaped
        // string passed to Write-Output as evidence of a write.
        let mutator = tokens.first().map(|token| token.to_ascii_lowercase());
        if mutator.as_deref().is_some_and(|token| {
            matches!(
                token,
                "set-content"
                    | "add-content"
                    | "out-file"
                    | "write-file"
                    | "new-item"
                    | "copy-item"
                    | "move-item"
            )
        }) && (mutator.as_deref() != Some("new-item") || power_shell_new_file(&tokens[1..]))
        {
            paths.extend(power_shell_target(&tokens[1..], &variables));
        }
        if let Some(index) = tokens
            .iter()
            .position(|token| token.eq_ignore_ascii_case("-destination"))
        {
            if let Some(target) = tokens
                .get(index + 1)
                .and_then(|value| power_shell_value(value, &variables))
            {
                paths.push(target);
            }
        }
        for index in 0..tokens.len().saturating_sub(1) {
            if matches!(tokens[index].as_str(), ">" | ">>") {
                if let Some(target) = power_shell_value(&tokens[index + 1], &variables) {
                    paths.push(target);
                }
            }
        }
        if segment.to_ascii_lowercase().contains("[io.file]::")
            || segment.to_ascii_lowercase().contains("[system.io.file]::")
        {
            if let Some(arguments) = segment
                .split_once('(')
                .and_then(|(_, rest)| rest.split_once(')').map(|(args, _)| args))
            {
                if let Some(first) = arguments
                    .split(',')
                    .next()
                    .and_then(|value| power_shell_value(value.trim(), &variables))
                {
                    paths.push(first);
                }
            }
        }
    }
    paths
}

fn power_shell_new_file(tokens: &[String]) -> bool {
    tokens.windows(2).any(|pair| {
        pair[0].eq_ignore_ascii_case("-itemtype") && pair[1].eq_ignore_ascii_case("file")
    })
}

fn power_shell_segments(command: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    let mut here_end: Option<&str> = None;
    let bytes = command.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if let Some(end) = here_end {
            if bytes[index..].starts_with(end.as_bytes()) {
                index += end.len();
                here_end = None;
                start = index;
                continue;
            }
            index += 1;
            continue;
        }
        if bytes[index] == b'@'
            && index + 1 < bytes.len()
            && matches!(bytes[index + 1], b'\'' | b'"')
            && (index == 0
                || matches!(bytes[index - 1], b' ' | b'\t' | b';' | b'|' | b'\n' | b'\r'))
        {
            if start < index {
                segments.push(&command[start..index]);
            }
            here_end = Some(if bytes[index + 1] == b'\'' {
                "'@"
            } else {
                "\"@"
            });
            index += 2;
            start = index;
            continue;
        }
        if bytes[index] == b'\'' {
            quoted = !quoted;
        } else if !quoted && matches!(bytes[index], b';' | b'|' | b'\n' | b'\r') {
            segments.push(&command[start..index]);
            start = index + 1;
        }
        index += 1;
    }
    segments.push(&command[start..]);
    segments
}

fn power_shell_words(segment: &str) -> Vec<String> {
    segment
        .split_whitespace()
        .map(|word| word.trim_matches(['\'', '"']))
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

fn power_shell_target(tokens: &[String], variables: &HashMap<String, String>) -> Vec<String> {
    let mut paths = Vec::new();
    let mut positional = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        let flag = token.to_ascii_lowercase();
        if matches!(flag.as_str(), "-path" | "-literalpath" | "-filepath") {
            if let Some(path) = tokens
                .get(index + 1)
                .and_then(|path| power_shell_value(path, variables))
            {
                paths.push(path);
            }
            index += 2;
        } else if flag.starts_with('-') {
            index += usize::from(!matches!(
                flag.as_str(),
                "-nonewline" | "-force" | "-append" | "-whatif" | "-confirm"
            )) + 1;
        } else {
            positional.push(token);
            index += 1;
        }
    }
    if paths.is_empty() {
        if let Some(path) = positional
            .into_iter()
            .rev()
            .find(|path| looks_like_path(path))
        {
            if let Some(path) = power_shell_value(&path, variables) {
                paths.push(path);
            }
        }
    }
    paths
}

fn power_shell_assignment(
    segment: &str,
    variables: &HashMap<String, String>,
) -> Option<(String, String)> {
    let (name, value) = segment.split_once('=')?;
    let name = name.trim().strip_prefix('$')?.trim();
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return None;
    }
    power_shell_value(value.trim(), variables).map(|value| (name.to_ascii_lowercase(), value))
}

fn power_shell_value(value: &str, variables: &HashMap<String, String>) -> Option<String> {
    let value = value.trim().trim_matches(['\'', '"']);
    if let Some(name) = value.strip_prefix('$') {
        return variables.get(&name.to_ascii_lowercase()).cloned();
    }
    let words = power_shell_words(value);
    if words
        .first()
        .is_some_and(|word| word.eq_ignore_ascii_case("join-path"))
    {
        let mut values = words.into_iter().skip(1);
        let base = values.next()?;
        if !(base.eq_ignore_ascii_case("$pwd") || base.eq_ignore_ascii_case("${pwd}")) {
            return None;
        }
        let child_value = values.next()?;
        let child = child_value.trim_matches(['\'', '"']);
        return (!child.is_empty() && !child.contains('$')).then(|| child.replace('\\', "/"));
    }
    (!value.is_empty() && !value.contains(['$', ';', '|', '\n', '\r'])).then(|| value.to_owned())
}

fn bash_mutation_paths(command: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for segment in command.split([';', '\n', '\r', '|']).take(128) {
        let words = segment.split_whitespace().collect::<Vec<_>>();
        for index in 0..words.len().saturating_sub(1) {
            if matches!(words[index], ">" | ">>") {
                paths.push(words[index + 1].trim_matches(['\'', '"']).to_owned());
            }
        }
        if let Some(index) = words.iter().position(|word| *word == "tee") {
            if let Some(path) = words.get(index + 1) {
                paths.push(path.trim_matches(['\'', '"']).to_owned());
            }
        }
        if words
            .first()
            .is_some_and(|word| matches!(*word, "cp" | "mv"))
        {
            if let Some(path) = words.iter().rev().find(|word| !word.starts_with('-')) {
                paths.push(path.trim_matches(['\'', '"']).to_owned());
            }
        }
    }
    paths
}

fn collect_paths(value: &Value, out: &mut Vec<String>, remaining: &mut usize) {
    if *remaining == 0 || out.len() >= MAX_CHANGED {
        return;
    }
    *remaining -= 1;
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if matches!(
                    key.as_str(),
                    "path" | "filePath" | "file_path" | "filepath" | "filename" | "fileName"
                ) {
                    if let Some(path) = child.as_str() {
                        out.push(path.to_owned());
                    }
                }
                if matches!(key.as_str(), "rawOutput" | "aggregatedOutput") {
                    if let Some(text) = child.as_str() {
                        out.extend(
                            text.split_whitespace()
                                .map(clean_token)
                                .filter(|token| looks_like_path(token))
                                .map(str::to_owned),
                        );
                    }
                }
                collect_paths(child, out, remaining);
                if *remaining == 0 || out.len() >= MAX_CHANGED {
                    break;
                }
            }
        }
        Value::Array(values) => {
            for child in values.iter().take(128) {
                collect_paths(child, out, remaining);
                if *remaining == 0 || out.len() >= MAX_CHANGED {
                    break;
                }
            }
        }
        _ => {}
    }
}

fn truncate_utf8(value: &str, limit: usize) -> &str {
    if value.len() <= limit {
        return value;
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn validated_list(cwd: &Path, values: Option<&Value>, bytes: &mut usize) -> Vec<String> {
    let cwd_text = cwd.to_string_lossy();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for raw in values
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let Some(relative) = root_relative(&cwd_text, raw) else {
            continue;
        };
        if safe_existing_ancestor(cwd, &relative) {
            push_output(&mut out, &mut seen, relative, MAX_OUTPUTS, bytes);
        }
    }
    out
}

fn validated_changed_list(cwd: &Path, values: Option<&Value>, bytes: &mut usize) -> Vec<String> {
    let cwd_text = cwd.to_string_lossy();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for raw in values
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let Some(relative) = authoritative_root_relative(&cwd_text, raw) else {
            continue;
        };
        if safe_existing_ancestor(cwd, &relative) {
            push_output(&mut out, &mut seen, relative, MAX_OUTPUTS, bytes);
        }
    }
    out
}

fn validated_details(cwd: &Path, values: Option<&Value>, bytes: &mut usize) -> (Vec<Value>, bool) {
    let cwd_text = cwd.to_string_lossy();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut incomplete = false;
    for value in values.and_then(Value::as_array).into_iter().flatten() {
        let Some(path) = value.get("path").and_then(Value::as_str) else {
            continue;
        };
        let Some(path) = authoritative_root_relative(&cwd_text, path) else {
            continue;
        };
        if !safe_existing_ancestor(cwd, &path) || !seen.insert(path.clone()) {
            continue;
        }
        let status = value.get("status").and_then(Value::as_str);
        let evidence = value.get("evidence").and_then(Value::as_str);
        if !matches!(status, Some("added" | "modified" | "deleted" | "changed"))
            || !matches!(evidence, Some("tool" | "folder"))
        {
            continue;
        }
        let detail = json!({"path":path,"status":status,"evidence":evidence});
        let cost = detail.to_string().len().saturating_add(1);
        if out.len() >= MAX_CHANGED || bytes.saturating_add(cost) > MAX_OUTPUT_BYTES {
            incomplete = true;
            break;
        }
        *bytes += cost;
        out.push(detail);
    }
    (out, incomplete)
}

fn validated_strings(values: Option<&Value>, limit: usize, bytes: &mut usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for value in values
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .take(limit)
    {
        if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
            continue;
        }
        push_output(&mut out, &mut seen, value.to_owned(), limit, bytes);
    }
    out
}

fn safe_existing_ancestor(cwd: &Path, relative: &str) -> bool {
    let path = Path::new(relative);
    if path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return false;
    }
    let mut candidate = cwd.join(path);
    let mut tail: Vec<OsString> = Vec::new();
    while !candidate.exists() {
        let Some(name) = candidate.file_name().map(OsString::from) else {
            return false;
        };
        tail.push(name);
        let Some(parent) = candidate.parent() else {
            return false;
        };
        candidate = parent.to_path_buf();
    }
    let Ok(ancestor) = fs::canonicalize(&candidate) else {
        return false;
    };
    if !ancestor.starts_with(cwd) {
        return false;
    }
    // `tail` consists only of syntactically-normalized, relative components.
    // Do not create or inspect it here; this is an extraction-time guard only.
    let _future = tail
        .into_iter()
        .rev()
        .fold(ancestor, |path, part| path.join(part));
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(turn: &str, part: Value) -> ChatItem {
        serde_json::from_value(
            json!({"id":"item","role":"assistant","parts":[part],"createdAt":"now","turnId":turn}),
        )
        .unwrap()
    }

    #[test]
    fn extracts_markdown_and_bare_reply_outputs_without_escape_or_unsafe_urls() {
        let root = tempfile::tempdir().unwrap();
        let outputs = output(
            &root.path().to_string_lossy(),
            "Built [page](design/page.html), docs/readme.md and https://example.test/view. [bad](../secret.txt) ftp://bad.test\nCommand: node --test test/slugify.test.cjs (.trim and 0.847ms)",
            &[],
            &[],
        );
        assert_eq!(
            outputs["files"],
            json!(["design/page.html", "docs/readme.md"])
        );
        assert_eq!(outputs["urls"], json!(["https://example.test/view"]));
        assert_eq!(outputs["changed"], json!([]));
    }

    #[test]
    fn accepts_absolute_paths_only_under_group_folder_lexically() {
        let root = tempfile::tempdir().unwrap();
        let inside = root.path().join("a/../a/page.md");
        let outside = root.path().parent().unwrap().join("outside.md");
        let body = format!(
            "[in]({}) [out]({}) ../../no.md",
            inside.display(),
            outside.display()
        );
        let outputs = output(&root.path().to_string_lossy(), &body, &[], &[]);
        assert_eq!(outputs["files"], json!(["a/page.md"]));
        if cfg!(windows) {
            let href = format!("[in](/{} )", inside.display());
            let outputs = output(&root.path().to_string_lossy(), &href, &[], &[]);
            assert_eq!(outputs["files"], json!(["a/page.md"]));
            let native = inside.to_string_lossy().replace('\\', "/");
            let bash_path = format!("/{}{}", native.as_bytes()[0] as char, &native[2..]);
            let written = item(
                "delivery",
                json!({"type":"tool","toolName":"Write","status":"complete","fileReferences":[{"path":bash_path}]}),
            );
            let outputs = output(
                &root.path().to_string_lossy(),
                &format!("`{bash_path}`"),
                &[written],
                &[],
            );
            assert_eq!(outputs["files"], json!(["a/page.md"]));
            assert_eq!(outputs["changed"], json!(["a/page.md"]));
        }
    }

    #[test]
    fn reply_candidates_keep_paths_and_urls_but_reject_commands_and_expressions() {
        let root = tempfile::tempdir().unwrap();
        let outputs = output(
            &root.path().to_string_lossy(),
            "Path: pages/a/index.html\n`docs/设计 文件（v1）.md` `index.html`\n`node --test test/slugify.test.cjs` `str.trim()` `module.exports` `str.replace(/x/g, '')`\nUses only Node.js built-in modules. 0.847ms 76.4168 leading/trailing\nhttps://example.test/view",
            &[],
            &[],
        );
        let files = outputs["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<HashSet<_>>();
        assert_eq!(
            files,
            HashSet::from([
                "pages/a/index.html",
                "docs/设计 文件（v1）.md",
                "index.html"
            ])
        );
        assert_eq!(outputs["urls"], json!(["https://example.test/view"]));
    }

    #[test]
    fn changed_paths_require_an_edit_tool_and_the_callers_turn_slice() {
        let root = tempfile::tempdir().unwrap();
        let read = item(
            "other",
            json!({"type":"tool","toolName":"Read","fileReferences":[{"path":"src/read.rs"}]}),
        );
        let write = item(
            "delivery",
            json!({"type":"tool","toolName":"Write","status":"completed","data":{"input":{"file_path":"src/written.rs"}},"fileReferences":[{"path":"src/also.rs"}]}),
        );
        let outputs = output(&root.path().to_string_lossy(), "", &[read, write], &[]);
        assert_eq!(outputs["changed"], json!(["src/also.rs", "src/written.rs"]));
    }

    #[test]
    fn concrete_tool_targets_keep_root_extensionless_and_punctuated_names() {
        let root = tempfile::tempdir().unwrap();
        let write = item(
            "delivery",
            json!({"type":"tool","toolName":"Write","status":"completed","fileReferences":[{"path":"LICENSE"},{"path":"notes."}]}),
        );
        let outputs = output(&root.path().to_string_lossy(), "", &[write.clone()], &[]);
        assert_eq!(outputs["changed"], json!(["LICENSE", "notes."]));
        assert_eq!(
            command_claims(
                &root.path().to_string_lossy(),
                &[item(
                    "delivery",
                    json!({"type":"tool","toolName":"Bash","status":"completed","data":{"command":"printf ok > LICENSE"}}),
                )]
            ),
            vec!["LICENSE"]
        );
    }

    #[test]
    fn changed_paths_require_successful_edits_and_accept_native_write_shapes() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().to_string_lossy();
        let claude_denied = item(
            "delivery",
            json!({"type":"tool","toolName":"Write","status":"failed","fileReferences":[{"path":"pages/claude/index.html"}]}),
        );
        let codex_failed = item(
            "delivery",
            json!({"type":"tool","toolName":"fileChange","status":"failed","data":{"status":"failed","changes":[{"path":"pages/codex/attempt.html"}]}}),
        );
        let error_shaped = item(
            "delivery",
            json!({"type":"tool","toolName":"Write","status":"completed","data":{"is_error":true},"fileReferences":[{"path":"pages/error/index.html"}]}),
        );
        let kimi_written = item(
            "delivery",
            json!({"type":"tool","toolName":format!("Writing {}/pages/kimi/index.html", cwd),"status":"complete","data":{"status":"completed"},"fileReferences":[{"path":format!("{}/pages/kimi/index.html", cwd)}]}),
        );
        let codex_written = item(
            "delivery",
            json!({"type":"tool","toolName":"commandExecution","status":"completed","data":{"status":"completed","command":"Set-Content pages/codex/index.html","aggregatedOutput":format!("{}/pages/codex/index.html", cwd)}}),
        );
        let command_stdout_mentions_future_paths = item(
            "delivery",
            json!({"type":"tool","toolName":"commandExecution","status":"completed","data":{"status":"completed","command":"Set-Content -Path docs/design.md","aggregatedOutput":"Read docs/design.md; future src/slugify.cjs and test/slugify.test.cjs"}}),
        );
        let codex_here_string = item(
            "delivery",
            json!({"type":"tool","toolName":"commandExecution","status":"completed","data":{"status":"completed","exitCode":0,"command":"pwsh -Command \"Set-Content pages/codex/here.html\"","commandActions":[{"command":"New-Item -ItemType Directory -Path pages/codex -Force | Out-Null; @'\n<html>Set-Content pages/codex/not-a-command.html</html>\n'@ | Set-Content -Encoding utf8 pages/codex/here.html","type":"unknown"}]}}),
        );
        let quoted_mutation_text = item(
            "delivery",
            json!({"type":"tool","toolName":"commandExecution","status":"completed","data":{"status":"completed","command":"Set-Content -Path pages/codex/written.html -Value 'Set-Content pages/codex/printed.html'"}}),
        );
        let quoted_read = item(
            "delivery",
            json!({"type":"tool","toolName":"commandExecution","status":"completed","data":{"status":"completed","command":"pwsh -Command \"Get-Content -Raw 'Set-Content pages/codex/quoted.html'\"","aggregatedOutput":format!("{}/pages/codex/quoted.html", cwd)}}),
        );
        let failed_command = item(
            "delivery",
            json!({"type":"tool","toolName":"commandExecution","status":"completed","data":{"status":"completed","exitCode":1,"command":"Set-Content pages/codex/failed.html","aggregatedOutput":format!("{}/pages/codex/failed.html", cwd)}}),
        );
        let outputs = output(
            &cwd,
            "路径: `pages/kimi/index.html`（位于共享目录） and `docs/设计 文件（v1）.md` Size ~4.8 KB",
            &[
                claude_denied,
                codex_failed,
                error_shaped,
                kimi_written,
                codex_written,
                command_stdout_mentions_future_paths,
                codex_here_string,
                quoted_mutation_text,
                quoted_read,
                failed_command,
            ],
            &[],
        );
        assert_eq!(
            outputs["files"],
            json!(["pages/kimi/index.html", "docs/设计 文件（v1）.md"])
        );
        assert_eq!(
            outputs["changed"],
            json!([
                "pages/kimi/index.html",
                "pages/codex/index.html",
                "docs/design.md",
                "pages/codex/here.html",
                "pages/codex/written.html"
            ])
        );
    }

    #[test]
    fn exposes_only_explicit_known_member_requests_once_per_handle() {
        let got = suggestions(
            "@codex Run tests\n@codex Please also check the accessibility\ntext @claude no\n@unknown Ignore\n@claude: Review the page\n@claude created a thoughtfully designed page",
            &["codex".into(), "claude".into()],
        );
        assert_eq!(
            json!(got),
            json!([{"handle":"codex","text":"Run tests\nPlease also check the accessibility"},{"handle":"claude","text":"Review the page"}])
        );
    }

    #[test]
    fn descriptions_and_ambiguous_member_mentions_never_suggest_a_turn() {
        let got = suggestions(
            "@codex created a thoughtfully designed page\n@claude's implementation is complete\n@codex: the page now has a hero\n@claude maybe review it",
            &["codex".into(), "claude".into()],
        );
        assert_eq!(got, Vec::<Value>::new());
    }

    #[test]
    fn repeated_handles_and_polite_descriptions_remain_unambiguous() {
        let got = suggestions(
            "@codex-2 Please review the page\n@codex should be commended\n@codex please note the page exists\n@codex-2 请测试实现",
            &["codex".into(), "codex-2".into()],
        );
        assert_eq!(
            json!(got),
            json!([{"handle":"codex-2","text":"Please review the page\n请测试实现"}])
        );
    }

    #[test]
    fn canonical_validation_keeps_existing_and_safe_nonexistent_paths() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("safe")).unwrap();
        fs::write(root.path().join("safe/existing.txt"), "ok").unwrap();
        let raw = json!({"files":["safe/existing.txt","safe/future.txt","../escape.txt"],"urls":["https://example.test/a","file:///unsafe"],"changed":["safe/existing.txt"]});
        let checked = validate_files(&root.path().to_string_lossy(), &raw);
        assert_eq!(
            checked["files"],
            json!(["safe/existing.txt", "safe/future.txt"])
        );
        assert_eq!(checked["changed"], json!(["safe/existing.txt"]));
        assert_eq!(checked["urls"], json!(["https://example.test/a"]));
    }

    #[test]
    fn trusted_folder_paths_keep_extensionless_and_punctuated_names() {
        let root = tempfile::tempdir().unwrap();
        let raw = json!({
            "files":["LICENSE"], "urls":[],
            "changed":["LICENSE","notes.","weird[name].txt","../escape"],
            "possiblyChanged":["Makefile","foo","/outside"],
            "changedDetails":[
                {"path":"LICENSE","status":"modified","evidence":"folder"},
                {"path":"notes.","status":"added","evidence":"folder"},
                {"path":"weird[name].txt","status":"deleted","evidence":"folder"}
            ]
        });
        let checked = validate_files(&root.path().to_string_lossy(), &raw);
        assert_eq!(checked["files"], json!([]), "reply prose remains heuristic");
        assert_eq!(
            checked["changed"],
            json!(["LICENSE", "notes.", "weird[name].txt"])
        );
        assert_eq!(checked["possiblyChanged"], json!(["Makefile", "foo"]));
        assert_eq!(checked["changedDetails"].as_array().unwrap().len(), 3);
        assert_eq!(
            validated_path(&root.path().to_string_lossy(), "LICENSE"),
            Some("LICENSE".into())
        );
        assert_eq!(
            validated_path(&root.path().to_string_lossy(), "../escape"),
            None
        );
    }

    #[test]
    fn folder_detail_budget_marks_the_snapshot_incomplete() {
        let root = tempfile::tempdir().unwrap();
        let details = (0..MAX_CHANGED)
            .map(|index| json!({"path":format!("{index:02}-{}", "x".repeat(3_500)),"status":"modified","evidence":"folder"}))
            .collect::<Vec<_>>();
        let checked = validate_files(
            &root.path().to_string_lossy(),
            &json!({"files":[],"urls":[],"changed":[],"changedDetails":details}),
        );
        assert_eq!(checked["changedIncomplete"], true);
        assert!(checked["changedDetails"].as_array().unwrap().len() < MAX_CHANGED);
    }

    #[cfg(unix)]
    #[test]
    fn trusted_folder_paths_reject_an_outside_symlink_ancestor() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();
        let checked = validate_files(
            &root.path().to_string_lossy(),
            &json!({"files":[],"urls":[],"changed":["escape/secret"]}),
        );
        assert_eq!(checked["changed"], json!([]));
    }

    #[test]
    fn command_extractor_resolves_bounded_powershell_and_bash_destinations() {
        let root = tempfile::tempdir().unwrap();
        let command = item(
            "delivery",
            json!({"type":"tool","toolName":"commandExecution","status":"completed","data":{"type":"commandExecution","status":"completed","command":"$p = 'pages/codex/index.html'; Set-Content -Path $p 'ok'; $q = Join-Path $PWD 'pages/codex/io.txt'; [IO.File]::WriteAllText($q, 'ok'); 'copy' | Out-File -FilePath pages/codex/out.txt; Copy-Item a -Destination pages/codex/copied.txt; x > pages/codex/redirect.txt"}}),
        );
        let outputs = output(&root.path().to_string_lossy(), "", &[command], &[]);
        assert_eq!(
            outputs["changed"],
            json!([
                "pages/codex/index.html",
                "pages/codex/io.txt",
                "pages/codex/out.txt",
                "pages/codex/copied.txt",
                "pages/codex/redirect.txt"
            ])
        );
        assert_eq!(
            command_claims(
                &root.path().to_string_lossy(),
                &[item(
                    "delivery",
                    json!({"type":"tool","toolName":"Bash","status":"completed","data":{"command":"printf ok > pages/bash/claimed.txt"}}),
                )]
            ),
            vec!["pages/bash/claimed.txt"]
        );

        let bash = item(
            "delivery",
            json!({"type":"tool","toolName":"commandExecution","status":"completed","data":{"type":"commandExecution","status":"completed","command":"cat > pages/bash/a.txt <<EOF\nignored\nEOF\nprintf ok | tee pages/bash/b.txt\ncp source pages/bash/c.txt\nmv source pages/bash/d.txt"}}),
        );
        let outputs = output(&root.path().to_string_lossy(), "", &[bash], &[]);
        assert_eq!(
            outputs["changed"],
            json!([
                "pages/bash/a.txt",
                "pages/bash/b.txt",
                "pages/bash/c.txt",
                "pages/bash/d.txt"
            ])
        );
    }

    #[test]
    fn command_extractor_never_uses_reads_or_here_string_contents_as_evidence() {
        let root = tempfile::tempdir().unwrap();
        let command = item(
            "delivery",
            json!({"type":"tool","toolName":"commandExecution","status":"completed","data":{"type":"commandExecution","status":"completed","command":"$p = 'pages/read.txt'; Get-Content $p; Test-Path $p; @'\nSet-Content -Path pages/not-a-write.txt\n'@"}}),
        );
        let outputs = output(&root.path().to_string_lossy(), "", &[command.clone()], &[]);
        assert_eq!(outputs["changed"], json!([]));
        assert!(could_write_unclaimed(&[command]));
    }

    #[test]
    fn unclaimed_writer_classifier_is_conservative_for_shells_and_unknown_tools() {
        let command = item(
            "delivery",
            json!({"type":"tool","toolName":"Bash","status":"failed","data":{"command":"false"}}),
        );
        let unknown = item(
            "delivery",
            json!({"type":"tool","toolName":"nativeMutation","status":"completed","data":{"status":"completed"}}),
        );
        let read = item(
            "delivery",
            json!({"type":"tool","toolName":"Read","status":"completed","data":{"status":"completed"}}),
        );
        assert!(could_write_unclaimed(&[command]));
        assert!(could_write_unclaimed(&[unknown]));
        assert!(!could_write_unclaimed(&[read]));
    }

    #[test]
    fn completed_text_and_claimed_acp_edit_do_not_become_unknown_writers() {
        let root = tempfile::tempdir().unwrap();
        let item = item(
            "delivery",
            json!({"type":"tool","toolName":"Write file","status":"complete","data":{"rawInput":{"file_path":"claimed/x.html"},"sessionUpdate":"tool_call_update","status":"completed","title":"Write file"}}),
        );
        let text: ChatItem = serde_json::from_value(json!({"id":"text","role":"assistant","parts":[{"type":"text","status":"complete","text":"finished"}],"createdAt":"now","turnId":"delivery"})).unwrap();
        let outputs = output(
            &root.path().to_string_lossy(),
            "",
            &[item.clone(), text.clone()],
            &[],
        );
        assert_eq!(outputs["changed"], json!(["claimed/x.html"]));
        assert!(!could_write_unclaimed(&[item, text]));
    }

    #[test]
    fn unavailable_root_is_explicitly_incomplete() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("missing");
        let checked = validate_files(
            &missing.to_string_lossy(),
            &json!({"files":[],"urls":[],"changed":[]}),
        );
        assert_eq!(checked["changedIncomplete"], true);
    }

    #[test]
    fn revalidation_preserves_unknown_tool_status() {
        let root = tempfile::tempdir().unwrap();
        let checked = validate_files(
            &root.path().to_string_lossy(),
            &json!({
                "files":[], "urls":[], "changed":["tool-only.txt"],
                "changedDetails":[{"path":"tool-only.txt","status":"changed","evidence":"tool"}]
            }),
        );
        assert_eq!(
            checked["changedDetails"],
            json!([
                {"path":"tool-only.txt","status":"changed","evidence":"tool"}
            ])
        );
    }

    #[test]
    fn revalidation_preserves_valid_folder_attribution_and_deleted_paths() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("pages")).unwrap();
        let raw = json!({
            "files":[], "urls":[], "changed":["pages/deleted.html"],
            "changedDetails":[
                {"path":"pages/deleted.html","status":"deleted","evidence":"folder"},
                {"path":"../escape.html","status":"added","evidence":"folder"},
                {"path":"pages/bad.html","status":"wrong","evidence":"folder"}
            ],
            "possiblyChanged":["pages/maybe.html","../escape.html"],
            "changedIncomplete":true,
            "possiblyChangedWith":["other","other","bad\nhandle"]
        });
        let checked = validate_files(&root.path().to_string_lossy(), &raw);
        assert_eq!(checked["changed"], json!(["pages/deleted.html"]));
        assert_eq!(
            checked["changedDetails"],
            json!([{"path":"pages/deleted.html","status":"deleted","evidence":"folder"}])
        );
        assert_eq!(checked["possiblyChanged"], json!(["pages/maybe.html"]));
        assert_eq!(checked["changedIncomplete"], json!(true));
        assert_eq!(checked["possiblyChangedWith"], json!(["other"]));
        assert_eq!(
            validated_path(&root.path().to_string_lossy(), "pages/deleted.html"),
            Some("pages/deleted.html".into())
        );
    }

    #[test]
    fn unusually_many_long_tool_paths_cannot_strand_the_reply_read_page() {
        let root = tempfile::tempdir().unwrap();
        let references = (0..MAX_CHANGED)
            .map(|index| json!({"path":format!("{index:02}-{}.txt", "a".repeat(MAX_PATH_BYTES - 7))}))
            .collect::<Vec<_>>();
        let item = item(
            "delivery",
            json!({"type":"tool","toolName":"Write","status":"completed","fileReferences":references}),
        );
        let outputs = output(&root.path().to_string_lossy(), "", &[item], &[]);
        assert!(outputs["changed"].as_array().unwrap().len() < MAX_CHANGED);
        assert_eq!(outputs["changedIncomplete"], true);
        assert!(serde_json::to_vec(&outputs).unwrap().len() <= 64 * 1024);
    }
}
