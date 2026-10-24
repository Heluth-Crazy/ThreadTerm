//! Privacy-preserving extraction of per-request live provider usage.
//!
//! This module accepts only explicitly identified request facts. Context-window
//! snapshots and footer totals are deliberately not additive accounting input.

use super::{
    facts::{number, text, timestamp, Buckets, Fact},
    ledger_db, store,
};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

/// Ledger-owned turn coordinates for the live footer.
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

/// Durable, append-only log of the live request facts the Chat projection sees.
/// It stays in the main database (written inside the Chat transaction) so the
/// rebuildable ledger copy can always be recreated.
pub fn initialize_log(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_live_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fact_key TEXT NOT NULL,
            threadterm_session_id TEXT,
            turn_id TEXT,
            created_at TEXT NOT NULL,
            fact TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS usage_live_events_turn
            ON usage_live_events(threadterm_session_id,turn_id);
        CREATE INDEX IF NOT EXISTS usage_live_events_fact
            ON usage_live_events(fact_key);",
    )?;
    // One small row per provider request; keep the log bounded without timers.
    conn.execute(
        "DELETE FROM usage_live_events WHERE id<=(
            SELECT COALESCE(MAX(id),0)-200000 FROM usage_live_events)",
        [],
    )?;
    Ok(())
}

const LOG_CURSOR_KEY: &str = "live-events-cursor";

/// Copies log rows the live forwarder could not apply while the history worker
/// held the ledger. Runs on the ledger worker only.
pub fn import_log(conn: &Connection, cancelled: &AtomicBool) -> Result<()> {
    let mut cursor = conn
        .query_row(
            "SELECT value FROM usage_ledger_state WHERE key=?",
            [LOG_CURSOR_KEY],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(());
        }
        let rows = {
            let mut statement = conn.prepare_cached(
                "SELECT id,fact FROM usage_live_events WHERE id>? ORDER BY id LIMIT 256",
            )?;
            let rows = statement
                .query_map([cursor], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        if rows.is_empty() {
            return Ok(());
        }
        let facts = rows
            .iter()
            .filter_map(|(_, raw)| serde_json::from_str::<Fact>(raw).ok())
            .collect::<Vec<_>>();
        if !facts.is_empty() {
            store::upsert_facts(conn, &facts)?;
        }
        cursor = rows.last().map(|(id, _)| *id).unwrap_or(cursor);
        conn.execute(
            "INSERT INTO usage_ledger_state(key,value) VALUES(?,?)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![LOG_CURSOR_KEY, cursor.to_string()],
        )?;
        if rows.len() < 256 {
            return Ok(());
        }
    }
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
///
/// The durability boundary is the main database's append-only log; the ledger
/// copy is a best-effort forward so a busy history worker never blocks Chat.
pub fn record(
    main: &Connection,
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
    let Some(path) = main.path() else {
        return record_with(main, main, session_id, turn, kind, data, now);
    };
    let Ok(ledger) = ledger_db::live_connection(std::path::Path::new(path)) else {
        return record_with(main, main, session_id, turn, kind, data, now);
    };
    let Ok(guard) = ledger.lock() else {
        return Ok(());
    };
    // A failed forward is not fatal: the log row the next scan imports holds the
    // same fact.
    let _ = record_with(main, &guard, session_id, turn, kind, data, now);
    Ok(())
}

fn record_with(
    main: &Connection,
    ledger: &Connection,
    session_id: &str,
    turn: Option<&str>,
    kind: &str,
    data: &Value,
    now: &str,
) -> Result<()> {
    if kind == "chat.turn.started" {
        if let Some(turn) = turn {
            ledger.execute("INSERT INTO usage_live_turns(threadterm_session_id,turn_id,started_at,model) VALUES(?,?,?,?) ON CONFLICT(threadterm_session_id,turn_id) DO UPDATE SET model=COALESCE(excluded.model,usage_live_turns.model)", params![session_id,turn,now,data.get("model").and_then(Value::as_str)])?;
        }
        return Ok(());
    }
    if matches!(kind, "chat.turn.completed" | "chat.error") {
        if let Some(turn) = turn {
            let native: Option<String> = main
                .query_row(
                    "SELECT native_id FROM sessions WHERE id=?",
                    [session_id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            if let Some(native) = native.filter(|id| id != session_id) {
                store::bind_live_native(ledger, session_id, &native)?;
            }
            store::finish_live_turn(ledger, session_id, turn, now)?;
        }
        return Ok(());
    }
    let (provider, native, cwd): (String, Option<String>, Option<String>) = main.query_row(
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
    let started = turn.and_then(|turn| {
        ledger
            .query_row(
                "SELECT started_at FROM usage_live_turns WHERE threadterm_session_id=? AND turn_id=?",
                params![session_id, turn],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten()
    });
    let Some(mut fact) =
        request_fact(&provider, &native, session_id, turn, &payload, now, started)
    else {
        return Ok(());
    };
    if fact.model.is_none() {
        fact.model = turn.and_then(|turn| ledger.query_row("SELECT model FROM usage_live_turns WHERE threadterm_session_id=? AND turn_id=?",params![session_id,turn],|row|row.get(0)).optional().ok().flatten());
    }
    fact.cwd = cwd;
    if native != session_id {
        store::bind_live_native(ledger, session_id, &native)?;
    }
    main.execute(
        "INSERT INTO usage_live_events(fact_key,threadterm_session_id,turn_id,created_at,fact)
         VALUES(?,?,?,?,?)",
        params![
            fact.key,
            fact.threadterm_session_id,
            fact.turn_id,
            now,
            serde_json::to_string(&fact)?
        ],
    )?;
    if !std::ptr::eq(main, ledger) {
        store::upsert_fact(ledger, &fact)?;
    }
    Ok(())
}

/// Per-turn live totals for the existing footer. Only provider-reported fields
/// are emitted. Native-history facts and context occupancy are irrelevant here.
/// The ledger copy and the durable main-database log are merged by fact key, so
/// a fact the worker could not forward is still shown once and only once.
pub fn turn_usage(main: &Connection, session_id: &str, turn: &str) -> Result<Option<Value>> {
    let provider: String = main.query_row(
        "SELECT provider FROM sessions WHERE id=?",
        [session_id],
        |row| row.get(0),
    )?;
    let ledger = main
        .path()
        .and_then(|path| ledger_db::live_connection(std::path::Path::new(path)).ok());
    let ledger_guard = ledger.as_ref().and_then(|conn| conn.lock().ok());
    let ledger: &Connection = ledger_guard.as_deref().unwrap_or(main);
    let mut facts: std::collections::BTreeMap<String, Buckets> = Default::default();
    {
        let mut statement = ledger.prepare_cached(
            "SELECT fact_key,input_tokens,cache_read_tokens,cache_write5m_tokens,
                    cache_write1h_tokens,cache_write_unknown_tokens,output_tokens,
                    reasoning_tokens
             FROM usage_facts
             WHERE threadterm_session_id=? AND turn_id=? AND source LIKE 'live:%'",
        )?;
        let rows = statement.query_map(params![session_id, turn], |row| {
            Ok((
                row.get::<_, String>(0)?,
                Buckets {
                    input: row.get(1)?,
                    cache_read: row.get(2)?,
                    cache_write5m: row.get(3)?,
                    cache_write1h: row.get(4)?,
                    cache_write_unknown: row.get(5)?,
                    output: row.get(6)?,
                    reasoning: row.get(7)?,
                },
            ))
        })?;
        for row in rows {
            let (key, buckets) = row?;
            facts.entry(key).or_default().merge_max(&buckets);
        }
    }
    if let Ok(mut statement) = main.prepare(
        "SELECT fact FROM usage_live_events WHERE threadterm_session_id=? AND turn_id=?",
    ) {
        if let Ok(rows) = statement
            .query_map(params![session_id, turn], |row| row.get::<_, String>(0))
        {
            for raw in rows.flatten() {
                if let Ok(fact) = serde_json::from_str::<Fact>(&raw) {
                    facts
                        .entry(fact.key)
                        .or_default()
                        .merge_max(&fact.buckets);
                }
            }
        }
    }
    if facts.is_empty() {
        return Ok(None);
    }
    fn sum(values: impl Iterator<Item = Option<i64>>) -> Option<i64> {
        let mut total = None;
        for value in values.flatten() {
            total = Some(total.unwrap_or(0) + value);
        }
        total
    }
    let rows = facts.values();
    let input = sum(rows.clone().map(|b| b.input));
    let cache_read = sum(rows.clone().map(|b| b.cache_read));
    let cache5m = sum(rows.clone().map(|b| b.cache_write5m));
    let cache1h = sum(rows.clone().map(|b| b.cache_write1h));
    let cache_unknown = sum(rows.clone().map(|b| b.cache_write_unknown));
    let output = sum(rows.clone().map(|b| b.output));
    let cache_write = [cache5m, cache1h, cache_unknown]
        .into_iter()
        .flatten()
        .sum::<i64>();
    let cache_present = cache5m.is_some() || cache1h.is_some() || cache_unknown.is_some();
    // Codex's legacy footer calls input inclusive; keep that presentation even
    // though the ledger stores its accounting buckets disjointly.
    let input = if provider == "codex" {
        input.map(|value| value + cache_read.unwrap_or(0) + cache_write)
    } else {
        input
    };
    let mut out = serde_json::Map::new();
    if let Some(value) = input {
        out.insert("inputTokens".into(), json!(value));
    }
    if let Some(value) = cache_read {
        out.insert("cacheReadTokens".into(), json!(value));
    }
    if cache_present {
        out.insert("cacheWriteTokens".into(), json!(cache_write));
    }
    if let Some(value) = output {
        out.insert("outputTokens".into(), json!(value));
    }
    let total = if provider == "codex" {
        input.unwrap_or(0) + output.unwrap_or(0)
    } else {
        input.unwrap_or(0) + cache_read.unwrap_or(0) + cache_write + output.unwrap_or(0)
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

    /// Ledger connection plus the main-database connection the Chat projection
    /// owns.
    fn db() -> (tempfile::TempDir, Connection, Connection) {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("live.sqlite");
        let database = crate::db::Database::open(&path).unwrap();
        drop(database);
        let main = Connection::open(&path).unwrap();
        main.execute("INSERT INTO sessions(id,project_id,worktree_path,title,provider,mode,status,created_at,updated_at,native_id,followed,read_only) VALUES('s',NULL,'/repo','t','claude','chat','idle','n','n','native',0,0)",[]).unwrap();
        let conn = super::ledger_db::test_connection(&path).unwrap();
        (root, main, conn)
    }

    #[test]
    fn records_multiple_calls_and_merges_a_repeated_snapshot() {
        let (_root, main, conn) = db();
        record_with(
            &main,
            &conn,
            "s",
            Some("t"),
            "chat.turn.started",
            &json!({}),
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        for (id, output) in [("a", 2), ("b", 3), ("b", 4)] {
            record_with(&main,&conn,"s",Some("t"),"provider.event",&json!({"raw":{"speedCallId":id,"message":{"message":{"id":id,"usage":{"input_tokens":1,"output_tokens":output}}}}}),"2026-01-01T00:00:01Z").unwrap();
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
        let (_root, main, conn) = db();
        record_with(
            &main,
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
        let (_root, main, conn) = db();
        main.execute("UPDATE sessions SET native_id=NULL WHERE id='s'", [])
            .unwrap();
        record_with(
            &main,
            &conn,
            "s",
            Some("t"),
            "chat.turn.started",
            &json!({}),
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        record_with(&main,&conn,"s",Some("t"),"chat.item",&json!({"raw":{"speedCallId":"call","message":{"message":{"id":"call","usage":{"input_tokens":2,"output_tokens":3}}}}}),"2026-01-01T00:00:01Z").unwrap();
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
