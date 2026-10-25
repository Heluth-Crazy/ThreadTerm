use serde_json::{json, Value};

use crate::usage_ledger::facts::{number, text, timestamp, Fact, Parsed, ReaderState};

const MAX_STATE_TEXT: usize = 1024;
const MIRROR_WINDOW: usize = 64;

fn bounded(value: Option<&str>) -> Option<String> {
    value
        .filter(|value| !value.is_empty() && value.len() <= MAX_STATE_TEXT)
        .map(str::to_owned)
}

fn payload(value: &Value) -> &Value {
    value.get("payload").unwrap_or(value)
}

fn update_context(value: &Value, state: &mut ReaderState) {
    let payload = payload(value);
    if value.get("type").and_then(Value::as_str) == Some("session_meta") {
        // Spawned rollouts can embed the parent's metadata after their own
        // root header. Only the first root owns this stream's legacy usage.
        if state.data["codexRootMetadataSeen"].as_bool() == Some(true) {
            return;
        }
        if let Some(session) = bounded(text(payload, &["id", "session_id", "thread_id"])) {
            state.session_id = session;
            data_object(state).insert("codexRootMetadataSeen".into(), Value::Bool(true));
        }
        if let Some(parent) = bounded(text(
            payload,
            &["forked_from_id", "parent_session_id", "parent_id"],
        )) {
            state.parent_session_id = Some(parent);
            if let Some(at) = value
                .get("timestamp")
                .and_then(timestamp)
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
                .map(|t| t.timestamp_millis())
            {
                data_object(state).insert("forkCreatedAtMs".into(), Value::from(at));
            }
        }
        if let Some(parent) = payload
            .pointer("/source/subagent/thread_spawn/parent_thread_id")
            .and_then(Value::as_str)
            .and_then(|value| bounded(Some(value)))
        {
            state.parent_session_id = Some(parent);
            data_object(state).insert("codexSubagent".into(), Value::Bool(true));
            data_object(state).remove("forkCreatedAtMs");
        }
        if let Some(cwd) = bounded(text(payload, &["cwd"])) {
            state.cwd = Some(cwd);
        }
    }
    if value.get("type").and_then(Value::as_str) == Some("turn_context") {
        if let Some(model) = bounded(text(payload, &["model"])) {
            state.model = Some(model);
        }
        if let Some(cwd) = bounded(text(payload, &["cwd"])) {
            state.cwd = Some(cwd);
        }
        if let Some(turn) = bounded(text(payload, &["turn_id", "turnId"])) {
            data_object(state).insert("turnId".into(), Value::String(turn));
        }
    }
}

fn typed_usage(value: &Value) -> Option<&Value> {
    let payload = payload(value);
    if value.get("type").and_then(Value::as_str) == Some("token_usage_record") {
        return Some(payload);
    }
    (payload.get("type").and_then(Value::as_str) == Some("token_usage_record"))
        .then(|| payload.get("payload").unwrap_or(payload))
}

fn normalized_buckets(
    usage: &Value,
    parsed: &mut Parsed,
) -> Option<(Option<i64>, Option<i64>, Option<i64>, Option<i64>)> {
    let input = number(usage, &["input_tokens", "inputTokens"]);
    let cache_read = number(usage, &["cached_input_tokens", "cachedInputTokens"]);
    let output = number(usage, &["output_tokens", "outputTokens"]);
    let reasoning = number(usage, &["reasoning_output_tokens", "reasoningOutputTokens"]);
    let uncached = match (input, cache_read) {
        (Some(input), Some(cached)) if cached <= input => Some(input - cached),
        (Some(_), Some(_)) => {
            parsed
                .problems
                .push("Codex usage has cached input larger than input; record skipped".into());
            return None;
        }
        (Some(_), None) => {
            parsed
                .problems
                .push("inclusive_input_without_cache_breakdown".into());
            None
        }
        (None, _) => None,
    };
    Some((uncached, cache_read, output, reasoning))
}

fn state_counter<'a>(state: &'a ReaderState, name: &str) -> Option<&'a Value> {
    state.data.get(name)
}

fn data_object(state: &mut ReaderState) -> &mut serde_json::Map<String, Value> {
    if !state.data.is_object() {
        state.data = json!({});
    }
    state.data.as_object_mut().expect("reader state object")
}

fn coordinate(totals: &Value) -> Value {
    json!({
        "input": number(totals, &["input_tokens", "inputTokens"]),
        "cached": number(totals, &["cached_input_tokens", "cachedInputTokens"]),
        "output": number(totals, &["output_tokens", "outputTokens"]),
        "reasoning": number(totals, &["reasoning_output_tokens", "reasoningOutputTokens"]),
        "cacheWrite5m": number(totals, &["cache_write_5m_input_tokens", "cacheWrite5mInputTokens"]),
        "cacheWrite1h": number(totals, &["cache_write_1h_input_tokens", "cacheWrite1hInputTokens"]),
        "cacheWriteUnknown": number(totals, &["cache_write_input_tokens", "cacheWriteInputTokens"])
    })
}

fn current_turn(state: &ReaderState, record: Option<&Value>) -> Option<String> {
    record
        .and_then(|record| bounded(text(record, &["turn_id", "turnId"])))
        .or_else(|| {
            state
                .data
                .get("turnId")
                .and_then(Value::as_str)
                .and_then(|turn| bounded(Some(turn)))
        })
}

fn append_mirror(state: &mut ReaderState, name: &str, mirror: Value) {
    let object = data_object(state);
    let mirrors = object
        .entry(name)
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(mirrors) = mirrors.as_array_mut() else {
        return;
    };
    mirrors.push(mirror);
    if mirrors.len() > MIRROR_WINDOW {
        let excess = mirrors.len() - MIRROR_WINDOW;
        mirrors.drain(..excess);
    }
}

fn mirror_matches(
    mirror: &Value,
    session: &str,
    turn: Option<&str>,
    coordinate: &Value,
    usage: Option<&Value>,
    occurred_at: &str,
) -> bool {
    if mirror.get("session").and_then(Value::as_str) != Some(session) {
        return false;
    }
    let known_turn = match (mirror.get("turn").and_then(Value::as_str), turn) {
        (Some(left), Some(right)) if left != right => return false,
        (Some(_), Some(_)) => true,
        _ => false,
    };
    let exact = mirror.get("coordinate") == Some(coordinate)
        || mirror.get("legacyCoordinate") == Some(coordinate);
    if exact && known_turn {
        return true;
    }
    let nearby = mirror
        .get("at")
        .and_then(Value::as_str)
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .zip(chrono::DateTime::parse_from_rfc3339(occurred_at).ok())
        .is_some_and(|(earlier, now)| {
            (now.timestamp_millis() - earlier.timestamp_millis()).abs() <= 60_000
        });
    // Compaction can put typed and legacy totals on different cumulative axes.
    // Pair equal last usage only once, near in time, with no conflicting turn.
    nearby
        && (exact
            || (mirror.get("legacyCoordinate").is_none()
                && usage.is_some_and(|usage| {
                    mirror.get("usage") == Some(usage)
                        && ["input", "output"]
                            .into_iter()
                            .any(|key| usage[key].as_i64().unwrap_or(0) > 0)
                })))
}

fn matching_legacy_keys(
    state: &mut ReaderState,
    session: &str,
    turn: Option<&str>,
    coordinate: &Value,
    usage: &Value,
    occurred_at: &str,
) -> (Vec<String>, Option<Value>) {
    let Some(mirrors) = data_object(state)
        .get_mut("legacyMirrors")
        .and_then(Value::as_array_mut)
    else {
        return (Vec::new(), None);
    };
    let best = mirrors
        .iter()
        .enumerate()
        .filter(|(_, mirror)| {
            mirror_matches(mirror, session, turn, coordinate, Some(usage), occurred_at)
        })
        .min_by_key(|(_, mirror)| {
            let exact = mirror.get("coordinate") == Some(coordinate);
            let gap = mirror
                .get("at")
                .and_then(Value::as_str)
                .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
                .zip(chrono::DateTime::parse_from_rfc3339(occurred_at).ok())
                .map(|(a, b)| (a.timestamp_millis() - b.timestamp_millis()).abs())
                .unwrap_or(i64::MAX);
            (!exact, gap)
        })
        .map(|(index, _)| index);
    let Some(index) = best else {
        return (Vec::new(), None);
    };
    let mirror = mirrors.remove(index);
    (
        mirror
            .get("key")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .into_iter()
            .collect(),
        mirror.get("coordinate").cloned(),
    )
}

fn has_typed_mirror(
    state: &mut ReaderState,
    session: &str,
    turn: Option<&str>,
    coordinate: &Value,
    usage: Option<&Value>,
    occurred_at: &str,
) -> bool {
    let Some(mirrors) = data_object(state)
        .get_mut("typedMirrors")
        .and_then(Value::as_array_mut)
    else {
        return false;
    };
    let Some(mirror) = mirrors
        .iter_mut()
        .rev()
        .find(|mirror| mirror_matches(mirror, session, turn, coordinate, usage, occurred_at))
    else {
        return false;
    };
    mirror
        .as_object_mut()
        .unwrap()
        .insert("legacyCoordinate".into(), coordinate.clone());
    true
}

fn save_counter(state: &mut ReaderState, totals: &Value, sequence: u64) {
    let coordinate = coordinate(totals);
    let object = data_object(state);
    object.insert("legacyTotals".into(), coordinate);
    object.insert("legacySequence".into(), Value::from(sequence));
}

fn subtract(current: Option<i64>, previous: Option<i64>) -> Option<i64> {
    current.map(|current| current.saturating_sub(previous.unwrap_or(0)))
}

/// Parses typed Codex request records and guarded legacy cumulative snapshots.
/// Typed `response_id` rows are authoritative. Legacy rows use only numeric
/// counter state and deliberately skip a fork's inherited first snapshot.
pub fn parse(value: &Value, offset: u64, file_id: &str, state: &mut ReaderState) -> Parsed {
    let mut parsed = Parsed::default();
    update_context(value, state);

    if let Some(record) = typed_usage(value) {
        let Some(response_id) = bounded(text(record, &["response_id", "responseId"])) else {
            parsed
                .problems
                .push("Codex typed usage record has no response id".into());
            return parsed;
        };
        let Some(usage) = record.get("usage") else {
            parsed
                .problems
                .push("Codex typed usage record has no usage object".into());
            return parsed;
        };
        let Some(occurred_at) = value.get("timestamp").and_then(timestamp) else {
            parsed
                .problems
                .push("Codex typed usage record has an unsupported timestamp".into());
            return parsed;
        };
        let session = bounded(text(
            record,
            &["thread_id", "threadId", "session_id", "sessionId"],
        ))
        .or_else(|| bounded(Some(&state.session_id)))
        .filter(|session| !session.is_empty());
        let Some(session) = session else {
            parsed
                .problems
                .push("Codex typed usage record has no thread id".into());
            return parsed;
        };
        let Some((input, cache_read, output, reasoning)) = normalized_buckets(usage, &mut parsed)
        else {
            return parsed;
        };
        let mirror_coordinate = record.get("thread_token_usage").map(coordinate);
        let mirror_turn = current_turn(state, Some(record));
        let raw_usage = coordinate(usage);
        if let Some(coordinate) = &mirror_coordinate {
            let (keys, legacy_coordinate) = matching_legacy_keys(
                state,
                &session,
                mirror_turn.as_deref(),
                coordinate,
                &raw_usage,
                &occurred_at,
            );
            parsed.replaced_keys.extend(keys);
            let mut mirror = json!({ "session": session, "turn": mirror_turn, "coordinate": coordinate, "usage": raw_usage, "at": occurred_at });
            if let Some(coordinate) = legacy_coordinate {
                mirror["legacyCoordinate"] = coordinate;
            }
            append_mirror(state, "typedMirrors", mirror);
        }
        let mut fact = Fact::new(
            "codex",
            &session,
            &format!("{session}:{response_id}"),
            &occurred_at,
        );
        fact.model = bounded(text(record, &["model"])).or_else(|| state.model.clone());
        fact.buckets.input = input;
        fact.buckets.cache_read = cache_read;
        // Codex's generic cache-write counter has no TTL. Preserve it as
        // exact unpriced coverage unless a newer format supplies a partition.
        fact.buckets.cache_write5m = number(
            usage,
            &["cache_write_5m_input_tokens", "cacheWrite5mInputTokens"],
        );
        fact.buckets.cache_write1h = number(
            usage,
            &["cache_write_1h_input_tokens", "cacheWrite1hInputTokens"],
        );
        if fact.buckets.cache_write5m.is_none() && fact.buckets.cache_write1h.is_none() {
            fact.buckets.cache_write_unknown = number(
                usage,
                &["cache_write_input_tokens", "cacheWriteInputTokens"],
            );
        }
        fact.buckets.output = output;
        fact.buckets.reasoning = reasoning;
        fact.parent_native_session_id =
            bounded(text(record, &["parent_session_id", "parentSessionId"]))
                .or_else(|| state.parent_session_id.clone());
        fact.subagent = state.data["codexSubagent"].as_bool() == Some(true)
            || record.get("subagent").and_then(Value::as_bool) == Some(true);
        fact.cwd = state.cwd.clone();
        fact.source = format!("native:{file_id}@{offset}");
        parsed.covered_sessions.push(session);
        parsed.facts.push(fact);
        return parsed;
    }

    let payload = payload(value);
    if value.get("type").and_then(Value::as_str) != Some("event_msg")
        || payload.get("type").and_then(Value::as_str) != Some("token_count")
    {
        return parsed;
    }
    let Some(info) = payload.get("info").filter(|info| info.is_object()) else {
        return parsed;
    };
    let Some(totals) = info.get("total_token_usage") else {
        parsed
            .problems
            .push("Codex legacy token_count has no cumulative totals".into());
        return parsed;
    };
    let Some(occurred_at) = value.get("timestamp").and_then(timestamp) else {
        parsed
            .problems
            .push("Codex legacy token_count has an unsupported timestamp".into());
        return parsed;
    };
    let Some(session) = bounded(Some(&state.session_id)).filter(|session| !session.is_empty())
    else {
        parsed
            .problems
            .push("Codex legacy token_count appears before session metadata".into());
        return parsed;
    };
    let previous = state_counter(state, "legacyTotals").cloned();
    let sequence = state_counter(state, "legacySequence")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        + 1;
    let mirror_coordinate = coordinate(totals);
    let mirror_turn = current_turn(state, None);
    save_counter(state, totals, sequence);
    if previous.as_ref() == Some(&mirror_coordinate) {
        return parsed;
    }
    if state
        .data
        .get("forkCreatedAtMs")
        .and_then(Value::as_i64)
        .is_some_and(|created| {
            chrono::DateTime::parse_from_rfc3339(&occurred_at)
                .is_ok_and(|t| t.timestamp_millis() < created)
        })
    {
        parsed.problems.push("copied_fork_prefix_excluded".into());
        return parsed;
    }
    if previous.is_none()
        && state.parent_session_id.is_some()
        && state.data["codexSubagent"].as_bool() != Some(true)
    {
        parsed
            .problems
            .push("Codex fork legacy baseline omitted to exclude copied history".into());
        return parsed;
    }
    let last = info
        .get("last_token_usage")
        .filter(|usage| usage.is_object());
    let raw_usage = last.map(coordinate);
    if has_typed_mirror(
        state,
        &session,
        mirror_turn.as_deref(),
        &mirror_coordinate,
        raw_usage.as_ref(),
        &occurred_at,
    ) {
        return parsed;
    }
    let previous = previous.unwrap_or(Value::Null);
    let reset = [
        "input",
        "cached",
        "output",
        "reasoning",
        "cacheWrite5m",
        "cacheWrite1h",
        "cacheWriteUnknown",
    ]
    .into_iter()
    .any(|key| {
        mirror_coordinate
            .get(key)
            .and_then(Value::as_i64)
            .zip(previous.get(key).and_then(Value::as_i64))
            .is_some_and(|(now, before)| now < before)
    });
    let mut epoch = state.data["legacyEpoch"].as_u64().unwrap_or(0);
    if reset {
        epoch += 1;
        data_object(state).insert("legacyEpoch".into(), json!(epoch));
        parsed.problems.push("cumulative_counter_reset".into());
    }
    if reset && last.is_none() {
        parsed
            .problems
            .push("counter_reset_without_last_usage".into());
        return parsed;
    }
    // Last usage is the completed request, even across compaction/corrections.
    // Cumulative counters remain the status/mirror identity and legacy fallback.
    let usage = last.unwrap_or(totals);
    let previous = if last.is_some() {
        Value::Null
    } else {
        previous
    };
    let (input, cache_read, output, reasoning) = match normalized_buckets(usage, &mut parsed) {
        Some(buckets) => buckets,
        None => return parsed,
    };
    let prior_input = number(&previous, &["input"]);
    let prior_cache = number(&previous, &["cached"]);
    let prior_output = number(&previous, &["output"]);
    let prior_reasoning = number(&previous, &["reasoning"]);
    let mut key = format!(
        "legacy:{session}:{}:{}:{}",
        mirror_turn.as_deref().unwrap_or("unknown"),
        number(totals, &["input_tokens", "inputTokens"]).unwrap_or(0),
        number(totals, &["output_tokens", "outputTokens"]).unwrap_or(0)
    );
    if epoch > 0 {
        key.push_str(&format!(":epoch:{epoch}"));
    }
    let mut fact = Fact::new("codex", &session, &key, &occurred_at);
    fact.model = bounded(text(info, &["model"])).or_else(|| state.model.clone());
    let prior_uncached = match (prior_input, prior_cache) {
        (Some(input), Some(cache)) if cache <= input => Some(input - cache),
        (Some(input), None) => Some(input),
        _ => None,
    };
    if last.is_none()
        && input
            .zip(prior_uncached)
            .is_some_and(|(now, before)| now < before)
    {
        parsed
            .problems
            .push("cache_counter_correction_without_last_usage".into());
        return parsed;
    }
    fact.buckets.input = subtract(input, prior_uncached);
    fact.buckets.cache_read = subtract(cache_read, prior_cache);
    // Apply the same no-TTL rule to last usage and cumulative deltas.
    fact.buckets.cache_write5m = subtract(
        number(
            usage,
            &["cache_write_5m_input_tokens", "cacheWrite5mInputTokens"],
        ),
        number(&previous, &["cacheWrite5m"]),
    );
    fact.buckets.cache_write1h = subtract(
        number(
            usage,
            &["cache_write_1h_input_tokens", "cacheWrite1hInputTokens"],
        ),
        number(&previous, &["cacheWrite1h"]),
    );
    if fact.buckets.cache_write5m.is_none() && fact.buckets.cache_write1h.is_none() {
        fact.buckets.cache_write_unknown = subtract(
            number(
                usage,
                &["cache_write_input_tokens", "cacheWriteInputTokens"],
            ),
            number(&previous, &["cacheWriteUnknown"]),
        );
    }
    fact.buckets.output = subtract(output, prior_output);
    fact.buckets.reasoning = subtract(reasoning, prior_reasoning);
    fact.quality = "derived".into();
    fact.parent_native_session_id = state.parent_session_id.clone();
    fact.subagent = state.data["codexSubagent"].as_bool() == Some(true);
    fact.cwd = state.cwd.clone();
    fact.source = format!("native:{file_id}@{offset}");
    append_mirror(
        state,
        "legacyMirrors",
        json!({
            "session": session,
            "turn": mirror_turn,
            "at": occurred_at,
            "coordinate": mirror_coordinate,
            "usage": raw_usage,
            "key": fact.key.clone(),
        }),
    );
    parsed.covered_sessions.push(session);
    parsed.facts.push(fact);
    parsed
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn typed_record_replaces_a_legacy_mirror_across_incremental_lines() {
        let mut state = ReaderState::default();
        parse(
            &json!({"type":"session_meta","payload":{"id":"thread-a"}}),
            0,
            "a",
            &mut state,
        );
        parse(
            &json!({"type":"turn_context","payload":{"turn_id":"turn-a","model":"model-a"}}),
            10,
            "a",
            &mut state,
        );
        let legacy = parse(
            &json!({
                "timestamp":"2026-01-02T03:04:05Z", "type":"event_msg",
                "payload":{"type":"token_count","info":{"total_token_usage":{
                    "input_tokens":100,"cached_input_tokens":40,"output_tokens":7,"reasoning_output_tokens":2
                }}}
            }),
            20,
            "a",
            &mut state,
        );
        assert_eq!(legacy.facts.len(), 1);
        // The stable cumulative coordinate carries the turn and counters, so
        // an archive/rewrite cannot renumber it by its physical line offset.
        assert_eq!(legacy.facts[0].key, "codex:legacy:thread-a:turn-a:100:7");

        let typed = parse(
            &json!({
                "timestamp":"2026-01-02T03:04:06Z", "type":"token_usage_record", "payload":{
                    "thread_id":"thread-a", "turn_id":"turn-a", "response_id":"response-a",
                    "usage":{"input_tokens":60,"cached_input_tokens":20,"output_tokens":7,"reasoning_output_tokens":2},
                    "thread_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":7,"reasoning_output_tokens":2}
                }
            }),
            30,
            "a",
            &mut state,
        );
        assert_eq!(
            typed.replaced_keys,
            vec!["codex:legacy:thread-a:turn-a:100:7"]
        );
        assert_eq!(typed.facts[0].buckets.input, Some(40));
    }

    #[test]
    fn typed_mirror_suppresses_later_legacy_snapshot() {
        let mut state = ReaderState::default();
        parse(
            &json!({"type":"session_meta","payload":{"id":"thread-a"}}),
            0,
            "a",
            &mut state,
        );
        parse(
            &json!({"type":"turn_context","payload":{"turn_id":"turn-a"}}),
            10,
            "a",
            &mut state,
        );
        parse(
            &json!({
                "timestamp":"2026-01-02T03:04:05Z", "type":"token_usage_record", "payload":{
                    "thread_id":"thread-a", "turn_id":"turn-a", "response_id":"response-a",
                    "usage":{"input_tokens":2,"output_tokens":1},
                    "thread_token_usage":{"input_tokens":10,"output_tokens":1}
                }
            }),
            20,
            "a",
            &mut state,
        );
        let legacy = parse(
            &json!({
                "timestamp":"2026-01-02T03:04:06Z", "type":"event_msg",
                "payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":1}}}
            }),
            30,
            "a",
            &mut state,
        );
        assert!(legacy.facts.is_empty());
    }

    #[test]
    fn incomplete_typed_record_is_reported_without_a_synthetic_identity() {
        let mut state = ReaderState::default();
        let parsed = parse(
            &json!({
                "timestamp":"2026-01-02T03:04:05Z", "type":"token_usage_record",
                "payload":{"thread_id":"thread-a", "usage":{"input_tokens":1}}
            }),
            0,
            "a",
            &mut state,
        );
        assert!(parsed.facts.is_empty());
        assert_eq!(
            parsed.problems,
            vec!["Codex typed usage record has no response id"]
        );
    }
}
