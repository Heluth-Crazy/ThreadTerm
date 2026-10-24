//! Privacy-preserving extraction of per-request live provider usage.
//!
//! This module accepts only explicitly identified request facts. Context-window
//! snapshots and footer totals are deliberately not additive accounting input.

use super::{
    facts::{number, text, timestamp, Buckets, Fact},
    store,
};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_live_turns (
        threadterm_session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        started_at TEXT NOT NULL, model TEXT, PRIMARY KEY(threadterm_session_id,turn_id)
    );",
    )?;
    let _ = conn.execute("ALTER TABLE usage_live_turns ADD COLUMN model TEXT", []);
    Ok(())
}

fn positive(value: Option<i64>) -> Option<i64> {
    value.filter(|value| *value >= 0)
}

fn usage_buckets(format: &str, usage: &Value) -> Buckets {
    let n = |names| positive(number(usage, names));
    match format {
        "claude" => {
            let cache_write5m = usage
                .pointer("/cache_creation/ephemeral_5m_input_tokens")
                .and_then(Value::as_i64);
            let cache_write1h = usage
                .pointer("/cache_creation/ephemeral_1h_input_tokens")
                .and_then(Value::as_i64);
            Buckets {
                input: n(&["input_tokens", "inputTokens"]),
                cache_read: n(&["cache_read_input_tokens", "cacheReadTokens"]),
                cache_write5m,
                cache_write1h,
                cache_write_unknown: (cache_write5m.is_none() && cache_write1h.is_none())
                    .then(|| n(&["cache_creation_input_tokens", "cacheWriteTokens"]))
                    .flatten(),
                output: n(&["output_tokens", "outputTokens"]),
                reasoning: None,
                ..Default::default()
            }
        }
        "codex" => {
            let cached = n(&["cachedInputTokens", "cached_input_tokens"]);
            let input = n(&["inputTokens", "input_tokens"])
                .zip(cached)
                .map(|(value, cache)| value.saturating_sub(cache));
            Buckets {
                input,
                cache_read: cached,
                cache_write5m: n(&["cacheWriteInputTokens", "cache_write_input_tokens"]),
                cache_write1h: None,
                output: n(&["outputTokens", "output_tokens"]),
                reasoning: n(&["reasoningOutputTokens", "reasoning_output_tokens"]),
                ..Default::default()
            }
        }
        "opencode" => {
            let reasoning = n(&["reasoning"]);
            Buckets {
                input: n(&["input"]),
                cache_read: usage.pointer("/cache/read").and_then(Value::as_i64),
                cache_write5m: None,
                cache_write1h: None,
                cache_write_unknown: usage.pointer("/cache/write").and_then(Value::as_i64),
                output: n(&["output"]).map(|value| value.saturating_add(reasoning.unwrap_or(0))),
                reasoning,
                ..Default::default()
            }
        }
        "grok" => {
            let cache = n(&["cachedReadTokens", "cacheReadTokens"]);
            Buckets {
                input: n(&["inputTokens", "input_tokens"])
                    .zip(cache)
                    .map(|(value, cache)| value.saturating_sub(cache)),
                cache_read: cache,
                cache_write5m: None,
                cache_write1h: None,
                cache_write_unknown: n(&["cacheCreationTokens", "cacheWriteTokens"]),
                output: n(&["outputTokens", "output_tokens"]),
                reasoning: n(&["reasoningTokens", "reasoning_tokens"]),
                ..Default::default()
            }
        }
        "pi" => {
            let write = n(&["cacheWrite", "cache_write"]);
            let write5m = n(&["cacheWrite5m", "cache_write_5m"]);
            let write1h = n(&["cacheWrite1h", "cache_write_1h"]);
            Buckets {
                input: n(&["input"]),
                cache_read: n(&["cacheRead", "cache_read"]),
                cache_write5m: write5m,
                cache_write1h: write1h,
                cache_write_unknown: write.map(|value| {
                    value
                        .saturating_sub(write5m.unwrap_or(0))
                        .saturating_sub(write1h.unwrap_or(0))
                }),
                output: n(&["output"]),
                reasoning: n(&["reasoning"]),
                ..Default::default()
            }
        }
        // ACP/Kimi facts are accepted only from an explicit per-request event.
        _ => Buckets {
            input: n(&["inputOther", "input", "inputTokens"]),
            cache_read: n(&["inputCacheRead", "cacheRead", "cacheReadTokens"]),
            cache_write5m: None,
            cache_write1h: None,
            cache_write_unknown: n(&["inputCacheCreation", "cacheWrite", "cacheWriteTokens"]),
            output: n(&["output", "outputTokens"]),
            reasoning: n(&["reasoning", "reasoningTokens"]),
            ..Default::default()
        },
    }
}

fn nonempty(value: Option<&str>) -> Option<String> {
    value.filter(|value| !value.is_empty()).map(str::to_owned)
}

fn request_fact(
    provider: &str,
    native_session: &str,
    threadterm_session: &str,
    turn: Option<&str>,
    data: &Value,
    now: &str,
    started_at: Option<String>,
) -> Option<Fact> {
    let request = nonempty(text(data, &["requestId", "request_id"]))?;
    let usage = data.get("usage")?;
    let format = text(data, &["providerFormat", "provider_format"]).unwrap_or(provider);
    let buckets = usage_buckets(format, usage);
    if [
        buckets.input,
        buckets.cache_read,
        buckets.cache_write5m,
        buckets.cache_write1h,
        buckets.cache_write_unknown,
        buckets.output,
    ]
    .iter()
    .all(Option::is_none)
    {
        return None;
    }
    let occurred = data
        .get("timestamp")
        .and_then(timestamp)
        .unwrap_or_else(|| now.to_owned());
    let request = if provider == "codex" {
        format!("{}:{request}", turn?)
    } else {
        request
    };
    let mut fact = Fact::new(
        provider,
        native_session,
        &format!("live:{threadterm_session}:{request}"),
        &occurred,
    );
    fact.model = nonempty(text(data, &["model", "modelId", "model_id"]));
    fact.buckets = buckets;
    fact.quality = text(data, &["identityQuality"])
        .unwrap_or("exact")
        .to_owned();
    fact.reported_cost = usage
        .get("cost")
        .and_then(Value::as_f64)
        .filter(|cost| *cost > 0.0)
        .or_else(|| {
            usage
                .pointer("/cost/total")
                .and_then(Value::as_f64)
                .filter(|cost| *cost > 0.0)
        })
        .or_else(|| number(usage, &["costUsdTicks"]).map(|ticks| ticks as f64 / 10_000_000_000.0));
    fact.source = format!("live:{threadterm_session}:{request}");
    fact.threadterm_session_id = Some(threadterm_session.to_owned());
    fact.turn_id = turn.map(str::to_owned);
    fact.started_at = started_at;
    Some(fact)
}

fn claude_fact(data: &Value) -> Option<Value> {
    let raw = data.get("raw").unwrap_or(data);
    let message = raw.get("message").unwrap_or(raw);
    let usage = message
        .pointer("/event/usage")
        .or_else(|| message.pointer("/event/message/usage"))
        .or_else(|| message.get("usage"))
        .or_else(|| message.pointer("/message/usage"))?;
    let request = raw
        .get("speedCallId")
        .and_then(Value::as_str)
        .or_else(|| message.pointer("/event/message/id").and_then(Value::as_str))
        .or_else(|| message.pointer("/message/id").and_then(Value::as_str))
        .or_else(|| message.get("uuid").and_then(Value::as_str))?;
    Some(
        json!({"requestId":request,"model":message.pointer("/event/message/model").or_else(||message.pointer("/message/model")).and_then(Value::as_str),"usage":usage,"providerFormat":"claude"}),
    )
}

fn codex_fact(data: &Value) -> Option<Value> {
    let raw = data.get("raw").unwrap_or(data);
    let token = raw
        .pointer("/params/tokenUsage")
        .or_else(|| raw.get("tokenUsage"))?;
    let last = token.get("last")?;
    let total = Some(token.get("total")?);
    let key_number = |value: Option<&Value>, camel: &str, snake: &str| {
        value
            .and_then(|value| value.get(camel).or_else(|| value.get(snake)))
            .and_then(Value::as_i64)
            .unwrap_or(0)
    };
    // Prefix identity is stable when a snapshot for the same call is revised.
    let input = key_number(total, "inputTokens", "input_tokens").saturating_sub(key_number(
        Some(last),
        "inputTokens",
        "input_tokens",
    ));
    let output = key_number(total, "outputTokens", "output_tokens").saturating_sub(key_number(
        Some(last),
        "outputTokens",
        "output_tokens",
    ));
    Some(
        json!({"requestId":format!("usage:{input}:{output}"),"model":raw.pointer("/params/model").or_else(||raw.pointer("/params/threadSettings/model")).and_then(Value::as_str),"usage":last,"providerFormat":"codex"}),
    )
}

fn opencode_fact(data: &Value) -> Option<Value> {
    let raw = data.get("raw").unwrap_or(data);
    let info = raw
        .pointer("/params/properties/info")
        .or_else(|| raw.pointer("/properties/info"))
        .or_else(|| raw.pointer("/params/info"))
        .or_else(|| raw.get("info"))?;
    if text(info, &["role"]) != Some("assistant") {
        return None;
    }
    Some(
        json!({"requestId":text(info,&["id"])?,"model":text(info,&["modelID","model"]),"usage":info.get("tokens")?,"providerFormat":"opencode","timestamp":info.pointer("/time/completed")}),
    )
}

/// Produces the content-free Pi accounting event payload for one assistant
/// message. A missing entry id falls back to a turn/timestamp coordinate until
/// native history supplies the persisted session-tree coordinate.
pub fn pi_payload(raw: &Value, turn: Option<&str>) -> Option<Value> {
    let message = raw.get("message")?;
    if text(message, &["role"]) != Some("assistant") {
        return None;
    }
    let entry = text(raw, &["id", "entryId", "entry_id"]).map(str::to_owned);
    let at = raw.get("timestamp").and_then(timestamp);
    let (request, identity_quality) = match entry {
        Some(entry) => (entry, "exact"),
        None => (format!("turn:{}:at:{}", turn?, at.as_deref()?), "derived"),
    };
    Some(
        json!({"requestId":request,"identityQuality":identity_quality,"model":text(message,&["model"]),"usage":message.get("usage")?,"providerFormat":"pi","timestamp":raw.get("timestamp")}),
    )
}

/// Produces a Grok fact only from verified per-prompt result metadata. Durable
/// `turn_completed` updates are cumulative and must remain native-reader only.
pub fn grok_payload(update: &Value, _turn: Option<&str>) -> Option<Value> {
    let update = update.get("params").unwrap_or(update);
    let meta = update.get("_meta")?;
    Some(
        json!({"requestId":text(meta,&["promptId","prompt_id"])? ,"model":text(meta,&["modelId","model"]),"usage":meta.get("usage")?,"providerFormat":"grok","timestamp":update.get("timestamp")}),
    )
}

/// ACP context occupancy is not billable. Only a provider-emitted accounting
/// record that includes a stable request id and token buckets reaches the live
/// ledger.
pub fn acp_payload(update: &Value, _turn: Option<&str>) -> Option<Value> {
    let params = update.get("params").unwrap_or(update);
    let update = params.get("update").unwrap_or(params);
    let request = text(update, &["requestId", "request_id"])?;
    let usage = update.get("usage")?;
    if !usage.is_object() {
        return None;
    }
    Some(
        json!({"requestId":request,"model":text(update,&["model","modelId"]),"usage":usage,"providerFormat":"acp","timestamp":update.get("timestamp")}),
    )
}

/// Records an explicitly identified live request. It never inspects text,
/// tool data, context occupancy, or footer aggregates.
pub fn record(
    conn: &Connection,
    session_id: &str,
    turn: Option<&str>,
    kind: &str,
    data: &Value,
    now: &str,
) -> Result<()> {
    if !matches!(
        kind,
        "chat.turn.started"
            | "chat.turn.completed"
            | "chat.error"
            | "chat.usage.fact"
            | "provider.event"
            | "chat.item"
            | "chat.delta"
    ) {
        return Ok(());
    }
    if kind == "chat.turn.started" {
        if let Some(turn) = turn {
            conn.execute("INSERT INTO usage_live_turns(threadterm_session_id,turn_id,started_at,model) VALUES(?,?,?,?) ON CONFLICT(threadterm_session_id,turn_id) DO UPDATE SET model=COALESCE(excluded.model,usage_live_turns.model)", params![session_id,turn,now,data.get("model").and_then(Value::as_str)])?;
        }
        return Ok(());
    }
    if matches!(kind, "chat.turn.completed" | "chat.error") {
        if let Some(turn) = turn {
            let native: Option<String> = conn
                .query_row(
                    "SELECT native_id FROM sessions WHERE id=?",
                    [session_id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            if let Some(native) = native.filter(|id| id != session_id) {
                store::bind_live_native(conn, session_id, &native)?;
            }
            store::finish_live_turn(conn, session_id, turn, now)?;
        }
        return Ok(());
    }
    let (provider, native, cwd): (String, Option<String>, Option<String>) = conn.query_row(
        "SELECT provider,native_id,worktree_path FROM sessions WHERE id=?",
        [session_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let native = native.unwrap_or_else(|| session_id.to_owned());
    let payload = match kind {
        "chat.usage.fact" => Some(data.clone()),
        "provider.event" | "chat.item" | "chat.delta" if provider == "claude" => claude_fact(data),
        "provider.event" if provider == "codex" => codex_fact(data),
        "provider.event" if provider == "opencode" => opencode_fact(data),
        _ => None,
    };
    let Some(payload) = payload else {
        return Ok(());
    };
    if native != session_id {
        store::bind_live_native(conn, session_id, &native)?;
    }
    let started = turn.and_then(|turn| {
        conn.query_row(
            "SELECT started_at FROM usage_live_turns WHERE threadterm_session_id=? AND turn_id=?",
            params![session_id, turn],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
    });
    if let Some(mut fact) =
        request_fact(&provider, &native, session_id, turn, &payload, now, started)
    {
        if fact.model.is_none() {
            fact.model = turn.and_then(|turn| conn.query_row("SELECT model FROM usage_live_turns WHERE threadterm_session_id=? AND turn_id=?",params![session_id,turn],|row|row.get(0)).optional().ok().flatten());
        }
        fact.cwd = cwd;
        store::upsert_fact(conn, &fact)?;
    }
    Ok(())
}

/// Per-turn live totals for the existing footer. Only provider-reported fields
/// are emitted. Native-history facts and context occupancy are irrelevant here.
pub fn turn_usage(conn: &Connection, session_id: &str, turn: &str) -> Result<Option<Value>> {
    let provider: String = conn.query_row(
        "SELECT provider FROM sessions WHERE id=?",
        [session_id],
        |row| row.get(0),
    )?;
    let row: (Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, i64) = conn.query_row(
        "SELECT SUM(input_tokens),SUM(cache_read_tokens),SUM(cache_write5m_tokens),SUM(cache_write1h_tokens),SUM(cache_write_unknown_tokens),SUM(output_tokens),COUNT(*) FROM usage_facts WHERE threadterm_session_id=? AND turn_id=? AND source LIKE 'live:%'",
        params![session_id, turn],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
    )?;
    if row.6 == 0 {
        return Ok(None);
    }
    let cache_write = [row.2, row.3, row.4].into_iter().flatten().sum::<i64>();
    let cache_present = row.2.is_some() || row.3.is_some() || row.4.is_some();
    // Codex's legacy footer calls input inclusive; keep that presentation even
    // though the ledger stores its accounting buckets disjointly.
    let input = if provider == "codex" {
        row.0.map(|value| value + row.1.unwrap_or(0) + cache_write)
    } else {
        row.0
    };
    let mut out = serde_json::Map::new();
    if let Some(value) = input {
        out.insert("inputTokens".into(), json!(value));
    }
    if let Some(value) = row.1 {
        out.insert("cacheReadTokens".into(), json!(value));
    }
    if cache_present {
        out.insert("cacheWriteTokens".into(), json!(cache_write));
    }
    if let Some(value) = row.5 {
        out.insert("outputTokens".into(), json!(value));
    }
    let total = if provider == "codex" {
        input.unwrap_or(0) + row.5.unwrap_or(0)
    } else {
        row.0.unwrap_or(0) + row.1.unwrap_or(0) + cache_write + row.5.unwrap_or(0)
    };
    out.insert("totalTokens".into(), json!(total));
    Ok(Some(Value::Object(out)))
}

pub fn project_event(
    conn: &Connection,
    session_id: &str,
    turn: Option<&str>,
    kind: &str,
    data: &Value,
    now: &str,
) -> Result<Option<Value>> {
    record(conn, session_id, turn, kind, data, now)?;
    if matches!(kind, "chat.turn.completed" | "chat.error") {
        if let Some(turn) = turn {
            if let Some(usage) = turn_usage(conn, session_id, turn)? {
                let mut next = data.clone();
                if !next["turnUsage"].is_object() {
                    next["turnUsage"] = json!({});
                }
                for (key, value) in usage.as_object().into_iter().flatten() {
                    next["turnUsage"][key] = value.clone();
                }
                return Ok(Some(next));
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (tempfile::TempDir, Connection) {
        let root = tempfile::tempdir().unwrap();
        let conn = Connection::open(root.path().join("live.sqlite")).unwrap();
        conn.execute_batch("CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,path TEXT); CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT,worktree_path TEXT,title TEXT,provider TEXT,mode TEXT,status TEXT,created_at TEXT,updated_at TEXT,native_id TEXT,exit_code INTEGER,followed INTEGER,read_only INTEGER); CREATE TABLE usage_records(id TEXT PRIMARY KEY,session_id TEXT,provider TEXT,recorded_at TEXT,input_tokens INTEGER,output_tokens INTEGER,estimated_cost REAL,currency TEXT,model TEXT);").unwrap();
        conn.execute("INSERT INTO sessions VALUES('s',NULL,'/repo','t','claude','chat','idle','n','n','native',NULL,0,0)",[]).unwrap();
        store::initialize(&conn).unwrap();
        initialize(&conn).unwrap();
        (root, conn)
    }

    #[test]
    fn records_multiple_calls_and_merges_a_repeated_snapshot() {
        let (_root, conn) = db();
        record(
            &conn,
            "s",
            Some("t"),
            "chat.turn.started",
            &json!({}),
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        for (id, output) in [("a", 2), ("b", 3), ("b", 4)] {
            record(&conn,"s",Some("t"),"provider.event",&json!({"raw":{"speedCallId":id,"message":{"message":{"id":id,"usage":{"input_tokens":1,"output_tokens":output}}}}}),"2026-01-01T00:00:01Z").unwrap();
        }
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_facts", [], |row| row.get(0))
            .unwrap();
        let output: i64 = conn
            .query_row("SELECT SUM(output_tokens) FROM usage_facts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!((count, output), (2, 6));
    }

    #[test]
    fn context_and_unidentified_acp_usage_are_not_billed() {
        let (_root, conn) = db();
        record(
            &conn,
            "s",
            Some("t"),
            "chat.context",
            &json!({"usage":{"inputTokens":999}}),
            "n",
        )
        .unwrap();
        assert!(acp_payload(
            &json!({"params":{"update":{"sessionUpdate":"usage_update","used":999,"size":1000}}}),
            Some("t")
        )
        .is_none());
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_facts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn provider_sanitizers_keep_only_identified_usage_coordinates() {
        let pi = pi_payload(&json!({"type":"message_end","entryId":"entry","timestamp":1,"message":{"role":"assistant","model":"p","usage":{"input":1,"output":2}}}), Some("turn")).unwrap();
        assert_eq!(pi["requestId"], "entry");
        assert!(pi.get("message").is_none());
        let fallback = pi_payload(&json!({"type":"message_end","timestamp":2,"message":{"role":"assistant","usage":{"input":3,"output":4,"cost":{"total":1.5}}}}), Some("turn")).unwrap();
        assert_eq!(fallback["identityQuality"], "derived");
        let grok = grok_payload(&json!({"params":{"timestamp":2,"_meta":{"promptId":"prompt","usage":{"inputTokens":3,"outputTokens":4}}}}), Some("turn")).unwrap();
        assert_eq!(grok["requestId"], "prompt");
        assert!(grok_payload(&json!({"params":{"update":{"sessionUpdate":"turn_completed","prompt_id":"cumulative","usage":{"inputTokens":999}}}}), Some("turn")).is_none());
        let acp = acp_payload(&json!({"params":{"update":{"requestId":"request","usage":{"inputTokens":5,"outputTokens":6}}}}), Some("turn")).unwrap();
        assert_eq!(acp["requestId"], "request");
    }

    #[test]
    fn captures_claude_item_raw_and_uses_threadterm_identity_before_native_binding() {
        let (_root, conn) = db();
        conn.execute("UPDATE sessions SET native_id=NULL WHERE id='s'", [])
            .unwrap();
        record(
            &conn,
            "s",
            Some("t"),
            "chat.turn.started",
            &json!({}),
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        record(&conn,"s",Some("t"),"chat.item",&json!({"raw":{"speedCallId":"call","message":{"message":{"id":"call","usage":{"input_tokens":2,"output_tokens":3}}}}}),"2026-01-01T00:00:01Z").unwrap();
        let native: String = conn
            .query_row("SELECT native_session_id FROM usage_facts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(native, "s");
    }

    #[test]
    fn opencode_properties_shape_is_an_accounting_fact() {
        let payload = opencode_fact(&json!({"raw":{"params":{"properties":{"info":{"id":"message","role":"assistant","modelID":"model","tokens":{"input":1,"output":2,"reasoning":3,"cache":{"write":4}},"time":{"completed":1}}}}}})).unwrap();
        assert_eq!(payload["requestId"], "message");
        let buckets = usage_buckets("opencode", &payload["usage"]);
        assert_eq!(buckets.output, Some(5));
        assert_eq!(buckets.cache_write_unknown, Some(4));
    }
}
