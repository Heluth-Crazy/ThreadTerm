use crate::usage_ledger::facts::{number, text, timestamp, Buckets, Fact, Parsed, ReaderState};
use serde_json::Value;

/// Parses Kimi Code 2.x `usage.record` journal entries.  The scanner supplies
/// the physical journal coordinate, which is the only stable request identity
/// Kimi persists for these records.
pub fn parse(value: &Value, offset: u64, file_id: &str, state: &mut ReaderState) -> Parsed {
    let mut parsed = Parsed::default();
    if text(value, &["type"]) != Some("usage.record") {
        return parsed;
    }
    if let Some(problem) = state
        .data
        .get("sourceMetadataProblem")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        if state.data["sourceMetadataProblemReported"].as_bool() != Some(true) {
            parsed.problems.push(problem);
        }
        state.data["sourceMetadataProblemReported"] = Value::Bool(true);
        return parsed;
    }
    let Some(usage) = value.get("usage") else {
        parsed
            .problems
            .push("kimi usage.record has no usage object".into());
        return parsed;
    };
    let Some(occurred_at) = value.get("time").and_then(timestamp) else {
        parsed
            .problems
            .push("kimi usage.record has no usable time".into());
        return parsed;
    };
    let parent = state.session_id.clone();
    if parent.is_empty() {
        parsed
            .problems
            .push("kimi usage.record has no native session metadata".into());
        return parsed;
    }
    // Kimi records carry an agent ID, but it is the journal scope plus the
    // session metadata that identifies a child.  Treating every agentId as a
    // child wrongly splits the primary `main` journal.
    let agent = state.data.get("kimiAgentId").and_then(Value::as_str);
    let child = state.data["kimiSubagent"].as_bool().unwrap_or(false);
    if let (Some(agent), Some(record_agent)) = (agent, text(value, &["agentId"])) {
        if agent != record_agent {
            parsed
                .problems
                .push("foreign_agent_usage_in_journal".into());
            return parsed;
        }
    }
    let session = match (
        child || state.data["kimiIndependent"].as_bool() == Some(true),
        agent,
    ) {
        (true, Some(agent)) => format!("{parent}:agent:{agent}"),
        _ => parent.clone(),
    };
    if state.data["kimiForkCreatedAt"]
        .as_i64()
        .is_some_and(|created| {
            chrono::DateTime::parse_from_rfc3339(&occurred_at)
                .is_ok_and(|time| time.timestamp_millis() < created)
        })
    {
        parsed.covered_sessions.push(session);
        return parsed;
    }
    let mut fact = Fact::new(
        "kimi",
        &session,
        &format!("{session}:journal:{offset}"),
        &occurred_at,
    );
    fact.parent_native_session_id = child.then_some(parent);
    fact.subagent = child;
    fact.model = text(value, &["model"])
        .map(str::to_owned)
        .or_else(|| state.model.clone());
    fact.cwd = state.cwd.clone();
    fact.source = format!("native:{file_id}@{offset}");
    fact.buckets = Buckets {
        input: number(usage, &["inputOther", "input_other"]),
        cache_read: number(usage, &["inputCacheRead", "input_cache_read"]),
        cache_write5m: None,
        cache_write1h: None,
        cache_write_unknown: number(usage, &["inputCacheCreation", "input_cache_creation"]),
        output: number(usage, &["output"]),
        reasoning: None,
        ..Default::default()
    };
    if fact.buckets.total() == 0
        && [
            fact.buckets.input,
            fact.buckets.cache_read,
            fact.buckets.cache_write5m,
            fact.buckets.output,
        ]
        .iter()
        .all(Option::is_none)
    {
        parsed
            .problems
            .push("kimi usage.record has no token buckets".into());
        return parsed;
    }
    parsed.covered_sessions.push(fact.native_session_id.clone());
    parsed.facts.push(fact);
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn journal_offset_keeps_both_kimi_scopes_without_splitting_main_agent() {
        let mut state = ReaderState {
            session_id: "root".into(),
            data: json!({"kimiAgentId":"main", "kimiSubagent":false}),
            ..Default::default()
        };
        let turn = parse(
            &json!({"type":"usage.record","time":1,"usageScope":"turn","model":"fixture-kimi-model","usage":{"inputOther":1,"inputCacheRead":2,"inputCacheCreation":3,"output":4}}),
            10,
            "wire",
            &mut state,
        );
        let session = parse(
            &json!({"type":"usage.record","time":2,"usageScope":"session","agentId":"main","usage":{"inputOther":5,"output":6}}),
            20,
            "wire",
            &mut state,
        );
        assert_eq!(turn.facts[0].buckets.total(), 10);
        assert_eq!(session.facts[0].native_session_id, "root");
        assert!(!session.facts[0].subagent);
    }

    #[test]
    fn foreign_agent_rows_are_not_attached_to_the_journal_owner() {
        let mut state = ReaderState {
            session_id: "root".into(),
            data: json!({"kimiAgentId":"main", "kimiSubagent":false}),
            ..Default::default()
        };
        let parsed = parse(
            &json!({"type":"usage.record","time":1,"agentId":"other","usage":{"inputOther":1,"output":2}}),
            10,
            "wire",
            &mut state,
        );
        assert!(parsed.facts.is_empty());
        assert_eq!(parsed.problems, vec!["foreign_agent_usage_in_journal"]);
    }

    #[test]
    fn nested_scope_uses_metadata_root_agent_classification() {
        let mut state = ReaderState {
            session_id: "root".into(),
            data: json!({"kimiAgentId":"child", "kimiSubagent":true}),
            ..Default::default()
        };
        let parsed = parse(
            &json!({"type":"usage.record","time":1,"model":"fixture-kimi-model","usage":{"inputOther":1,"output":2}}),
            10,
            "wire",
            &mut state,
        );
        assert_eq!(parsed.facts[0].native_session_id, "root:agent:child");
        assert_eq!(
            parsed.facts[0].parent_native_session_id.as_deref(),
            Some("root")
        );
        assert!(parsed.facts[0].subagent);
    }
}
