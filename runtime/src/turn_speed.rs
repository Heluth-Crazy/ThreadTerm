//! Provider-neutral, monotonic turn measurement. Live samples stay in memory;
//! only the terminal event receives the snapshot used by the saved footer.
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Instant,
};
use tokio::sync::broadcast;

fn wide(c: char) -> bool {
    matches!(c as u32, 0x1100..=0x11ff | 0x2e80..=0xa4cf | 0xa960..=0xa97f |
        0xac00..=0xd7ff | 0xf900..=0xfaff | 0xfe10..=0xfe6f | 0xff01..=0xff60 |
        0xffe0..=0xffee | 0x1aff0..=0x1b2ff | 0x20000..=0x323af)
}

#[derive(Clone, Default)]
struct Estimate {
    tokens: u64,
    run: u64,
}
impl Estimate {
    fn append(&mut self, text: &str) {
        for c in text.chars() {
            if c.is_whitespace() {
                self.run = 0;
            } else if wide(c) {
                self.tokens += 1;
                self.run = 0;
            } else {
                if self.run.is_multiple_of(4) {
                    self.tokens += 1;
                }
                self.run += 1;
            }
        }
    }
    fn from(text: &str) -> Self {
        let mut value = Self::default();
        value.append(text);
        value
    }
}

pub fn estimate_output_tokens(text: &str) -> u64 {
    Estimate::from(text).tokens
}

#[derive(Clone, Default)]
struct Output {
    estimate: Estimate,
    call: Option<String>,
}
#[derive(Clone, Default)]
struct Call {
    tokens: u64,
    estimate_at_report: u64,
}

#[derive(Clone)]
pub struct TurnSpeed {
    start: u64,
    first: Option<u64>,
    excluded: u64,
    blocked_since: Option<u64>,
    blockers: HashSet<String>,
    outputs: HashMap<String, Output>,
    calls: HashMap<String, Call>,
    turn_total: Option<u64>,
    per_call: bool,
    native_usage: Value,
    last_live: Option<u64>,
    finished: bool,
}

impl TurnSpeed {
    pub fn new(now: u64) -> Self {
        Self {
            start: now,
            first: None,
            excluded: 0,
            blocked_since: None,
            blockers: HashSet::new(),
            outputs: HashMap::new(),
            calls: HashMap::new(),
            turn_total: None,
            per_call: false,
            native_usage: json!({}),
            last_live: None,
            finished: false,
        }
    }
    fn first_output(&mut self, now: u64) {
        self.first.get_or_insert(now.saturating_sub(self.start));
    }
    fn block(&mut self, key: String, active: bool, now: u64) {
        if active {
            if self.blockers.is_empty() {
                self.blocked_since = Some(now);
            }
            self.blockers.insert(key);
        } else if self.blockers.remove(&key) && self.blockers.is_empty() {
            self.excluded += now.saturating_sub(self.blocked_since.take().unwrap_or(now));
        }
    }
    fn output(&mut self, key: String, text: &str, delta: bool, call: Option<&str>, now: u64) {
        if text.is_empty() {
            return;
        }
        self.first_output(now);
        let key = call.map(|call| format!("{call}:{key}")).unwrap_or(key);
        let output = self.outputs.entry(key).or_default();
        if let Some(call) = call {
            output.call = Some(call.into());
        }
        if delta {
            output.estimate.append(text);
        } else {
            output.estimate = Estimate::from(text);
        }
    }
    fn call_usage(&mut self, id: &str, tokens: u64) {
        self.per_call = true;
        self.turn_total = None;
        // Adapters supply a native message/call id. Codex may deliver the usage
        // after its last text part: bind all not-yet-attributed parts to it.
        for output in self.outputs.values_mut() {
            if output.call.is_none() {
                output.call = Some(id.into());
            }
        }
        let estimated = self
            .outputs
            .values()
            .filter(|output| output.call.as_deref() == Some(id))
            .map(|output| output.estimate.tokens)
            .sum();
        self.calls.insert(
            id.into(),
            Call {
                tokens,
                estimate_at_report: estimated,
            },
        );
    }
    pub fn usage(&self, now: u64) -> Option<Value> {
        self.first?;
        let generation = now
            .saturating_sub(self.start)
            .saturating_sub(self.excluded)
            .saturating_sub(
                self.blocked_since
                    .map(|start| now.saturating_sub(start))
                    .unwrap_or(0),
            );
        let mut tokens = self.turn_total.unwrap_or(0);
        let mut estimated = self.turn_total.is_none() && self.calls.is_empty();
        if self.turn_total.is_none() {
            tokens = self.calls.values().map(|call| call.tokens).sum();
            let mut estimates: HashMap<Option<&str>, u64> = HashMap::new();
            for output in self.outputs.values() {
                *estimates.entry(output.call.as_deref()).or_default() += output.estimate.tokens;
            }
            for (id, count) in estimates {
                let remainder = id
                    .and_then(|id| self.calls.get(id))
                    .map(|call| count.saturating_sub(call.estimate_at_report))
                    .unwrap_or(count);
                tokens += remainder;
                estimated |= remainder > 0;
            }
        }
        Some(
            json!({"outputTokens":tokens,"generationMs":generation,"firstTokenMs":self.first.unwrap(),"outputTokensEstimated":estimated}),
        )
    }
    fn live(&mut self, now: u64) -> Option<Value> {
        if self.finished
            || !self.blockers.is_empty()
            || self
                .last_live
                .is_some_and(|last| now.saturating_sub(last) < 500)
        {
            return None;
        }
        let usage = self.usage(now)?;
        if usage["generationMs"].as_u64()? < 250 || usage["outputTokens"].as_u64()? < 1 {
            return None;
        }
        self.last_live = Some(now);
        Some(usage)
    }
    fn part(
        &mut self,
        item: &str,
        index: usize,
        part: &Value,
        delta: bool,
        call: Option<&str>,
        now: u64,
    ) {
        let kind = part["type"].as_str().unwrap_or("");
        match kind {
            "text" | "thinking" | "reasoning" => {
                let id = part
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| index.to_string());
                self.output(
                    format!("{item}:{kind}:{id}"),
                    part["text"].as_str().unwrap_or(""),
                    delta,
                    call,
                    now,
                );
            }
            "tool" => {
                self.first_output(now);
                let id = part["toolId"].as_str().unwrap_or(item);
                let status = part["status"].as_str().unwrap_or("running");
                if matches!(
                    status,
                    "running" | "inProgress" | "in_progress" | "in-progress"
                ) {
                    self.block(format!("tool:{id}"), true, now);
                } else if matches!(
                    status,
                    "completed"
                        | "complete"
                        | "failed"
                        | "error"
                        | "cancelled"
                        | "canceled"
                        | "interrupted"
                ) {
                    self.block(format!("tool:{id}"), false, now);
                }
            }
            _ => {}
        }
    }
    pub fn observe(&mut self, kind: &str, data: &Value, now: u64) {
        if self.finished {
            return;
        }
        if let Some(usage) = data.get("turnUsage").filter(|usage| usage.is_object()) {
            self.native_usage = usage.clone();
        }
        if !self.per_call {
            if let Some(total) = data
                .pointer("/turnUsage/outputTokens")
                .and_then(Value::as_u64)
            {
                if data
                    .pointer("/turnUsage/outputTokensEstimated")
                    .and_then(Value::as_bool)
                    != Some(true)
                {
                    self.turn_total = Some(total);
                }
            }
        }
        let item = data
            .pointer("/item/id")
            .or_else(|| data.pointer("/raw/params/itemId"))
            .or_else(|| data.pointer("/raw/params/item/id"))
            .and_then(Value::as_str)
            .unwrap_or("current");
        let call = data.get("speedCallId").and_then(Value::as_str);
        match kind {
            "chat.speed.usage" => {
                if let (Some(id), Some(tokens)) =
                    (data["callId"].as_str(), data["outputTokens"].as_u64())
                {
                    self.call_usage(id, tokens);
                }
            }
            "chat.delta" => {
                if let Some(part) = data.get("part") {
                    self.part(item, 0, part, true, call, now);
                } else if let Some(text) = data["text"].as_str() {
                    self.output(format!("{item}:text:0"), text, true, call, now);
                }
            }
            "chat.item" => {
                // Claude's hidden thinking can remain a native event rather
                // than a projected part; it still contributes to generation.
                if let Some(thinking) = data
                    .pointer("/raw/message/event/delta/thinking")
                    .and_then(Value::as_str)
                {
                    self.output(format!("{item}:thinking:0"), thinking, true, call, now);
                }
                if data.pointer("/item/role").and_then(Value::as_str) == Some("user") {
                    return;
                }
                if let Some(parts) = data.get("parts").and_then(Value::as_array) {
                    for (index, part) in parts.iter().enumerate() {
                        self.part(item, index, part, false, call, now);
                    }
                } else if let Some(part) = data.get("part") {
                    self.part(item, 0, part, false, call, now);
                } else if let Some(raw) = data
                    .get("item")
                    .filter(|raw| raw.get("type").is_some())
                    .or_else(|| data.pointer("/raw/params/item"))
                {
                    let kind = raw["type"].as_str().unwrap_or("");
                    if matches!(
                        kind,
                        "agentMessage"
                            | "assistant"
                            | "message"
                            | "reasoning"
                            | "thinking"
                            | "agentThought"
                    ) {
                        let text = raw
                            .get("text")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .unwrap_or_else(|| {
                                raw.get("content")
                                    .or_else(|| raw.get("summary"))
                                    .and_then(Value::as_array)
                                    .map(|parts| {
                                        parts
                                            .iter()
                                            .filter_map(|part| part["text"].as_str())
                                            .collect::<Vec<_>>()
                                            .join("\n")
                                    })
                                    .unwrap_or_default()
                            });
                        let part = json!({"type":if matches!(kind,"reasoning"|"thinking"|"agentThought") {"thinking"} else {"text"},"text":text});
                        self.part(item, 0, &part, false, call, now);
                    } else if kind != "userMessage" && !kind.is_empty() {
                        self.part(item, 0, &json!({"type":"tool","toolId":item,"status":raw.get("status").and_then(Value::as_str).unwrap_or("running")}), false, call, now);
                    }
                }
            }
            "chat.approval" => {
                self.first_output(now);
                let id = data
                    .get("approvalId")
                    .or_else(|| data.pointer("/part/approvalId"))
                    .and_then(Value::as_str)
                    .unwrap_or(item);
                self.block(format!("wait:{id}"), true, now);
            }
            "chat.approval.resolved" => {
                let id = data["approvalId"].as_str().unwrap_or(item);
                if data["status"] != "outcomeUnknown" {
                    self.block(format!("wait:{id}"), false, now);
                }
            }
            _ => {}
        }
    }
}

struct Active {
    turn: String,
    tracker: TurnSpeed,
    live_visible: bool,
}
pub struct TurnSpeeds {
    origin: Instant,
    active: Mutex<HashMap<String, Active>>,
    push: broadcast::Sender<Value>,
}
impl Default for TurnSpeeds {
    fn default() -> Self {
        Self {
            origin: Instant::now(),
            active: Mutex::new(HashMap::new()),
            push: broadcast::channel(64).0,
        }
    }
}
impl TurnSpeeds {
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.push.subscribe()
    }
    /// Called only on accepted events, including app-hosted questions. History,
    /// child transcript observations and terminal sessions never start trackers.
    pub fn observe(&self, session: &str, turn: Option<&str>, kind: &str, data: &Value) -> Value {
        self.observe_at(
            session,
            turn,
            kind,
            data,
            self.origin.elapsed().as_millis().min(u64::MAX as u128) as u64,
        )
    }
    fn observe_at(
        &self,
        session: &str,
        turn: Option<&str>,
        kind: &str,
        data: &Value,
        now: u64,
    ) -> Value {
        let mut result = data.clone();
        let mut active = self.active.lock().expect("turn speed lock poisoned");
        if kind == "chat.turn.started" {
            if let Some(turn) = turn {
                if active.get(session).is_some_and(|entry| entry.turn == turn) {
                    return result;
                }
                active.insert(
                    session.into(),
                    Active {
                        turn: turn.into(),
                        tracker: TurnSpeed::new(now),
                        live_visible: false,
                    },
                );
                let _ = self
                    .push
                    .send(json!({"sessionId":session,"turnId":turn,"active":true}));
            }
            return result;
        }
        let Some(entry) = active.get_mut(session) else {
            return result;
        };
        if turn.is_some_and(|turn| turn != entry.turn) {
            return result;
        }
        entry.tracker.observe(kind, data, now);
        if kind == "chat.context" && entry.tracker.per_call {
            // These providers' legacy context footer payloads describe only a
            // call. Freeze the aggregate once, on the terminal event instead.
            if let Some(object) = result.as_object_mut() {
                object.remove("turnUsage");
            }
        }
        let connection_ended = kind == "chat.connection"
            && matches!(
                data["phase"].as_str(),
                Some("connecting" | "failed" | "disconnected" | "unavailable")
            );
        if connection_ended
            || matches!(
                kind,
                "chat.turn.completed" | "chat.error" | "session.closed"
            )
        {
            if let Some(usage) = entry.tracker.usage(now) {
                let mut native = entry.tracker.native_usage.clone();
                if entry.tracker.per_call {
                    if let Some(object) = native.as_object_mut() {
                        object.remove("outputTokens");
                        object.remove("outputTokensEstimated");
                    }
                }
                result["turnUsage"] = merge_usage(Some(&native), &usage);
                if kind == "session.closed" || connection_ended || turn.is_none() {
                    result["speedTurnId"] = json!(entry.turn);
                }
            }
            entry.tracker.finished = true;
            let _ = self
                .push
                .send(json!({"sessionId":session,"turnId":entry.turn,"active":false}));
            active.remove(session);
        } else if let Some(usage) = entry.tracker.live(now) {
            entry.live_visible = true;
            let _ = self
                .push
                .send(json!({"sessionId":session,"turnId":entry.turn,"active":true,"usage":usage}));
        } else if entry.live_visible && !entry.tracker.blockers.is_empty() {
            // A clear is a lifecycle notification, not a speed sample. No stale
            // number remains visible while tools or user input own the turn.
            let _ = self
                .push
                .send(json!({"sessionId":session,"turnId":entry.turn,"active":true}));
            entry.live_visible = false;
        }
        result
    }
}

pub fn merge_usage(previous: Option<&Value>, measured: &Value) -> Value {
    let mut result = previous
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let exact = result.get("outputTokens").is_some()
        && result.get("outputTokensEstimated") != Some(&Value::Bool(true))
        && measured.get("outputTokensEstimated") == Some(&Value::Bool(true));
    if let Some(fields) = measured.as_object() {
        for (key, value) in fields {
            if exact && matches!(key.as_str(), "outputTokens" | "outputTokensEstimated") {
                continue;
            }
            result[key] = value.clone();
        }
    }
    if exact
        || (measured.get("outputTokens").is_some()
            && measured.get("outputTokensEstimated") != Some(&Value::Bool(true)))
    {
        result["outputTokensEstimated"] = json!(false);
    }
    result
}

pub fn shared(path: &Path) -> Arc<TurnSpeeds> {
    static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Weak<TurnSpeeds>>>> = OnceLock::new();
    let mut registry = REGISTRY
        .get_or_init(Mutex::default)
        .lock()
        .expect("turn speed registry lock poisoned");
    registry.retain(|_, value| value.strong_count() > 0);
    if let Some(value) = registry.get(path).and_then(Weak::upgrade) {
        return value;
    }
    let value = Arc::new(TurnSpeeds::default());
    registry.insert(path.to_owned(), Arc::downgrade(&value));
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    fn text(tracker: &mut TurnSpeed, value: &str, now: u64) {
        tracker.observe(
            "chat.delta",
            &json!({"part":{"type":"text","text":value}}),
            now,
        );
    }
    fn tool(tracker: &mut TurnSpeed, id: &str, status: &str, now: u64) {
        tracker.observe(
            "chat.item",
            &json!({"part":{"type":"tool","toolId":id,"status":status}}),
            now,
        );
    }
    #[test]
    fn estimator_fixed_vectors_and_delta_boundaries() {
        for (value, count) in [
            ("", 0),
            (" \n\t", 0),
            ("hello world!", 4),
            ("abcdefgh", 2),
            ("中文かなカナ한글Ａ！", 10),
            ("abc中defgh", 4),
            ("😀😀😀😀😀", 2),
        ] {
            assert_eq!(estimate_output_tokens(value), count, "{value}");
            let mut streamed = Estimate::default();
            for c in value.chars() {
                streamed.append(&c.to_string());
            }
            assert_eq!(streamed.tokens, count);
        }
    }
    #[test]
    fn single_tool_excludes_execution_but_keeps_first_token_latency() {
        let mut tracker = TurnSpeed::new(0);
        tool(&mut tracker, "tool", "running", 400);
        tool(&mut tracker, "tool", "completed", 1400);
        text(&mut tracker, "abcdefgh", 1600);
        let usage = tracker.usage(2000).unwrap();
        assert_eq!(usage["generationMs"], 1000);
        assert_eq!(usage["firstTokenMs"], 400);
        assert_eq!(usage["outputTokens"], 2);
    }
    #[test]
    fn parallel_tools_and_approval_wait_are_a_union() {
        let mut tracker = TurnSpeed::new(0);
        tool(&mut tracker, "a", "running", 100);
        tool(&mut tracker, "b", "inProgress", 200);
        tracker.observe("chat.approval", &json!({"approvalId":"q"}), 300);
        tool(&mut tracker, "a", "completed", 400);
        tool(&mut tracker, "b", "failed", 600);
        tracker.observe(
            "chat.approval.resolved",
            &json!({"approvalId":"q","status":"answered"}),
            800,
        );
        assert_eq!(tracker.usage(1000).unwrap()["generationMs"], 300);
    }
    #[test]
    fn duplicate_tool_updates_and_unknown_resolutions_do_not_change_intervals() {
        let mut tracker = TurnSpeed::new(0);
        tool(&mut tracker, "a", "running", 100);
        tool(&mut tracker, "a", "running", 200);
        tracker.observe(
            "chat.approval.resolved",
            &json!({"approvalId":"unknown"}),
            300,
        );
        tool(&mut tracker, "a", "cancelled", 600);
        assert_eq!(tracker.usage(1000).unwrap()["generationMs"], 500);
    }
    #[test]
    fn no_output_and_small_sample_guard() {
        let mut tracker = TurnSpeed::new(0);
        assert!(tracker.usage(1000).is_none());
        text(&mut tracker, "a", 100);
        assert!(tracker.live(249).is_none());
        assert!(tracker.live(250).is_some());
    }
    #[test]
    fn per_call_reports_replace_estimates_and_accumulate_across_two_calls() {
        let mut tracker = TurnSpeed::new(0);
        text(&mut tracker, "abcdefgh", 100);
        tracker.observe(
            "chat.speed.usage",
            &json!({"callId":"a","outputTokens":10}),
            200,
        );
        tracker.observe(
            "chat.delta",
            &json!({"item":{"id":"second"},"part":{"type":"thinking","text":"reasoning"}}),
            300,
        );
        let partial = tracker.usage(500).unwrap();
        assert_eq!(partial["outputTokens"], 13);
        assert_eq!(partial["outputTokensEstimated"], true);
        tracker.observe(
            "chat.speed.usage",
            &json!({"callId":"b","outputTokens":20}),
            600,
        );
        tracker.observe(
            "chat.speed.usage",
            &json!({"callId":"b","outputTokens":21}),
            650,
        );
        let done = tracker.usage(1000).unwrap();
        assert_eq!(done["outputTokens"], 31);
        assert_eq!(done["outputTokensEstimated"], false);
    }
    #[test]
    fn message_usage_does_not_absorb_another_messages_estimate() {
        let mut tracker = TurnSpeed::new(0);
        for (id, value) in [("a", "one"), ("b", "two")] {
            tracker.observe(
                "chat.item",
                &json!({"speedCallId":id,"item":{"id":id},"parts":[{"type":"text","text":value}]}),
                100,
            );
        }
        tracker.observe(
            "chat.speed.usage",
            &json!({"callId":"a","outputTokens":12}),
            200,
        );
        assert_eq!(tracker.usage(400).unwrap()["outputTokens"], 13);
        assert_eq!(tracker.usage(400).unwrap()["outputTokensEstimated"], true);
        tracker.observe(
            "chat.speed.usage",
            &json!({"callId":"b","outputTokens":14}),
            500,
        );
        assert_eq!(tracker.usage(800).unwrap()["outputTokens"], 26);
    }
    #[test]
    fn turn_totals_replace_estimates_for_grok_and_pi() {
        for provider in ["grok", "pi"] {
            let mut tracker = TurnSpeed::new(0);
            text(&mut tracker, "a streamed answer", 100);
            tracker.observe(
                "chat.context",
                &json!({"turnUsage":{"outputTokens":42}}),
                400,
            );
            assert_eq!(
                tracker.usage(1000).unwrap()["outputTokens"],
                42,
                "{provider}"
            );
            assert_eq!(tracker.usage(1000).unwrap()["outputTokensEstimated"], false);
        }
    }
    #[test]
    fn snapshot_replacements_and_reasoning_do_not_double_count() {
        let mut tracker = TurnSpeed::new(0);
        for _ in 0..2 {
            tracker.observe("chat.item",&json!({"parts":[{"type":"text","text":"abcdefgh"},{"type":"thinking","text":"中文"}]}),100);
        }
        assert_eq!(tracker.usage(500).unwrap()["outputTokens"], 4);
        assert_eq!(tracker.usage(500).unwrap()["outputTokensEstimated"], true);
    }
    #[test]
    fn interrupted_turn_measures_open_wait_and_stops_live_pushes() {
        let speeds = TurnSpeeds::default();
        let mut live = speeds.subscribe();
        speeds.observe_at("s", Some("t"), "chat.turn.started", &json!({}), 0);
        speeds.observe_at(
            "s",
            Some("t"),
            "chat.delta",
            &json!({"text":"abcdefgh"}),
            300,
        );
        speeds.observe_at(
            "s",
            Some("t"),
            "chat.approval",
            &json!({"approvalId":"q"}),
            500,
        );
        let done = speeds.observe_at(
            "s",
            Some("t"),
            "chat.turn.completed",
            &json!({"status":"interrupted"}),
            1500,
        );
        assert_eq!(done["turnUsage"]["generationMs"], 500);
        assert_eq!(done["turnUsage"]["outputTokens"], 2);
        let events = std::iter::from_fn(|| live.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(events.last().unwrap()["active"], false);
        speeds.observe_at("s", Some("t"), "chat.delta", &json!({"text":"late"}), 2000);
        assert!(live.try_recv().is_err());
    }
    #[test]
    fn live_samples_are_throttled_to_two_per_second() {
        let speeds = TurnSpeeds::default();
        let mut live = speeds.subscribe();
        speeds.observe_at("s", Some("t"), "chat.turn.started", &json!({}), 0);
        for now in (0..2000).step_by(10) {
            speeds.observe_at("s", Some("t"), "chat.delta", &json!({"text":"a"}), now);
        }
        let samples = std::iter::from_fn(|| live.try_recv().ok())
            .filter(|event| event.get("usage").is_some())
            .count();
        assert_eq!(samples, 4);
    }
    #[test]
    fn cancelled_before_first_output_and_foreign_turns_have_no_usage() {
        let speeds = TurnSpeeds::default();
        speeds.observe_at("s", Some("t"), "chat.turn.started", &json!({}), 0);
        speeds.observe_at(
            "s",
            Some("child"),
            "chat.delta",
            &json!({"text":"child"}),
            500,
        );
        speeds.observe_at(
            "s",
            Some("t"),
            "chat.subagent.item",
            &json!({"parts":[{"type":"text","text":"child"}]}),
            600,
        );
        let done = speeds.observe_at(
            "s",
            Some("t"),
            "chat.turn.completed",
            &json!({"status":"cancelled"}),
            1000,
        );
        assert!(done.get("turnUsage").is_none());
    }
    #[test]
    fn exact_usage_is_never_replaced_by_an_estimate() {
        let merged = merge_usage(
            Some(&json!({"inputTokens":5,"outputTokens":50})),
            &json!({"outputTokens":10,"outputTokensEstimated":true,"generationMs":1000,"firstTokenMs":200}),
        );
        assert_eq!(merged["outputTokens"], 50);
        assert_eq!(merged["outputTokensEstimated"], false);
        assert_eq!(merged["inputTokens"], 5);
        assert_eq!(merged["generationMs"], 1000);
    }

    #[test]
    fn late_exact_context_retains_timing_and_clears_estimate_marker() {
        let usage = merge_usage(
            Some(
                &json!({"outputTokens":3,"outputTokensEstimated":true,"generationMs":1000,"firstTokenMs":200}),
            ),
            &json!({"outputTokens":50}),
        );
        assert_eq!(usage["outputTokens"], 50);
        assert_eq!(usage["outputTokensEstimated"], false);
        assert_eq!(usage["generationMs"], 1000);
        assert_eq!(usage["firstTokenMs"], 200);
    }

    #[test]
    fn claude_raw_thinking_and_messages_share_one_call_estimate() {
        let mut tracker = TurnSpeed::new(0);
        tracker.observe(
            "chat.item",
            &json!({"speedCallId":"a","raw":{"message":{"event":{"delta":{"thinking":"中文"}}}}}),
            100,
        );
        tracker.observe(
            "chat.delta",
            &json!({"speedCallId":"a","part":{"type":"text","text":"abcd"}}),
            200,
        );
        assert_eq!(tracker.usage(500).unwrap()["outputTokens"], 3);
        tracker.observe(
            "chat.speed.usage",
            &json!({"callId":"a","outputTokens":40}),
            600,
        );
        tracker.observe(
            "chat.delta",
            &json!({"speedCallId":"b","part":{"type":"text","text":"efgh"}}),
            700,
        );
        assert_eq!(tracker.usage(800).unwrap()["outputTokens"], 41);
        assert_eq!(tracker.usage(800).unwrap()["outputTokensEstimated"], true);
    }

    #[test]
    fn disconnect_finishes_measured_turn_and_releases_its_tracker() {
        let speeds = TurnSpeeds::default();
        let mut live = speeds.subscribe();
        speeds.observe_at("s", Some("t"), "chat.turn.started", &json!({}), 0);
        speeds.observe_at("s", Some("t"), "chat.delta", &json!({"text":"abcd"}), 300);
        let stopped = speeds.observe_at(
            "s",
            None,
            "chat.connection",
            &json!({"phase":"disconnected"}),
            1000,
        );
        assert_eq!(stopped["turnUsage"]["generationMs"], 1000);
        assert_eq!(stopped["speedTurnId"], "t");
        assert!(speeds.active.lock().unwrap().is_empty());
        assert_eq!(
            std::iter::from_fn(|| live.try_recv().ok()).last().unwrap()["active"],
            false
        );
    }
}
