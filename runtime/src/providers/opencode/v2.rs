//! OpenCode 2.2.5 native state. Kept separate from the 1.x assembly and routes.
//! The public Chat entry remains fenced until recovery and interactions pass.
use super::*;
use std::collections::BTreeMap;

const MAX_EVENT_IDS: usize = 2048;
const MAX_BUFFERED_EVENTS: usize = 512;
const MAX_SESSIONS: usize = 128;

fn protocol(message: &str) -> ProviderError {
    ProviderError::new("provider_protocol", message)
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, ProviderError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| protocol("OpenCode v2 event is missing an identity"))
}

#[derive(Default)]
pub(super) struct State {
    seen: HashSet<String>,
    seen_order: VecDeque<String>,
    messages: HashMap<(String, String), Message>,
    /// Insertion order of `messages`, so the oldest settled assembly can be
    /// evicted when a long session outgrows its retained bound.
    message_order: VecDeque<(String, String)>,
    /// Retained native bytes of every cached message, maintained incrementally:
    /// the budget check runs on every delta under the event gate and must never
    /// re-serialize the whole cache.
    message_bytes: usize,
    /// The assistant message each session's live execution is still writing.
    /// It is never evicted even when every part it currently has is complete:
    /// the next delta/final event rebuilds it from scratch and would lose text.
    active_messages: HashMap<String, (String, String)>,
    /// Only task-tool metadata can bind a child; parentID also describes forks.
    children: HashMap<String, String>,
    /// Unproven child claims only: a candidate is dropped as soon as its native
    /// parent link proves ownership, so the map tracks in-flight claims instead
    /// of every subagent the Chat ever ran.
    task_candidates: HashMap<String, (String, String)>,
    task_order: VecDeque<String>,
    parents: HashMap<String, String>,
    executions: HashMap<String, Execution>,
    /// Durable sequence positions are per aggregate, not globally comparable.
    sequences: HashMap<String, u64>,
    recovering: bool,
    buffered: VecDeque<Value>,
    buffered_bytes: usize,
    /// Receipts survive a stale pending snapshot, including receipt-before-ask.
    receipts: HashSet<(String, String)>,
    receipt_order: VecDeque<(String, String)>,
    /// Live cards and the native owner that must receive their reply. The native
    /// form/permission id is the approval id already; the owning session (root or
    /// child) is kept here, never inside the card payload.
    interactions: HashMap<String, Interaction>,
    dispatch: Option<Dispatch>,
    interaction_barrier: bool,
    pending_requests: HashSet<(String, String)>,
    inbox_pending: bool,
    inbox_items: HashSet<String>,
    unowned: VecDeque<Value>,
    unowned_bytes: usize,
    /// The model an authoritative native assistant row proved it used. The
    /// footer shows this, never the next-turn selection.
    actual_model: Option<Value>,
}

#[derive(Clone, Debug)]
struct Interaction {
    session: String,
    kind: String,
    turn: Option<String>,
    /// The canonical payload the card was created from. A later native summary is
    /// computed against it, so no schema is re-read from renderer input.
    payload: Value,
}

struct Dispatch {
    operation: String,
    observed: bool,
    terminal: bool,
}

#[derive(Default)]
struct Execution {
    started_seq: Option<u64>,
    terminal_seq: Option<u64>,
    running: bool,
    snapshot_busy: Option<f64>,
    snapshot_idle: Option<f64>,
}

#[derive(Clone, Default)]
struct Message {
    content: BTreeMap<usize, Value>,
    tools: HashMap<String, usize>,
    ordinals: HashMap<(String, u64), usize>,
    /// Snapshot-seeded messages require a full read, never buffered appends.
    seeded: bool,
    created_at: Option<String>,
    finalized: HashMap<String, Value>,
    /// Retained bytes of this message's content and finalized events.
    bytes: usize,
}

impl Message {
    fn retained_bytes(&self) -> usize {
        self.content
            .values()
            .map(|part| part.to_string().len())
            .sum::<usize>()
            + self
                .finalized
                .values()
                .map(|event| event.to_string().len())
                .sum::<usize>()
    }

    /// A delta may only extend content this cache already knows: a tool the
    /// message never opened, or a text ordinal that was never started, has to
    /// come from the native projection instead of a fabricated local part.
    fn contains_identity(&self, data: &Value, kind: &str) -> bool {
        if kind.starts_with("session.tool.") {
            return data
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| self.tools.contains_key(id));
        }
        let part_type = if kind.starts_with("session.reasoning.") {
            "reasoning"
        } else {
            "text"
        };
        data.get("ordinal")
            .and_then(Value::as_u64)
            .is_some_and(|ordinal| self.ordinals.contains_key(&(part_type.to_owned(), ordinal)))
    }

    /// A message whose parts all reached a native terminal state may leave the
    /// assembly cache: its published items are already durable downstream.
    fn settled(&self) -> bool {
        // A server-loaded row has no live part statuses. It is settled unless
        // `active_messages` proves its execution is still writing it.
        if self.seeded {
            return !self.content.is_empty();
        }
        !self.content.is_empty()
            && self.content.values().all(|part| {
                match part.get("type").and_then(Value::as_str) {
                    Some("text" | "reasoning") => {
                        part.get("status").and_then(Value::as_str) == Some("completed")
                    }
                    Some("tool") => matches!(
                        part.pointer("/state/status").and_then(Value::as_str),
                        Some("completed" | "error")
                    ),
                    _ => false,
                }
            })
    }
}

#[derive(Debug)]
enum Change {
    None,
    Activity,
    Refresh {
        session: String,
        message: String,
    },
    Message {
        session: String,
        id: String,
        parts: Vec<Value>,
        created_at: Option<String>,
    },
    Started {
        session: String,
    },
    Terminal {
        session: String,
        status: &'static str,
        raw: Value,
    },
    /// A native `session.execution.interrupted {reason:"shutdown"}`. 2.2.5
    /// sends the same event for an aborted step and for a real server shutdown,
    /// so the boundary is recorded here and only live evidence may close the
    /// Chat afterwards.
    NativeShutdown {
        session: String,
    },
    Pending {
        session: String,
        id: String,
        kind: String,
        request: Value,
    },
    Receipt {
        session: String,
        id: String,
        kind: String,
        /// The native receipt payload: `answer` for `form.replied`, `reply` for
        /// `permission.replied`. It stays in adapter state and never becomes card
        /// data on its own.
        data: Value,
    },
    /// Reported native accounting. Missing fields stay missing.
    Usage {
        session: String,
        tokens: Value,
        /// Only a `session.step.ended` figure belongs to this turn; the
        /// session-level `session.usage.updated` total does not.
        step: bool,
    },
    Title {
        session: String,
        title: String,
    },
    Retry {
        session: String,
        attempt: u64,
        at: u64,
        message: String,
    },
    Compact {
        session: String,
        phase: &'static str,
        data: Value,
    },
}

/// 2.2.5 names a child session only inside the subagent tool's own output:
/// `<subagent sessionID="ses_..." state="completed">...</subagent>`. The marker is a
/// claim exactly like the older metadata field; ownership still requires the
/// verified native parent link before anything is bound.
fn subagent_marker_child(tool: &Value) -> Option<&str> {
    let from_parts = tool
        .pointer("/state/content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .find_map(marker_child);
    from_parts.or_else(|| {
        tool.pointer("/state/output")
            .and_then(Value::as_str)
            .and_then(marker_child)
    })
}

fn subagent_claim(tool: &Value) -> Option<&str> {
    tool.pointer("/state/metadata/sessionID")
        .and_then(Value::as_str)
        .or_else(|| subagent_marker_child(tool))
}

fn marker_child(text: &str) -> Option<&str> {
    let mut rest = text;
    while let Some(open) = rest.find("<subagent") {
        let tag_start = open + "<subagent".len();
        let close = rest[tag_start..].find('>')? + tag_start;
        let attributes = &rest[tag_start..close];
        if let Some(name) = attributes.find("sessionID") {
            let value = attributes[name + "sessionID".len()..].trim_start();
            let value = value.strip_prefix('=')?.trim_start();
            let value = value.strip_prefix('"')?;
            if let Some(end) = value.find('"') {
                return Some(&value[..end]);
            }
        }
        rest = &rest[close..];
    }
    None
}

impl State {
    fn remember(&mut self, id: &str) -> bool {
        if !self.seen.insert(id.to_owned()) {
            return false;
        }
        self.seen_order.push_back(id.to_owned());
        if self.seen_order.len() > MAX_EVENT_IDS {
            if let Some(id) = self.seen_order.pop_front() {
                self.seen.remove(&id);
            }
        }
        true
    }

    fn buffer(&mut self, raw: Value) -> Result<(), ProviderError> {
        let bytes = raw.to_string().len();
        if self.buffered.len() >= MAX_BUFFERED_EVENTS
            || self.buffered_bytes.saturating_add(bytes) > MAX_ASSEMBLED_PAYLOAD_BYTES
        {
            return Err(protocol("OpenCode v2 recovery event buffer overflowed"));
        }
        self.buffered_bytes += bytes;
        self.buffered.push_back(raw);
        Ok(())
    }

    fn owned(&self, session: &str, root: &str) -> bool {
        session == root || self.children.contains_key(session)
    }

    /// Retire one card exactly once and remember the receipt, so no later pending
    /// snapshot can revive it and no reply can be sent twice.
    fn settle(&mut self, id: &str) -> Option<Interaction> {
        let interaction = self.interactions.remove(id)?;
        self.pending_requests
            .remove(&(interaction.session.clone(), id.to_owned()));
        self.interaction_barrier = !self.pending_requests.is_empty();
        let key = (interaction.session.clone(), id.to_owned());
        if self.receipts.insert(key.clone()) {
            self.receipt_order.push_back(key);
            if self.receipt_order.len() > MAX_EVENT_IDS {
                if let Some(key) = self.receipt_order.pop_front() {
                    self.receipts.remove(&key);
                }
            }
        }
        Some(interaction)
    }

    /// The settled child to prune when the proven-child graph is at its bound.
    /// A child that still owns a pending card is never pruned, not even as a
    /// fallback: its card would lose the native owner that makes an answer
    /// possible and `pending` would refuse the reply as an unproven owner.
    fn prunable_child(&self, parent: &str) -> Option<String> {
        self.children
            .keys()
            .find(|id| {
                id.as_str() != parent
                    && self
                        .executions
                        .get(*id)
                        .is_none_or(|execution| !execution.running)
                    && !self
                        .interactions
                        .values()
                        .any(|interaction| interaction.session == **id)
            })
            .cloned()
    }

    /// A finished native execution retires the cards that named its turn. A
    /// child terminal only ends its own session's cards; the root turn terminal
    /// uses [`Self::retire_turn`], which ends the turn everywhere.
    fn retire_session_turn(
        &mut self,
        session: &str,
        turn: &str,
    ) -> Vec<(String, Interaction)> {
        let retired = self
            .interactions
            .iter()
            .filter(|(_, interaction)| {
                interaction.session == session
                    && interaction.turn.as_deref() == Some(turn)
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        self.retire(retired)
    }

    /// A root turn terminal (including the `native-busy` placeholder) ends the
    /// turn for everybody: every card whose turn it was is retired, the root's
    /// own and a background child's alike. This is exactly what the service does
    /// on `chat.turn.completed`, so the adapter and the service never disagree
    /// about which cards a finished turn expires.
    ///
    /// Retiring these cards sends nothing to OpenCode. A native request that was
    /// still pending when its card expired stays pending; reconnect raises it
    /// again (see validation notes).
    fn retire_turn(&mut self, turn: &str) -> Vec<(String, Interaction)> {
        let retired = self
            .interactions
            .iter()
            .filter(|(_, interaction)| interaction.turn.as_deref() == Some(turn))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        self.retire(retired)
    }

    fn retire(&mut self, retired: Vec<String>) -> Vec<(String, Interaction)> {
        retired
            .into_iter()
            .filter_map(|id| self.settle(&id).map(|interaction| (id, interaction)))
            .collect()
    }

    /// Retained memory is bounded without failing a long session: the oldest
    /// *settled* message is evicted (its items are already published) until the
    /// count and byte bounds hold. Only a live assembly that cannot be evicted
    /// stays an explicit error.
    fn enforce_budget(&mut self, keep: &(String, String)) -> Result<(), ProviderError> {
        while self.messages.len() > MAX_ASSEMBLED_MESSAGES
            || self.message_bytes > MAX_ASSEMBLED_PAYLOAD_BYTES
        {
            let evictable = self.message_order.iter().position(|key| {
                key != keep
                    && !self.active_messages.values().any(|active| active == key)
                    && self.messages.get(key).is_some_and(Message::settled)
            });
            let Some(index) = evictable else { break };
            if let Some(key) = self.message_order.remove(index) {
                if let Some(message) = self.messages.remove(&key) {
                    self.message_bytes = self.message_bytes.saturating_sub(message.bytes);
                }
            }
        }
        self.check_budget()
    }

    fn check_budget(&self) -> Result<(), ProviderError> {
        if self.messages.len() > MAX_ASSEMBLED_MESSAGES
            || self.messages.len() > self.message_order.len()
            || self.message_bytes > MAX_ASSEMBLED_PAYLOAD_BYTES
            || self
                .messages
                .values()
                .any(|message| message.content.len() > MAX_BUFFERED_EVENTS)
        {
            return Err(protocol("OpenCode v2 message assembly exceeded its bound"));
        }
        Ok(())
    }

    fn task_binding(&mut self, session: &str, tool: &Value) -> Result<(), ProviderError> {
        if tool.get("name").and_then(Value::as_str) != Some("subagent") {
            return Ok(());
        }
        // Filled from the native task contract, never a session parent link.
        // Older inline results can carry only the marker. Background calls
        // announce the child in metadata. Either is a claim: `recover_children` proves
        // ownership from the verified native parent link before it binds.
        let child = subagent_claim(tool);
        if let Some(child) = child {
            validate_native_id(child)?;
            if child == session {
                return Err(protocol("OpenCode v2 task owns itself"));
            }
            // An owned child needs no further proof: keeping its claim would
            // make the candidate map grow with every subagent the Chat ran.
            if !self.children.contains_key(child) {
                if !self.task_candidates.contains_key(child)
                    && self.task_candidates.len() >= MAX_SESSIONS
                {
                    // Oldest unproven claim first; a still-live claim is
                    // re-announced by its own tool events, so dropping one is
                    // never a permanent loss of ownership.
                    if let Some(oldest) = self.task_order.pop_front() {
                        self.task_candidates.remove(&oldest);
                    }
                }
                if !self.task_candidates.contains_key(child) {
                    self.task_order.push_back(child.into());
                }
                let call = text(tool, "id")?;
                self.task_candidates
                    .entry(child.into())
                    .or_insert_with(|| (session.into(), call.into()));
            }
            if !self.children.contains_key(child)
                && self.parents.get(child).is_some_and(|parent| parent == session)
            {
                let key = self
                    .children
                    .get(session)
                    .cloned()
                    .unwrap_or_else(|| tool["id"].as_str().unwrap_or_default().into());
                self.children.insert(child.into(), key);
            }
        }
        Ok(())
    }

    fn seed_message(
        &mut self,
        session: &str,
        row: &Value,
    ) -> Result<Option<Change>, ProviderError> {
        let id = text(row, "id")?;
        validate_native_id(id)?;
        match row.get("type").and_then(Value::as_str) {
            Some("assistant") => {}
            Some(
                "agent-switched" | "model-switched" | "location-switched" | "user" | "synthetic"
                | "system" | "skill" | "shell" | "compaction" | "idle",
            ) => return Ok(None),
            _ => return Err(protocol("OpenCode v2 snapshot has an unknown message type")),
        }
        let content = row
            .get("content")
            .and_then(Value::as_array)
            .ok_or_else(|| protocol("OpenCode v2 assistant snapshot has no content"))?;
        if let (Some(provider), Some(model)) = (
            row.pointer("/model/providerID").and_then(Value::as_str),
            row.pointer("/model/id").and_then(Value::as_str),
        ) {
            self.actual_model = Some(json!({"providerID":provider,"modelID":model}));
        }
        let previous = self.messages.get(&(session.into(), id.into())).cloned();
        let mut message = Message {
            seeded: true,
            created_at: opencode_message_created_at(row),
            finalized: self
                .messages
                .get(&(session.into(), id.into()))
                .map(|message| message.finalized.clone())
                .unwrap_or_default(),
            ..Default::default()
        };
        for (index, part) in content.iter().enumerate() {
            let kind = text(part, "type")?;
            match kind {
                "text" | "reasoning" => {
                    if !part.get("text").is_some_and(Value::is_string) {
                        return Err(protocol("OpenCode v2 snapshot text is invalid"));
                    }
                    let ordinal = message
                        .ordinals
                        .keys()
                        .filter(|(part_type, _)| part_type == kind)
                        .count() as u64;
                    message.ordinals.insert((kind.into(), ordinal), index);
                }
                "tool" => {
                    let tool_id = text(part, "id")?;
                    text(part, "name")?;
                    if message.tools.insert(tool_id.into(), index).is_some() {
                        return Err(protocol("OpenCode v2 snapshot repeats a tool identity"));
                    }
                    self.task_binding(session, part)?;
                }
                _ => {
                    return Err(protocol(
                        "OpenCode v2 snapshot contains unknown assistant content",
                    ))
                }
            }
            message.content.insert(index, part.clone());
        }
        // A projected GET may lag event publication. Native content is
        // append-only, so retain already-observed suffix identities in order.
        if let Some(previous) = previous {
            for (old_index, part) in previous.content {
                let identity = previous
                    .ordinals
                    .iter()
                    .find(|(_, index)| **index == old_index)
                    .map(|(key, _)| key.clone());
                let next = message
                    .content
                    .last_key_value()
                    .map_or(0, |(index, _)| index + 1);
                if let Some(identity) = identity {
                    if let std::collections::hash_map::Entry::Vacant(entry) =
                        message.ordinals.entry(identity)
                    {
                        entry.insert(next);
                        message.content.insert(next, part);
                    }
                } else if let Some(tool) = part.get("id").and_then(Value::as_str) {
                    if !message.tools.contains_key(tool) {
                        message.tools.insert(tool.into(), next);
                        message.content.insert(next, part);
                    }
                }
            }
        }
        for event in message.finalized.clone().values() {
            merge_final(&mut message, event)?;
        }
        let parts = canonical_parts(&message)?;
        if message
            .content
            .values()
            .map(|part| part.to_string().len())
            .sum::<usize>()
            > MAX_ASSEMBLED_PAYLOAD_BYTES
        {
            return Err(protocol(
                "OpenCode v2 native message exceeds the payload bound",
            ));
        }
        let created_at = message.created_at.clone();
        let key = (session.to_owned(), id.to_owned());
        message.bytes = message.retained_bytes();
        // An evicted message is re-seeded by its next projection read, never
        // fabricated from a delta; the budget is enforced after the insert.
        if let Some(previous) = self.messages.insert(key.clone(), message) {
            self.message_bytes = self.message_bytes.saturating_sub(previous.bytes);
        } else {
            self.message_order.push_back(key.clone());
        }
        self.message_bytes += self.messages[&key].bytes;
        self.enforce_budget(&key)?;
        Ok(Some(Change::Message {
            session: session.into(),
            id: id.into(),
            parts,
            created_at,
        }))
    }

    fn apply(&mut self, root: &str, raw: &Value) -> Result<Change, ProviderError> {
        let id = text(raw, "id")?;
        let kind = text(raw, "type")?;
        let data = raw
            .get("data")
            .filter(|data| data.is_object())
            .ok_or_else(|| protocol("OpenCode v2 event has no data"))?;
        let Some(session) = data
            .get("sessionID")
            .or_else(|| data.pointer("/form/sessionID"))
            .and_then(Value::as_str)
        else {
            return Ok(Change::None);
        };
        if !self.owned(session, root) {
            // Keep a bounded window for task metadata that arrives after its
            // child's native events. Unproven/fork sessions still never project.
            let bytes = raw.to_string().len();
            // Early events for a child that is not proven yet are a bounded
            // window, not a queue: the oldest claim is dropped and the child's
            // own snapshot read supplies its transcript once ownership is
            // proven. Dropping an old unowned event is never a permanent gap.
            while self.unowned.len() >= MAX_PENDING_CHILD_EVENTS
                || self.unowned_bytes.saturating_add(bytes) > MAX_ASSEMBLED_PAYLOAD_BYTES
            {
                let Some(dropped) = self.unowned.pop_front() else { break };
                self.unowned_bytes = self
                    .unowned_bytes
                    .saturating_sub(dropped.to_string().len());
            }
            self.unowned_bytes += bytes;
            self.unowned.push_back(raw.clone());
            return Ok(Change::None);
        }
        if !self.remember(id) {
            return Ok(Change::None);
        }
        let seq = match raw.get("durable") {
            Some(durable) => {
                if durable.get("aggregateID").and_then(Value::as_str) != Some(session) {
                    return Err(protocol(
                        "OpenCode v2 durable event has a foreign aggregate",
                    ));
                }
                let seq = durable
                    .get("seq")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| protocol("OpenCode v2 durable event has no sequence"))?;
                if self
                    .sequences
                    .get(session)
                    .is_some_and(|prior| seq <= *prior)
                {
                    return Ok(Change::None);
                }
                self.sequences.insert(session.into(), seq);
                Some(seq)
            }
            None => None,
        };
        if kind.starts_with("session.execution.") {
            let seq =
                seq.ok_or_else(|| protocol("OpenCode v2 execution event has no durable position"))?;
            if self.executions.len() >= MAX_SESSIONS && !self.executions.contains_key(session) {
                // Settled per-session bookkeeping is pruned instead of failing
                // the stream: only a live execution must stay resident.
                let settled = self
                    .executions
                    .iter()
                    .find(|(id, execution)| {
                        id.as_str() != session
                            && !execution.running
                            && execution.terminal_seq.is_some()
                    })
                    .map(|(id, _)| id.clone());
                let Some(settled) = settled else {
                    return Err(protocol(
                        "OpenCode v2 execution ownership exceeded its bound",
                    ));
                };
                self.executions.remove(&settled);
            }
            let execution = self.executions.entry(session.into()).or_default();
            let created = raw
                .get("created")
                .and_then(Value::as_f64)
                .filter(|time| time.is_finite())
                .ok_or_else(|| protocol("OpenCode v2 execution event has no native timestamp"))?;
            if kind == "session.execution.started" {
                if execution.snapshot_idle == Some(created)
                    && execution.snapshot_busy.is_none_or(|busy| busy <= created)
                {
                    return Err(ProviderError::new("provider_recovery_required","OpenCode v2 execution shares the recovered idle timestamp; native ordering requires reconciliation"));
                }
                if execution
                    .snapshot_busy
                    .into_iter()
                    .chain(execution.snapshot_idle)
                    .any(|time| created <= time)
                {
                    return Ok(Change::None);
                }
                execution.started_seq = Some(seq);
                execution.running = true;
                return Ok(Change::Started {
                    session: session.into(),
                });
            }
            let status = match kind {
                "session.execution.succeeded" => "completed",
                "session.execution.failed" => "failed",
                "session.execution.interrupted" => "interrupted",
                _ => return Ok(Change::None),
            };
            if execution.snapshot_idle.is_some_and(|idle| created <= idle)
                || execution.snapshot_busy.is_some_and(|busy| created < busy)
            {
                return Ok(Change::None);
            }
            // A terminal with no matching observed/recovered execution cannot
            // settle a newly reserved local turn. Reconnect calibrates first.
            if !execution.running
                || execution.started_seq.is_some_and(|start| seq <= start)
                || execution
                    .terminal_seq
                    .is_some_and(|terminal| seq <= terminal)
            {
                return Ok(Change::None);
            }
            execution.running = false;
            execution.terminal_seq = Some(seq);
            self.active_messages.remove(session);
            if kind == "session.execution.interrupted"
                && data.get("reason").and_then(Value::as_str) == Some("shutdown")
            {
                return Ok(Change::NativeShutdown {
                    session: session.into(),
                });
            }
            return Ok(Change::Terminal {
                session: session.into(),
                status,
                raw: data.clone(),
            });
        }
        if matches!(kind, "permission.asked" | "form.created") {
            let request = data
                .get("request")
                .or_else(|| data.get("form"))
                .unwrap_or(data);
            let request_id = text(request, "id")?;
            if self.receipts.contains(&(session.into(), request_id.into())) {
                return Ok(Change::None);
            }
            self.interaction_barrier = true;
            if self.pending_requests.len() >= MAX_EVENT_IDS
                && !self
                    .pending_requests
                    .contains(&(session.into(), request_id.into()))
            {
                return Err(protocol(
                    "OpenCode v2 pending interactions exceeded their bound",
                ));
            }
            if !self
                .pending_requests
                .insert((session.into(), request_id.into()))
            {
                return Ok(Change::None);
            }
            return Ok(Change::Pending {
                session: session.into(),
                id: request_id.into(),
                kind: kind.into(),
                request: request.clone(),
            });
        }
        if matches!(
            kind,
            "permission.replied" | "form.replied" | "form.cancelled"
        ) {
            let request_id = data
                .get("requestID")
                .or_else(|| data.get("formID"))
                .or_else(|| data.get("id"))
                .and_then(Value::as_str)
                .ok_or_else(|| protocol("OpenCode v2 receipt has no request identity"))?;
            let key = (session.into(), request_id.into());
            self.pending_requests.remove(&key);
            self.interaction_barrier = !self.pending_requests.is_empty();
            if !self.receipts.insert(key.clone()) {
                return Ok(Change::None);
            }
            self.receipt_order.push_back(key);
            if self.receipt_order.len() > MAX_EVENT_IDS {
                if let Some(key) = self.receipt_order.pop_front() {
                    self.receipts.remove(&key);
                }
            }
            return Ok(Change::Receipt {
                session: session.into(),
                id: request_id.into(),
                kind: kind.into(),
                data: data.clone(),
            });
        }
        if session == root
            && matches!(
                kind,
                "session.inbox.enqueued" | "session.inbox.delivered" | "session.inbox.cancelled"
            )
        {
            let inbox = text(data, "inboxID")?;
            if kind == "session.inbox.enqueued" {
                if self.inbox_items.len() >= MAX_EVENT_IDS {
                    return Err(protocol("OpenCode v2 inbox exceeded its bound"));
                }
                self.inbox_items.insert(inbox.into());
            } else {
                self.inbox_items.remove(inbox);
            }
            self.inbox_pending = !self.inbox_items.is_empty();
            return Ok(Change::Activity);
        }
        if let Some(message_id) = data.get("assistantMessageID").and_then(Value::as_str) {
            validate_native_id(message_id)?;
        }
        if kind == "session.step.started" && session == root {
            // `session.step.started` names the model that is actually answering
            // this assistant message; `session.step.ended` carries tokens only.
            // This is native evidence, never the next-turn selection, and a
            // child session's model never becomes the root footer.
            if let (Some(provider), Some(model)) = (
                data.pointer("/model/providerID").and_then(Value::as_str),
                data.pointer("/model/id").and_then(Value::as_str),
            ) {
                self.actual_model = Some(json!({"providerID":provider,"modelID":model}));
            }
        }
        if kind == "session.usage.updated" {
            return Ok(Change::Usage {
                session: session.into(),
                tokens: data.get("tokens").cloned().unwrap_or(Value::Null),
                step: false,
            });
        }
        if kind == "session.step.ended" {
            return Ok(match data.get("tokens").filter(|tokens| tokens.is_object()) {
                Some(tokens) => Change::Usage {
                    session: session.into(),
                    tokens: tokens.clone(),
                    step: true,
                },
                None => Change::Activity,
            });
        }
        if kind == "session.retry.scheduled" {
            let error = data.get("error").unwrap_or(&Value::Null);
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.get("type").and_then(Value::as_str))
                .unwrap_or("native retry scheduled");
            return Ok(Change::Retry {
                session: session.into(),
                attempt: data.get("attempt").and_then(Value::as_u64).unwrap_or(0),
                at: data.get("at").and_then(Value::as_u64).unwrap_or(0),
                message: message.into(),
            });
        }
        if let Some(phase) = kind.strip_prefix("session.compaction.") {
            let phase = match phase {
                "started" => "started",
                "ended" => "ended",
                "failed" => "failed",
                // Deltas are implementation text; they never reach the reply.
                _ => return Ok(Change::Activity),
            };
            return Ok(Change::Compact {
                session: session.into(),
                phase,
                data: data.clone(),
            });
        }
        if matches!(kind, "session.created" | "session.renamed") {
            let title = data
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty());
            return Ok(match title {
                Some(title) => Change::Title {
                    session: session.into(),
                    title: title.into(),
                },
                None => Change::None,
            });
        }
        let Some(message_id) = data.get("assistantMessageID").and_then(Value::as_str) else {
            return Ok(Change::None);
        };
        validate_native_id(message_id)?;
        if !(kind.starts_with("session.text.")
            || kind.starts_with("session.reasoning.")
            || kind.starts_with("session.tool."))
        {
            // Step endings and failures carry usage; they never settle execution.
            return Ok(if kind.starts_with("session.step.") {
                Change::Activity
            } else {
                Change::None
            });
        }
        let key = (session.into(), message_id.into());
        self.active_messages
            .insert(session.to_owned(), key.clone());
        let final_event = kind.ends_with(".ended")
            && (kind.starts_with("session.text.") || kind.starts_with("session.reasoning."))
            || matches!(
                kind,
                "session.tool.input.ended"
                    | "session.tool.called"
                    | "session.tool.progress"
                    | "session.tool.success"
                    | "session.tool.failed"
            );
        if final_event {
            let previous_bytes = self.messages.get(&key).map_or(0, |message| message.bytes);
            if !self.messages.contains_key(&key) {
                self.message_order.push_back(key.clone());
            }
            let message = self.messages.entry(key.clone()).or_default();
            if kind == "session.tool.progress"
                && data
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|id| message.tools.get(id))
                    .and_then(|index| message.content.get(index))
                    .is_some_and(|tool| {
                        matches!(
                            tool["state"]["status"].as_str(),
                            Some("completed" | "error")
                        )
                    })
            {
                return Ok(Change::None);
            }
            let identity = if kind.starts_with("session.tool.") {
                format!("tool:{}", text(data, "id")?)
            } else {
                format!(
                    "{}:{}",
                    if kind.starts_with("session.text.") {
                        "text"
                    } else {
                        "reasoning"
                    },
                    data["ordinal"]
                        .as_u64()
                        .ok_or_else(|| protocol("OpenCode v2 ended content has no ordinal"))?
                )
            };
            if message.finalized.len() >= MAX_BUFFERED_EVENTS
                && !message.finalized.contains_key(&identity)
            {
                return Err(protocol("OpenCode v2 finalized content exceeded its bound"));
            }
            // Each tool retains its authoritative full input and final result
            // together. A later result does not repeat input in the native API.
            let mut full_data = message
                .finalized
                .get(&identity)
                .map(|event| event["data"].clone())
                .unwrap_or_else(|| json!({}));
            for (key, value) in data.as_object().expect("event data validated") {
                full_data[key] = value.clone();
            }
            if kind.starts_with("session.tool.") && full_data.get("input").is_none() {
                // A called event may predate subscription. Retain parsed input
                // known only from the seed before a later GET can regress it.
                if let Some(input) = data
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|id| message.tools.get(id))
                    .and_then(|index| message.content.get(index))
                    .and_then(|tool| tool.pointer("/state/input"))
                    .filter(|input| input.is_object())
                {
                    full_data["input"] = input.clone();
                }
            }
            if matches!(kind, "session.tool.success" | "session.tool.failed")
                && data.get("metadata").is_none()
                && !message
                    .tools
                    .get(text(data, "id")?)
                    .and_then(|index| message.content.get(index))
                    .is_some_and(|tool| tool["name"] == "subagent")
            {
                full_data
                    .as_object_mut()
                    .expect("merged event data object")
                    .remove("metadata");
            }
            let event = json!({"type":kind,"data":full_data});
            message.finalized.insert(identity, event.clone());
            if merge_final(message, &event).is_err() {
                return Ok(Change::Refresh {
                    session: session.into(),
                    message: message_id.into(),
                });
            }
            let finalized_tool = if kind.starts_with("session.tool.") {
                let tool_id = text(data, "id")?;
                message
                    .tools
                    .get(tool_id)
                    .and_then(|index| message.content.get(index))
                    .cloned()
            } else {
                None
            };
            if let Some(tool) = finalized_tool {
                self.task_binding(session, &tool)?;
            }
            let message = self.messages.get_mut(&key).expect("message inserted");
            message.bytes = message.retained_bytes();
            self.message_bytes = self
                .message_bytes
                .saturating_sub(previous_bytes)
                .saturating_add(message.bytes);
            self.enforce_budget(&key)?;
            let message = &self.messages[&key];
            return Ok(Change::Message {
                session: session.into(),
                id: message_id.into(),
                parts: canonical_parts(message)?,
                created_at: message.created_at.clone(),
            });
        }
        if !kind.ends_with(".started")
            && self
                .messages
                .get(&key)
                .is_none_or(|message| message.seeded || !message.contains_identity(data, kind))
        {
            // A delta whose message is no longer cached (evicted, or only
            // known from a snapshot) is re-read instead of fabricating a
            // partial message from the stream.
            return Ok(Change::Refresh {
                session: session.into(),
                message: message_id.into(),
            });
        }
        if kind.starts_with("session.tool.")
            && kind != "session.tool.input.started"
            && self.messages.get(&key).is_none_or(|message| {
                !data
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| message.tools.contains_key(id))
            })
        {
            return Ok(Change::Refresh {
                session: session.into(),
                message: message_id.into(),
            });
        }
        let previous_bytes = self.messages.get(&key).map_or(0, |message| message.bytes);
        if !self.messages.contains_key(&key) {
            self.message_order.push_back(key.clone());
        }
        let message = self.messages.entry(key.clone()).or_default();
        if kind.starts_with("session.text.") || kind.starts_with("session.reasoning.") {
            let ordinal = data
                .get("ordinal")
                .and_then(Value::as_u64)
                .filter(|n| *n < MAX_BUFFERED_EVENTS as u64)
                .ok_or_else(|| protocol("OpenCode v2 text ordinal is invalid"))?;
            let part_type = if kind.starts_with("session.reasoning.") {
                "reasoning"
            } else {
                "text"
            };
            let next = message.content.last_key_value().map_or(0, |(n, _)| n + 1);
            let index = *message
                .ordinals
                .entry((part_type.into(), ordinal))
                .or_insert(next);
            let part = message
                .content
                .entry(index)
                .or_insert_with(|| json!({"type":part_type,"text":""}));
            if part["type"] != part_type {
                return Err(protocol("OpenCode v2 content identity changed type"));
            }
            if kind.ends_with(".ended") {
                part["text"] = data
                    .get("text")
                    .filter(|v| v.is_string())
                    .cloned()
                    .ok_or_else(|| protocol("OpenCode v2 ended text is missing"))?;
                part["status"] = json!("completed");
            } else if kind.ends_with(".delta") && part["status"] != "completed" {
                let delta = data
                    .get("delta")
                    .and_then(Value::as_str)
                    .ok_or_else(|| protocol("OpenCode v2 text delta is missing"))?;
                part["text"] = json!(format!(
                    "{}{delta}",
                    part["text"].as_str().unwrap_or_default()
                ));
                part["status"] = json!("streaming");
            }
        } else {
            let tool_id = text(data, "id")?;
            let index = if let Some(index) = message.tools.get(tool_id) {
                *index
            } else {
                if kind != "session.tool.input.started" {
                    return Err(protocol("OpenCode v2 tool event precedes its identity"));
                }
                let index = message.content.last_key_value().map_or(0, |(n, _)| n + 1);
                message.tools.insert(tool_id.into(), index);
                message.content.insert(index, json!({"type":"tool","id":tool_id,"name":text(data,"name")?,"state":{"status":"streaming","input":""}}));
                index
            };
            let part = message
                .content
                .get_mut(&index)
                .ok_or_else(|| protocol("OpenCode v2 tool identity is missing"))?;
            let terminal = matches!(
                part.pointer("/state/status").and_then(Value::as_str),
                Some("completed" | "error")
            );
            if !terminal {
                match kind {
                    "session.tool.input.delta" => {
                        let delta = data
                            .get("delta")
                            .and_then(Value::as_str)
                            .ok_or_else(|| protocol("OpenCode v2 tool input delta is missing"))?;
                        part["state"]["input"] = json!(format!(
                            "{}{delta}",
                            part["state"]["input"].as_str().unwrap_or_default()
                        ));
                    }
                    "session.tool.input.ended" => {
                        part["state"]["input"] = data
                            .get("text")
                            .filter(|v| v.is_string())
                            .cloned()
                            .ok_or_else(|| protocol("OpenCode v2 tool input is missing"))?
                    }
                    "session.tool.called" => {
                        part["state"] = json!({"status":"running","input":data.get("input").filter(|v|v.is_object()).ok_or_else(||protocol("OpenCode v2 tool input is invalid"))?,"metadata":{}})
                    }
                    "session.tool.progress" => {
                        part["state"]["metadata"] = data
                            .get("metadata")
                            .filter(|v| v.is_object())
                            .cloned()
                            .ok_or_else(|| protocol("OpenCode v2 tool progress is invalid"))?
                    }
                    "session.tool.success" | "session.tool.failed" => {
                        let input = part["state"]["input"].clone();
                        part["state"] = json!({"status":if kind.ends_with(".success") {"completed"} else {"error"},"input":input});
                        for key in ["content", "error", "metadata"] {
                            if let Some(value) = data.get(key) {
                                part["state"][key] = value.clone();
                            }
                        }
                    }
                    _ => {}
                }
            }
            let part = part.clone();
            self.task_binding(session, &part)?;
        }
        let message = self.messages.get_mut(&key).expect("message inserted");
        message.bytes = message.retained_bytes();
        self.message_bytes = self
            .message_bytes
            .saturating_sub(previous_bytes)
            .saturating_add(message.bytes);
        self.enforce_budget(&key)?;
        let message = &self.messages[&key];
        Ok(Change::Message {
            session: session.into(),
            id: message_id.into(),
            parts: canonical_parts(message)?,
            created_at: message.created_at.clone(),
        })
    }
}

/// Durable full-value events outrank a temporarily lagging projected GET.
/// Snapshots supply mixed ordering; stable per-kind ordinals/tool IDs supply
/// authoritative values without appending a delta already included by a read.
fn merge_final(message: &mut Message, event: &Value) -> Result<(), ProviderError> {
    let kind = text(event, "type")?;
    let data = &event["data"];
    let next = message
        .content
        .last_key_value()
        .map_or(0, |(index, _)| index + 1);
    if kind.starts_with("session.text.") || kind.starts_with("session.reasoning.") {
        let ordinal = data["ordinal"]
            .as_u64()
            .filter(|n| *n < MAX_BUFFERED_EVENTS as u64)
            .ok_or_else(|| protocol("OpenCode v2 finalized ordinal is invalid"))?;
        let part_type = if kind.starts_with("session.text.") {
            "text"
        } else {
            "reasoning"
        };
        let index = *message
            .ordinals
            .entry((part_type.into(), ordinal))
            .or_insert(next);
        message.content.insert(index,json!({"type":part_type,"text":data.get("text").filter(|value|value.is_string()).ok_or_else(||protocol("OpenCode v2 finalized text is missing"))?,"status":"completed"}));
    } else {
        let id = text(data, "id")?;
        let index = message.tools.get(id).copied().ok_or_else(|| {
            ProviderError::new(
                "native_snapshot_pending",
                "OpenCode v2 terminal tool is absent from its native snapshot",
            )
        })?;
        let tool = message
            .content
            .get_mut(&index)
            .ok_or_else(|| protocol("OpenCode v2 terminal tool identity is missing"))?;
        if kind == "session.tool.input.ended" {
            if !tool["state"]["input"].is_object() {
                tool["state"]["input"] = data
                    .get("text")
                    .filter(|value| value.is_string())
                    .cloned()
                    .ok_or_else(|| protocol("OpenCode v2 full tool input is missing"))?;
            }
            return Ok(());
        }
        if kind == "session.tool.called" {
            tool["state"]["input"] = data
                .get("input")
                .filter(|value| value.is_object())
                .cloned()
                .ok_or_else(|| protocol("OpenCode v2 called tool input is invalid"))?;
            if !matches!(
                tool["state"]["status"].as_str(),
                Some("completed" | "error")
            ) {
                tool["state"]["status"] = json!("running");
            }
            return Ok(());
        }
        if kind == "session.tool.progress" {
            if let Some(input) = data.get("input").filter(|input| input.is_object()) {
                tool["state"]["input"] = input.clone();
            } else if !tool["state"]["input"].is_object() {
                if let Some(input) = data.get("text").filter(|input| input.is_string()) {
                    tool["state"]["input"] = input.clone();
                }
            }
            tool["state"]["metadata"] = data
                .get("metadata")
                .filter(|metadata| metadata.is_object())
                .cloned()
                .ok_or_else(|| protocol("OpenCode v2 full tool progress is invalid"))?;
            return Ok(());
        }
        let input = data
            .get("input")
            .filter(|input| input.is_object())
            .cloned()
            .or_else(|| {
                tool["state"]["input"]
                    .is_object()
                    .then(|| tool["state"]["input"].clone())
            })
            .ok_or_else(|| {
                ProviderError::new(
                    "native_snapshot_pending",
                    "OpenCode v2 terminal tool arguments have not reached the native snapshot",
                )
            })?;
        tool["state"] = json!({"status":if kind.ends_with(".success") {"completed"} else {"error"},"input":input});
        for field in ["content", "error", "metadata"] {
            if let Some(value) = data.get(field) {
                tool["state"][field] = value.clone();
            }
        }
    }
    Ok(())
}

fn canonical_parts(message: &Message) -> Result<Vec<Value>, ProviderError> {
    let content = message.content.values().cloned().collect::<Vec<_>>();
    canonical_content(&content)
}

/// The single canonical conversion for 2.x assistant content: live snapshots and
/// P4 history both go through it, so a re-opened transcript matches the stream.
fn canonical_content(content: &[Value]) -> Result<Vec<Value>, ProviderError> {
    let parts = content
        .iter()
        .filter(|part| part.get("name").and_then(Value::as_str) != Some("subagent"))
        .map(|part| {
            let mut normalized = match part.get("type").and_then(Value::as_str) {
                Some("text" | "reasoning") => opencode_chat_part(part),
                Some("tool") => {
                    let mut tool = part.clone();
                    tool["tool"] = json!(text(part, "name")?);
                    let mut canonical = opencode_chat_part(&tool);
                    if let Some(content) = part.pointer("/state/content") {
                        canonical["data"]["result"] = json!({"content":content});
                    } else if let Some(error) = part.pointer("/state/error") {
                        canonical["data"]["result"] = json!({"error":error});
                    }
                    canonical
                }
                _ => return Err(protocol("OpenCode v2 content is unsupported")),
            };
            if let Some(status) = part.get("status") {
                normalized["status"] = status.clone();
            }
            Ok(normalized)
        })
        .collect::<Result<Vec<Value>, ProviderError>>()?;
    if parts
        .iter()
        .map(|part| part.to_string().len())
        .sum::<usize>()
        > MAX_ASSEMBLED_PAYLOAD_BYTES
    {
        return Err(protocol(
            "OpenCode v2 canonical message exceeds the payload bound",
        ));
    }
    Ok(parts)
}

/// P4 exact-ID history: the native message rows go through the same canonical
/// conversion as live snapshots. Unknown or unreadable rows are an explicit
/// error, never an empty or partial transcript.
pub(super) fn history_transcript(
    session: &str,
    rows: &[Value],
) -> Result<Vec<Value>, ProviderError> {
    let mut items = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let id = text(row, "id")?;
        validate_native_id(id)?;
        let created = opencode_message_created_at(row).unwrap_or_else(|| Utc::now().to_rfc3339());
        match row.get("type").and_then(Value::as_str) {
            Some("user") => {
                let mut part = json!({
                    "type":"text",
                    "text":row.get("text").and_then(Value::as_str).unwrap_or_default()
                });
                let images = row
                    .get("files")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|file| {
                        file.get("uri")
                            .or_else(|| file.get("url"))
                            .and_then(Value::as_str)
                    })
                    .filter(|uri| uri.starts_with("data:image/"))
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                if !images.is_empty() {
                    part["data"] = json!({"images":images});
                }
                items.push(json!({
                    "id":id,
                    "role":"user",
                    "parts":[part],
                    "createdAt":created,
                    "turnOrigin":"history"
                }));
            }
            Some("assistant") => {
                let content = row
                    .get("content")
                    .and_then(Value::as_array)
                    .ok_or_else(|| protocol("OpenCode v2 history assistant content is missing"))?;
                let parts = canonical_content(content)?;
                let mut item = json!({
                    "id":id,
                    "role":"assistant",
                    "parts":parts,
                    "createdAt":created,
                    "turnOrigin":"history",
                    "forkAnchor":{"nativeId":session,"messageId":id}
                });
                // An idle row is the native terminal transition for the turn;
                // a finish reason is the same evidence inside the row.
                let settled = row.get("finish").is_some()
                    || rows[index + 1..]
                        .iter()
                        .any(|row| row.get("type").and_then(Value::as_str) == Some("idle"));
                if settled {
                    item["turnStatus"] = json!("completed");
                }
                items.push(item);
            }
            Some(
                "idle" | "agent-switched" | "model-switched" | "location-switched" | "synthetic"
                | "system" | "skill" | "shell" | "compaction",
            ) => {}
            _ => return Err(protocol("OpenCode v2 history has an unknown message type")),
        }
    }
    Ok(items)
}

fn api(target: &EventTarget) -> NativeApi {
    NativeApi::new(
        target.snapshot_client.clone(),
        target.base_url.clone(),
        target.directory.clone(),
        target.password.clone(),
        ApiDialect::V2,
    )
}

/// V2 composer dispatch. Next-turn settings are applied and confirmed against a
/// native read *before* any prompt/command/compaction admission, because 2.2.5
/// answers 204 even for an unknown model or agent.
pub(super) fn dispatch_v2(
    target: &EventTarget,
    route: &str,
    body: &Value,
) -> Result<Value, ProviderError> {
    let api = api(target);
    apply_settings(target, &api)?;
    let files = body
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    match route {
        "command" => {
            let name = body
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| not_sent(protocol("OpenCode v2 command has no name")))?;
            let text = body.get("text").and_then(Value::as_str).unwrap_or_default();
            api.run_command(&target.native_id, name, text, &files)?;
            Ok(json!({}))
        }
        // The receipt proves admission of an inbox item, never completion.
        "compact" => api.compact(&target.native_id),
        _ => {
            let text = body
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| not_sent(protocol("OpenCode v2 prompt has no text")))?;
            api.admit_prompt(&target.native_id, text, &files)
        }
    }
}

/// Model then agent, each with its own native write. A partial success is
/// reported as such: what applied stays applied and is never rolled back or
/// replayed, and the caller fails before admitting the prompt.
fn apply_settings(target: &EventTarget, api: &NativeApi) -> Result<(), ProviderError> {
    let (model, agent) = {
        let ui = target
            .ui
            .lock()
            .map_err(|_| protocol("OpenCode options lock poisoned"))?;
        (ui.model_ref(), ui.agent.clone())
    };
    let mut applied: Vec<&str> = Vec::new();
    if let Some(model) = model {
        api.switch_model(&target.native_id, &model).map_err(not_sent)?;
        let stored = api.read_session(&target.native_id).map_err(not_sent)?;
        let stored = stored.get("model").cloned().unwrap_or(Value::Null);
        let wanted_variant = model.get("variant").and_then(Value::as_str);
        let matches = stored.get("providerID").and_then(Value::as_str)
            == model.get("providerID").and_then(Value::as_str)
            && stored.get("id").and_then(Value::as_str) == model.get("id").and_then(Value::as_str)
            && wanted_variant
                .is_none_or(|variant| stored.get("variant").and_then(Value::as_str) == Some(variant));
        if !matches {
            return Err(not_applied(&applied, "model"));
        }
        applied.push("model");
    }
    if !agent.is_empty() {
        api.switch_agent(&target.native_id, &agent).map_err(not_sent)?;
        let stored = api.read_session(&target.native_id).map_err(not_sent)?;
        if stored.get("agent").and_then(Value::as_str) != Some(agent.as_str()) {
            return Err(not_applied(&applied, "agent"));
        }
        applied.push("agent");
    }
    Ok(())
}

fn not_applied(applied: &[&str], failed: &str) -> ProviderError {
    ProviderError::new(
        "chat_option_not_applied",
        format!("OpenCode did not apply the selected {failed}; nothing was sent"),
    )
    .with_details(json!({"applied":applied,"failed":failed,"rolledBack":false,"nativeNotSent":true}))
}

/// A failure that provably happened before the native prompt/command POST.
/// `finish_prompt` must never fence the Chat for one of these: nothing was sent.
fn not_sent(error: ProviderError) -> ProviderError {
    let mut details = error
        .details
        .clone()
        .filter(|details| details.is_object())
        .unwrap_or_else(|| json!({}));
    details["nativeNotSent"] = json!(true);
    ProviderError::new(error.code, error.message).with_details(details)
}

fn publish(target: &EventTarget, state: &mut State, change: Change) {
    let turn = target.active.lock().ok().and_then(|active| active.clone());
    let emit = |kind, data, turn: Option<&str>| {
        emit_scoped(
            &target.events,
            "opencode",
            &target.threadterm_session,
            Some(&target.native_id),
            turn,
            kind,
            data,
            Some(&target.worker_token),
        )
    };
    match change {
        Change::Message {
            session,
            id,
            parts,
            created_at,
        } => {
            if session == target.native_id {
                if let Some(actual) = state.actual_model.clone() {
                    if let Ok(mut ui) = target.ui.lock() {
                        ui.effective_model = Some(actual);
                    }
                }
            }
            if let Some(message) = state.messages.get(&(session.clone(), id.clone())) {
                for tool in message
                    .content
                    .values()
                    .filter(|part| part.get("name").and_then(Value::as_str) == Some("subagent"))
                {
                    let Some(call) = tool.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    // Nested tools contribute to their owning root card. A new
                    // top-level task gets its own native call identity.
                    if session != target.native_id {
                        continue;
                    }
                    let tool_status = tool.pointer("/state/status").and_then(Value::as_str);
                    if tool_status == Some("streaming") {
                        continue;
                    }
                    let claimed = subagent_claim(tool);
                    let requested_child =
                        tool.pointer("/state/input/sessionID").and_then(Value::as_str);
                    let bound = claimed
                        .or(requested_child)
                        .filter(|child| state.parents.get(*child) == Some(&session))
                        .and_then(|child| state.children.get(child).map(|key| (child, key.as_str())))
                        .or_else(|| {
                            state.children.iter().find_map(|(child, key)| {
                                (key == call && state.parents.get(child) == Some(&session))
                                    .then_some((child.as_str(), call))
                            })
                        });
                    // The parent tool acknowledges dispatch. A verified child
                    // owns the card's lifecycle, including on message replay.
                    let mut info = json!({"transcript":"live"});
                    let mut key = call;
                    if let Some((child, owned_key)) = bound {
                        info["native"] = json!({"kind":"opencode-session","id":child});
                        key = owned_key;
                    } else if claimed.is_none()
                        && !state
                            .task_candidates
                            .values()
                            .any(|(parent, key)| parent == &session && key == call)
                    {
                        info["status"] = json!(match tool_status {
                            Some("completed") => "completed",
                            Some("error") => "failed",
                            _ => "running",
                        });
                    }
                    // 2.2.5 passes the agent under `input.agent`; the shared card
                    // contract keeps it as `agentType` next to the description.
                    if let Some(agent) = tool
                        .pointer("/state/input/agent")
                        .or_else(|| tool.pointer("/state/input/subagent_type"))
                        .and_then(Value::as_str)
                    {
                        info["agentType"] = json!(agent);
                    }
                    if let Some(description) = tool
                        .pointer("/state/input/description")
                        .and_then(Value::as_str)
                    {
                        info["description"] = json!(description);
                    }
                    emit(
                        "chat.subagent",
                        json!({"key":key,"info":info}),
                        turn.as_deref(),
                    );
                }
            }
            if session == target.native_id {
                let mut data = json!({"item":{"id":id},"parts":parts,"forkAnchor":{"nativeId":session,"messageId":id},"speedCallId":id});
                if let Some(created) = created_at {
                    data["item"]["createdAt"] = json!(created);
                }
                emit("chat.item", data, turn.as_deref());
            } else if let Some(key) = state.children.get(&session) {
                emit(
                    "chat.subagent.item",
                    json!({"key":key,"item":{"id":format!("{session}:{id}"),"role":"assistant","parts":parts}}),
                    turn.as_deref(),
                );
            }
        }
        Change::Started { session } if session == target.native_id => {
            target.native_turn_observed.store(true, Ordering::SeqCst);
            if turn.is_none() {
                if let Ok(mut active) = target.active.lock() {
                    *active = Some(NATIVE_BUSY_TURN.into());
                }
                emit(
                    "chat.turn.started",
                    json!({"resumedNativeTurn":true}),
                    Some(NATIVE_BUSY_TURN),
                );
            }
        }
        Change::Started { session } => {
            if state.parents.get(&session) == Some(&target.native_id) {
                if let Some(key) = state.children.get(&session) {
                    emit(
                        "chat.subagent",
                        json!({"key":key,"reopen":true,"info":{"status":"running","endedAt":null,
                            "native":{"kind":"opencode-session","id":session}}}),
                        turn.as_deref(),
                    );
                }
            }
        }
        Change::Terminal {
            session,
            status,
            raw,
        } if session == target.native_id => {
            target.native_turn_observed.store(true, Ordering::SeqCst);
            // Native terminal outcome is authoritative, including an interrupt
            // before the HTTP interrupt reply. The late reply cannot reopen it.
            if let Ok(mut abort) = target.abort_pending.lock() {
                *abort = None;
            }
            if status == "failed" {
                let detail = raw.get("error").cloned().unwrap_or(Value::Null);
                emit(
                    "chat.item",
                    json!({"item":{"id":format!("{}:execution-error",turn.as_deref().unwrap_or("native-busy"))},
                    "parts":[{"type":"error","text":"OpenCode execution failed.","data":{"error":detail}}]}),
                    turn.as_deref(),
                );
            }
            // B1: the turn ended, so every card whose turn this was is retired
            // on this side with a receipt and no native write: the root's own
            // cards and a background child's alike. This is the same set the
            // service expires on `chat.turn.completed`.
            if let Some(turn) = turn.as_deref() {
                for (id, interaction) in state.retire_turn(turn) {
                    emit(
                        "chat.approval.resolved",
                        json!({"approvalId":id,"status":"expired","outcome":"native",
                            "message":"The turn ended before this request was answered."}),
                        interaction.turn.as_deref(),
                    );
                }
            }
            target.complete_turn(status, raw);
        }
        Change::Terminal {
            session, status, ..
        } => {
            if state.parents.get(&session) == Some(&target.native_id) {
                if let Some(key) = state.children.get(&session) {
                    emit(
                        "chat.subagent",
                        json!({"key":key,"info":{"status":status,"native":{"kind":"opencode-session","id":session}}}),
                        turn.as_deref(),
                    );
                }
            }
            // A child whose execution ended (succeeded, failed or interrupted)
            // can no longer answer its own native requests: retire its cards
            // here with a receipt and no native write.
            for (id, interaction) in state.retire_session_turn(&session, NATIVE_BUSY_TURN) {
                emit(
                    "chat.approval.resolved",
                    json!({"approvalId":id,"status":"expired","outcome":"native",
                        "message":"The subagent finished before this request was answered."}),
                    interaction.turn.as_deref(),
                );
            }
        }
        Change::Pending {
            session,
            id,
            kind,
            request,
        } => {
            let subagent = state.children.get(&session).map(|key| {
                let label = target
                    .subagents
                    .lock()
                    .ok()
                    .and_then(|state| state.labels.get(key).cloned())
                    .unwrap_or_else(|| "Subagent".into());
                (key.clone(), label)
            });
            // A background subagent's card and an idle root card are answerable
            // even when their execution has no ThreadTerm turn. Give them the
            // native-busy placeholder so the service records a turn and the UI
            // can submit the answer. A child card is never tagged with the root
            // turn: a root Stop must not expire it.
            let card_turn = if session != target.native_id || turn.is_none() {
                Some(NATIVE_BUSY_TURN.to_owned())
            } else {
                turn.clone()
            };
            let mut payload = if kind == "form.created" {
                match crate::chat_questions::canonical_form(&request) {
                    Ok(form) => json!({"interaction":"question","answerable":true,"form":form}),
                    // A schema this policy cannot represent stays a diagnostic. It
                    // never becomes a dismiss-only or partial card.
                    Err(error) => {
                        emit(
                            "provider.event",
                            json!({"note":"OpenCode v2 form schema cannot be represented","sessionID":session,"requestID":id,"requestType":kind,"reason":error.message,"request":request}),
                            turn.as_deref(),
                        );
                        return;
                    }
                }
            } else {
                let title = request
                    .get("action")
                    .and_then(Value::as_str)
                    .unwrap_or("Permission request");
                approval_payload(
                    &id,
                    "opencode",
                    "permission.asked",
                    title,
                    &request,
                    &allow_deny_choices(),
                    card_turn.as_deref(),
                    true,
                )
            };
            if let Some((key, label)) = subagent {
                payload["subagent"] = json!({"key":key,"label":label});
            }
            if state.interactions.len() >= MAX_EVENT_IDS {
                // publish already runs under event_gate; expiring the stream here
                // would deadlock on the same mutex. Admission of pending_requests
                // fails before this bound, so this is a last-resort diagnostic.
                emit(
                    "provider.event",
                    json!({"note":"OpenCode v2 pending interactions exceeded their bound","sessionID":session,"requestID":id,"requestType":kind}),
                    turn.as_deref(),
                );
                return;
            }
            state.interactions.insert(
                id.clone(),
                Interaction {
                    session,
                    kind: kind.clone(),
                    turn: card_turn.clone(),
                    payload: payload.clone(),
                },
            );
            let mut data = json!({
                "approvalId":id,
                "request":request,
                "part":{"type":"approval","approvalId":id,"status":"pending","data":payload}
            });
            if payload["interaction"] == "permission" {
                data["choices"] = json!(allow_deny_choices());
            }
            emit("chat.approval", data, card_turn.as_deref());
        }
        Change::Receipt {
            session,
            id,
            kind,
            data,
        } => {
            // A stale list/detail may still contain this ID. State already kept
            // its receipt before publication; recovery must not recreate it.
            // Check the owner before settling: a mismatched receipt must not
            // remove a live card without resolving it.
            let owner = state
                .interactions
                .get(&id)
                .is_some_and(|one| one.session == session);
            let Some(interaction) = owner.then(|| state.settle(&id)).flatten() else {
                emit(
                    "provider.event",
                    json!({"sessionID":session,"requestID":id,"requestType":kind}),
                    turn.as_deref(),
                );
                return;
            };
            // A receipt for a request that was answered elsewhere still has to
            // settle its card here, exactly once.
            let (status, summary) = match kind.as_str() {
                "form.replied" => (
                    "answered",
                    data.get("answer").cloned().map(|answer| {
                        crate::chat_questions::answer_summary(
                            &interaction.payload,
                            &json!({"action":"submit","values":answer}),
                        )
                    }),
                ),
                "form.cancelled" => ("dismissed", None),
                _ => (
                    match data.get("reply").and_then(Value::as_str) {
                        Some("once" | "always" | "reject") => "resolved",
                        Some("cancelled" | "canceled") => "expired",
                        _ => "outcomeUnknown",
                    },
                    None,
                ),
            };
            let mut receipt = json!({"approvalId":id,"status":status,"outcome":"native"});
            if let Some(summary) = summary {
                receipt["answerSummary"] = summary;
            }
            emit("chat.approval.resolved", receipt, interaction.turn.as_deref());
        }
        // Accounting, title, retry and compaction are root-session facts. A
        // child's figures must never be presented as the root turn's.
        Change::Usage { session, tokens, step } => {
            if session != target.native_id {
                return;
            }
            // The context window is only known for a catalogue model that the
            // native assistant row proved it actually answered with.
            let actual = target.ui.lock().ok().and_then(|ui| {
                // A concrete native step/assistant row outranks the cached UI
                // model; neither is ever the next-turn selection.
                let model = state
                    .actual_model
                    .clone()
                    .or_else(|| ui.effective_model.clone())?;
                let provider = model.get("providerID")?.as_str()?.to_owned();
                let id = model.get("modelID")?.as_str()?.to_owned();
                let limit = ui.model_window(&provider, &id);
                Some((provider, id, limit))
            });
            let mut info = json!({"tokens":tokens});
            if let Some((provider, id, limit)) = &actual {
                info["providerID"] = json!(provider);
                info["modelID"] = json!(id);
                if let Some(limit) = limit {
                    info["model"] = json!({"limit":{"context":limit}});
                }
            }
            let Some(usage) = opencode_context_usage(&info, &HashMap::new()) else {
                // Missing stays missing; never invent zero usage.
                return;
            };
            let mut data = json!({"usage":usage});
            if step && turn.is_some() {
                data["turnUsage"] = usage;
                if let Some((provider, id, _)) = &actual {
                    data["model"] = json!(format!("{provider}/{id}"));
                }
            }
            emit("chat.context", data, turn.as_deref());
        }
        Change::Title { session, title } => {
            if session != target.native_id {
                return;
            }
            emit("chat.title", json!({"title":title}), None);
        }
        Change::Retry {
            session,
            attempt,
            at,
            message,
        } => {
            if session != target.native_id {
                return;
            }
            target.retry_status(
                Some(&json!({"type":"retry","attempt":attempt,"message":message,"next":at})),
                turn.as_deref(),
            );
        }
        Change::Compact {
            session,
            phase,
            data,
        } => {
            if session != target.native_id {
                return;
            }
            let operation = turn.clone();
            target.compact_event(phase, operation.as_deref(), data);
        }
        _ => {}
    }
}

fn current(target: &EventTarget) -> bool {
    !target.stopped.load(Ordering::SeqCst) && target.liveness.load(Ordering::SeqCst)
}

/// Native reads must finish outside event_gate. Only the final, still-current
/// snapshot can replace content; stream expiry/Stop wins over delayed responses.
fn refresh_message(
    target: &EventTarget,
    session: &str,
    message: &str,
) -> Result<(), ProviderError> {
    validate_native_id(session)?;
    validate_native_id(message)?;
    for attempt in 0..5 {
        if !current(target) {
            return Ok(());
        }
        let row = match api(target).json_request(
            reqwest::Method::GET,
            &format!("/api/session/{session}/message/{message}"),
            None,
            api::ResponseShape::Data,
        ) {
            Ok(row) => row,
            Err(error)
                if error
                    .details
                    .as_ref()
                    .and_then(|data| data["httpStatus"].as_u64())
                    == Some(404)
                    && attempt < 4 =>
            {
                thread::sleep(Duration::from_millis(25 * (attempt + 1)));
                continue;
            }
            Err(error) => return Err(error),
        };
        if row.get("id").and_then(Value::as_str) != Some(message) {
            return Err(protocol("OpenCode v2 returned a different native message"));
        }
        // The native assistant row is the only evidence of the model that
        // actually answered; the selection is a request, never a claim.
        if row.get("type").and_then(Value::as_str) == Some("assistant") {
            if let (Some(provider), Some(id)) = (
                row.pointer("/model/providerID").and_then(Value::as_str),
                row.pointer("/model/id").and_then(Value::as_str),
            ) {
                if let Ok(mut ui) = target.ui.lock() {
                    ui.effective_model = Some(json!({"providerID":provider,"modelID":id}));
                }
            }
        }
        let _commit = target
            .event_gate
            .lock()
            .map_err(|_| protocol("OpenCode event gate poisoned"))?;
        if !current(target) {
            return Ok(());
        }
        let mut state = target
            .v2
            .lock()
            .map_err(|_| protocol("OpenCode v2 state lock poisoned"))?;
        if !state.owned(session, &target.native_id) {
            return Ok(());
        }
        match state.seed_message(session, &row) {
            Ok(Some(change)) => publish(target, &mut state, change),
            Ok(None) => {}
            Err(error) if error.code == "native_snapshot_pending" && attempt < 4 => {
                drop(state);
                drop(_commit);
                thread::sleep(Duration::from_millis(25 * (attempt + 1)));
                continue;
            }
            Err(error) => return Err(error),
        }
        drop(state);
        drop(_commit);
        recover_children(target)?;
        return Ok(());
    }
    Err(protocol(
        "OpenCode v2 message projection did not catch up within the read bound",
    ))
}

pub(super) fn emit_event(target: &EventTarget, raw: Value) {
    process_event(target, raw, true);
}

enum Queued {
    Event(Value, usize),
    Eof,
}

/// Transport draining never waits for native projection reads. Both count and
/// serialized bytes are bounded; overflow is an explicit integrity failure.
pub(super) struct EventQueue {
    sender: mpsc::SyncSender<Queued>,
    bytes: Arc<Mutex<usize>>,
    target: Arc<EventTarget>,
    count: Arc<std::sync::atomic::AtomicUsize>,
}

impl EventQueue {
    pub(super) fn start(target: Arc<EventTarget>) -> Result<Self, ProviderError> {
        // Reserve one control slot so EOF follows a full, valid data queue.
        let (sender, receiver) = mpsc::sync_channel(MAX_BUFFERED_EVENTS + 1);
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let worker_count = Arc::clone(&count);
        let bytes = Arc::new(Mutex::new(0usize));
        let worker_bytes = Arc::clone(&bytes);
        let worker_target = Arc::clone(&target);
        thread::Builder::new().name(format!("opencode-v2-reconcile-{}",target.threadterm_session)).spawn(move|| {
            while current(&worker_target) {
                match receiver.recv_timeout(Duration::from_millis(100)) {
                    Ok(Queued::Event(raw,size))=> {
                        worker_count.fetch_sub(1,Ordering::SeqCst);
                        if let Ok(mut queued)=worker_bytes.lock() {*queued=queued.saturating_sub(size);}
                        emit_event(&worker_target,raw);
                    }
                    Ok(Queued::Eof)|Err(mpsc::RecvTimeoutError::Disconnected)=> {
                        expire_stream(&worker_target,"event_stream_disconnected","OpenCode v2 event stream disconnected; native outcome requires reconciliation");
                        break;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout)=>{}
                }
            }
        }).map_err(|_|protocol("OpenCode v2 reconciliation worker could not start"))?;
        Ok(Self {
            sender,
            bytes,
            target,
            count,
        })
    }

    pub(super) fn push(&self, raw: Value) {
        if !current(&self.target) {
            return;
        }
        let size = raw.to_string().len();
        let admitted = self
            .bytes
            .lock()
            .map(|mut queued| {
                if queued.saturating_add(size) > MAX_ASSEMBLED_PAYLOAD_BYTES
                    || self.count.load(Ordering::SeqCst) >= MAX_BUFFERED_EVENTS
                {
                    false
                } else {
                    *queued += size;
                    self.count.fetch_add(1, Ordering::SeqCst);
                    true
                }
            })
            .unwrap_or(false);
        if !admitted {
            expire_stream(
                &self.target,
                "v2_event_queue_overflow",
                "OpenCode v2 event queue exceeded its byte bound",
            );
            return;
        }
        if self.sender.try_send(Queued::Event(raw, size)).is_err() {
            self.count.fetch_sub(1, Ordering::SeqCst);
            if let Ok(mut queued) = self.bytes.lock() {
                *queued = queued.saturating_sub(size);
            }
            expire_stream(
                &self.target,
                "v2_event_queue_overflow",
                "OpenCode v2 event queue overflowed; reconnect is required",
            );
        }
    }

    pub(super) fn eof(&self) {
        // Process complete frames ahead of EOF in FIFO order. A full queue
        // cannot hide EOF; fail once rather than blocking transport shutdown.
        if self.sender.try_send(Queued::Eof).is_err() {
            expire_stream(
                &self.target,
                "v2_event_queue_overflow",
                "OpenCode v2 stream ended with an overflowing event queue",
            );
        }
    }
}

fn process_event(target: &EventTarget, raw: Value, buffer_during_recovery: bool) {
    if !current(target) {
        return;
    }
    let result = (|| {
        let commit = target
            .event_gate
            .lock()
            .map_err(|_| protocol("OpenCode event gate poisoned"))?;
        if !current(target) {
            return Ok(());
        }
        let mut state = target
            .v2
            .lock()
            .map_err(|_| protocol("OpenCode v2 state lock poisoned"))?;
        if state.recovering && buffer_during_recovery {
            return state.buffer(raw);
        }
        let change = state.apply(&target.native_id, &raw)?;
        if raw
            .pointer("/data/sessionID")
            .or_else(|| raw.pointer("/data/form/sessionID"))
            .and_then(Value::as_str)
            == Some(&target.native_id)
            && !matches!(change, Change::None)
        {
            if let Some(dispatch) = state.dispatch.as_mut() {
                dispatch.observed = true;
                if matches!(
                    change,
                    Change::Terminal { .. } | Change::NativeShutdown { .. }
                ) {
                    dispatch.terminal = true;
                }
            }
        }
        let shutdown = match &change {
            Change::NativeShutdown { session } => Some(session.clone()),
            _ => None,
        };
        let refresh = match &change {
            Change::Refresh { session, message } => Some((session.clone(), message.clone())),
            _ => None,
        };
        if refresh.is_none() && shutdown.is_none() {
            publish(target, &mut state, change);
        }
        drop(state);
        drop(commit);
        if let Some(session) = shutdown {
            settle_native_shutdown(target, session)?;
        } else if let Some((session, message)) = refresh {
            refresh_message(target, &session, &message)?;
        } else {
            recover_children(target)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        expire_stream(target, "v2_reconciliation_failed", &error.message);
    }
}

/// Evidence, not wording: an aborted step and a dying server both announce a
/// native `shutdown`. Only a still-live stream plus an owned server that still
/// answers `/api/info` proves the adapter must settle the turn and keep the
/// Chat connected; anything else is real loss and fences the stream.
fn settle_native_shutdown(target: &EventTarget, session: String) -> Result<(), ProviderError> {
    if current(target) && api(target).server_alive() {
        let _commit = target
            .event_gate
            .lock()
            .map_err(|_| protocol("OpenCode event gate poisoned"))?;
        if current(target) {
            let mut state = target
                .v2
                .lock()
                .map_err(|_| protocol("OpenCode v2 state lock poisoned"))?;
            publish(
                target,
                &mut state,
                Change::Terminal {
                    session,
                    status: "interrupted",
                    raw: json!({"reason":"shutdown","serverAlive":true}),
                },
            );
        }
        return Ok(());
    }
    expire_stream(
        target,
        "provider_disconnected",
        "OpenCode v2 native server stopped; reconnect is required",
    );
    Ok(())
}

pub(super) fn validate_send(target: &EventTarget) -> Result<(), ProviderError> {
    let state = target
        .v2
        .lock()
        .map_err(|_| protocol("OpenCode v2 state lock poisoned"))?;
    if state.recovering || state.interaction_barrier || state.inbox_pending {
        return Err(ProviderError::new(
            "provider_recovery_required",
            "OpenCode v2 interaction state requires reconciliation before sending",
        ));
    }
    Ok(())
}

/// Called only under event_gate, after local turn admission and before HTTP.
pub(super) fn reserve_prompt(target: &EventTarget, operation: &str) -> Result<(), ProviderError> {
    validate_send(target)?;
    let mut state = target
        .v2
        .lock()
        .map_err(|_| protocol("OpenCode v2 state lock poisoned"))?;
    state.dispatch = Some(Dispatch {
        operation: operation.into(),
        observed: false,
        terminal: false,
    });
    Ok(())
}

pub(super) fn finish_prompt(
    target: &EventTarget,
    operation: &str,
    result: Result<(), ProviderError>,
) -> Result<(), ProviderError> {
    let commit = target
        .event_gate
        .lock()
        .map_err(|_| protocol("OpenCode event gate poisoned"))?;
    let state = target
        .v2
        .lock()
        .map_err(|_| protocol("OpenCode v2 state lock poisoned"))?;
    let dispatch = state
        .dispatch
        .as_ref()
        .filter(|dispatch| dispatch.operation == operation);
    // A delayed old response cannot consult a newer operation's activity flag.
    let Some(dispatch) = dispatch else {
        return result;
    };
    if let Err(error) = result {
        let status = error
            .details
            .as_ref()
            .and_then(|details| details["httpStatus"].as_u64());
        // A definite failure happened before anything was written natively
        // (a settings write, the location read, or an option the server did
        // not store). Nothing can have been sent, so the Chat stays open and
        // the error is shown instead of fencing the stream.
        let not_sent = error
            .details
            .as_ref()
            .and_then(|details| details["nativeNotSent"].as_bool())
            .unwrap_or(false);
        let uncertain = !not_sent
            && (dispatch.observed
                || error.code == "provider_disconnected"
                || status.is_none_or(|status| status >= 500));
        let terminal = dispatch.terminal;
        // A late title, usage or step event sets `observed` without proving a
        // native execution: only a running execution may keep a placeholder.
        let native_running = state
            .executions
            .get(&target.native_id)
            .is_some_and(|execution| execution.running);
        drop(state);
        if uncertain && !terminal {
            expire_stream_locked(target, "send_result_unknown", &error.message, &commit);
        } else if !terminal
            && target
                .active
                .lock()
                .ok()
                .is_some_and(|active| active.as_deref() == Some(operation))
        {
            if native_running {
                // The prompt was not written, but a native execution started
                // anyway. Keep a placeholder so its terminal event cannot
                // settle the next local turn; do not drop the evidence before
                // the execution's own terminal arrives.
                if let Ok(mut active) = target.active.lock() {
                    *active = Some(NATIVE_BUSY_TURN.into());
                }
                emit_scoped(
                    &target.events,
                    "opencode",
                    &target.threadterm_session,
                    Some(&target.native_id),
                    Some(NATIVE_BUSY_TURN),
                    "chat.turn.started",
                    json!({"resumedNativeTurn":true}),
                    Some(&target.worker_token),
                );
            } else if let Ok(mut active) = target.active.lock() {
                *active = None;
            }
            emit_scoped(
                &target.events,
                "opencode",
                &target.threadterm_session,
                Some(&target.native_id),
                Some(operation),
                "chat.error",
                json!({"reason":"prompt_rejected","message":error.message}),
                Some(&target.worker_token),
            );
        }
        return Err(error);
    }
    if !current(target) {
        return Err(ProviderError::new(
            "provider_disconnected",
            "OpenCode v2 prompt acknowledgement arrived after stream expiry",
        ));
    }
    Ok(())
}

/// Called after the SSE headers are validated, before any recovery reads. The
/// reader drains immediately into a bounded queue; TCP buffering is not a queue.
pub(super) fn attach(
    server: &OpenCodeServer,
    native_id: &str,
    session: &Value,
    response: Response,
) -> Result<Arc<EventTarget>, ProviderError> {
    // The caller already read/created and validated this exact session before
    // subscribing. No metadata I/O may delay draining the subscribed stream.
    api::session_identity(session, Some(native_id))?;
    let directory = session
        .pointer("/location/directory")
        .and_then(Value::as_str)
        .ok_or_else(|| protocol("OpenCode v2 session has no stored location"))?;
    let target = Arc::new(EventTarget {
        dialect: ApiDialect::V2,
        threadterm_session: server.threadterm_session.clone(),
        native_id: native_id.into(),
        worker_token: server.worker_token.clone(),
        events: server.events.clone(),
        active: Arc::clone(&server.active_turn),
        assembly: Default::default(),
        permissions: Arc::clone(&server.permissions),
        settled_permissions: Default::default(),
        subagents: Default::default(),
        permission_sessions: Default::default(),
        native_turn_observed: AtomicBool::new(false),
        stopped: Arc::clone(&server.stopped),
        event_gate: Arc::clone(&server.event_gate),
        liveness: Arc::new(AtomicBool::new(true)),
        snapshot_client: server.client.clone(),
        base_url: server.base_url.clone(),
        directory: directory.into(),
        username: server.username.clone(),
        password: server.password.clone(),
        model_limits: Default::default(),
        ui: Default::default(),
        abort_pending: Default::default(),
        retry_visible: AtomicBool::new(false),
        compact_pending: Default::default(),
        ui_options_refreshing: Default::default(),
        v2: Mutex::new(State {
            recovering: true,
            ..Default::default()
        }),
    });
    spawn_sse(SseContext {
        reader: BufReader::new(response),
        target: Arc::clone(&target),
        stopped: Arc::clone(&target.stopped),
        liveness: Arc::clone(&target.liveness),
    })?;
    if let Err(error) = recover(&target) {
        expire_stream(&target, "v2_recovery_failed", &error.message);
        return Err(error);
    }
    Ok(target)
}

struct Recovery {
    session: Value,
    messages: Vec<Value>,
    active: Value,
    inbox: Value,
    permissions: Value,
    forms: Value,
}

/// Task metadata identifies a candidate, and an exact native session read
/// proves its parent and absence of fork metadata. Never use parentID alone.
fn recover_children(target: &EventTarget) -> Result<(), ProviderError> {
    let mut checked = HashSet::new();
    loop {
        let candidate = {
            let _commit = target
                .event_gate
                .lock()
                .map_err(|_| protocol("OpenCode event gate poisoned"))?;
            if !current(target) {
                return Ok(());
            }
            let state = target
                .v2
                .lock()
                .map_err(|_| protocol("OpenCode v2 state lock poisoned"))?;
            state
                .task_candidates
                .iter()
                .find(|(child, (parent, _))| {
                    !state.children.contains_key(*child)
                        && !checked.contains(*child)
                        && state.owned(parent, &target.native_id)
                })
                .map(|(child, (parent, call))| (child.clone(), parent.clone(), call.clone()))
        };
        let Some((child, parent, call)) = candidate else {
            break;
        };
        checked.insert(child.clone());
        if checked.len() > MAX_SESSIONS {
            return Err(protocol("OpenCode v2 task graph exceeded its bound"));
        }
        let native = api(target);
        let info = native.open_session(Some(&child))?;
        if child == target.native_id
            || info.get("parentID").and_then(Value::as_str) != Some(&parent)
            || info.get("fork").is_some_and(|fork| !fork.is_null())
        {
            return Err(protocol(
                "OpenCode v2 task metadata does not prove child ownership",
            ));
        }
        let page = native.json_request(
            reqwest::Method::GET,
            &format!("/api/session/{child}/message?limit={MAX_ASSEMBLED_MESSAGES}&order=desc"),
            None,
            api::ResponseShape::Direct,
        )?;
        if !page.get("cursor").is_some_and(Value::is_object) {
            return Err(protocol("OpenCode v2 child page has no cursor envelope"));
        }
        let partial = page
            .pointer("/cursor/next")
            .and_then(Value::as_str)
            .is_some();
        let rows = list(&page["data"])?;
        if rows.len() > MAX_ASSEMBLED_MESSAGES {
            return Err(protocol("OpenCode v2 child page exceeded its bound"));
        }
        let forms = native.json_request(
            reqwest::Method::GET,
            &format!("/api/session/{child}/form"),
            None,
            api::ResponseShape::Data,
        )?;
        list(&forms)?;
        let permissions = native.json_request(
            reqwest::Method::GET,
            &format!("/api/session/{child}/permission"),
            None,
            api::ResponseShape::Data,
        )?;
        list(&permissions)?;
        let _commit = target
            .event_gate
            .lock()
            .map_err(|_| protocol("OpenCode event gate poisoned"))?;
        if !current(target) {
            return Ok(());
        }
        let mut state = target
            .v2
            .lock()
            .map_err(|_| protocol("OpenCode v2 state lock poisoned"))?;
        // Recheck the candidate after I/O, including its owning parent's fence.
        if state.children.contains_key(&child)
            || !state.owned(&parent, &target.native_id)
            || state.task_candidates.get(&child) != Some(&(parent.clone(), call.clone()))
        {
            continue;
        }
        let key = state
            .children
            .get(&parent)
            .cloned()
            .unwrap_or_else(|| call.clone());
        // Every proven child keeps an execution record for the Chat's life, so
        // a long subagent history must prune settled children instead of
        // growing without a bound. A live child is never dropped.
        if state.children.len() >= MAX_SESSIONS {
            // Only a settled child that owns no pending card is pruned: a
            // waiting child's card keeps its proven native owner instead of
            // being pruned from under an answer that is still possible. When
            // every settled child owns a card the new child is admitted past
            // the bound, so the excess is bounded by the pending-interaction
            // bound instead of failing the stream.
            if let Some(settled) = state.prunable_child(&parent) {
                state.children.remove(&settled);
                state.parents.remove(&settled);
                state.executions.remove(&settled);
                state.sequences.remove(&settled);
                state.active_messages.remove(&settled);
                state.task_candidates.remove(&settled);
                state.task_order.retain(|candidate| candidate != &settled);
            }
        }
        let direct = parent == target.native_id;
        state.parents.insert(child.clone(), parent);
        state.children.insert(child.clone(), key.clone());
        // Proven ownership needs no further claim; keeping it would grow the
        // candidate map with every subagent this Chat ever ran.
        state.task_candidates.remove(&child);
        state.task_order.retain(|candidate| candidate != &child);
        let execution = state.executions.entry(child.clone()).or_default();
        execution.snapshot_busy = info.pointer("/time/busy").and_then(Value::as_f64);
        execution.snapshot_idle = info.pointer("/time/idle").and_then(Value::as_f64);
        execution.running = execution
            .snapshot_busy
            .is_some_and(|busy| execution.snapshot_idle.is_none_or(|idle| busy > idle));
        let child_running = execution.running;
        let status = if child_running {
            "running"
        } else {
            match info.get("outcome").and_then(Value::as_str) {
                Some("succeeded") => "completed",
                Some("failed") => "failed",
                Some("interrupted") => "interrupted",
                _ => "unknown",
            }
        };
        if direct {
            let mut card = json!({"key":key,"info":{"transcript":"live","native":{"kind":"opencode-session","id":child}}});
            if status != "unknown" {
                card["info"]["status"] = json!(status);
            }
            if child_running {
                card["reopen"] = json!(true);
                card["info"]["endedAt"] = Value::Null;
            }
            emit_scoped(
                &target.events,
                "opencode",
                &target.threadterm_session,
                Some(&target.native_id),
                target
                    .active
                    .lock()
                    .ok()
                    .as_deref()
                    .and_then(|turn| turn.as_deref()),
                "chat.subagent",
                card,
                Some(&target.worker_token),
            );
        }
        for row in rows.iter().rev() {
            if let Some(change) = state.seed_message(&child, row)? {
                publish(target, &mut state, change);
            }
            if row.get("type").and_then(Value::as_str) == Some("user") {
                if let Some(text) = row.get("text").and_then(Value::as_str) {
                    emit_scoped(
                        &target.events,
                        "opencode",
                        &target.threadterm_session,
                        Some(&target.native_id),
                        target
                            .active
                            .lock()
                            .ok()
                            .as_deref()
                            .and_then(|turn| turn.as_deref()),
                        "chat.subagent.item",
                        json!({"key":key,"item":{"id":format!("{child}:{}",row["id"].as_str().unwrap_or_default()),"role":"user","parts":[{"type":"text","text":text}]}}),
                        Some(&target.worker_token),
                    );
                }
            }
        }
        if child_running {
            if let Some(id) = rows
                .iter()
                .rev()
                .find(|row| row.get("type").and_then(Value::as_str) == Some("assistant"))
                .and_then(|row| row.get("id").and_then(Value::as_str))
            {
                state
                    .active_messages
                    .insert(child.clone(), (child.clone(), id.to_owned()));
            }
        }
        if partial {
            emit_scoped(
                &target.events,
                "opencode",
                &target.threadterm_session,
                Some(&target.native_id),
                target
                    .active
                    .lock()
                    .ok()
                    .as_deref()
                    .and_then(|turn| turn.as_deref()),
                "chat.subagent.item",
                json!({"key":key,"item":{"id":format!("{child}:recovery-gap"),"role":"system","parts":[{"type":"status","text":"Only the most recent native child messages were recovered; older child history is not loaded.","data":{"reason":"native_history_partial"}}]}}),
                Some(&target.worker_token),
            );
        }
        let mut early = Vec::new();
        state.unowned.retain(|raw| {
            let owned = raw
                .pointer("/data/sessionID")
                .or_else(|| raw.pointer("/data/form/sessionID"))
                .and_then(Value::as_str)
                == Some(child.as_str());
            if owned {
                early.push(raw.clone());
            }
            !owned
        });
        state.unowned_bytes = state.unowned.iter().map(|raw| raw.to_string().len()).sum();
        // A buffered child receipt must beat a briefly stale pending list.
        let receipts = early
            .iter()
            .chain(state.buffered.iter())
            .filter(|raw| {
                raw.pointer("/data/sessionID").and_then(Value::as_str) == Some(child.as_str())
                    && raw["type"].as_str().is_some_and(|kind| {
                        matches!(
                            kind,
                            "form.replied" | "form.cancelled" | "permission.replied"
                        )
                    })
            })
            .cloned()
            .collect::<Vec<_>>();
        for raw in receipts {
            let change = state.apply(&target.native_id, &raw)?;
            publish(target, &mut state, change);
        }
        for (kind, requests) in [("form.created", &forms), ("permission.asked", &permissions)] {
            for request in list(requests)? {
                if request.get("sessionID").and_then(Value::as_str) != Some(&child) {
                    return Err(protocol("OpenCode v2 child form has wrong owner"));
                }
                let id = text(request, "id")?;
                if !state.receipts.contains(&(child.clone(), id.into())) {
                    if state.pending_requests.len() >= MAX_EVENT_IDS
                        && !state.pending_requests.contains(&(child.clone(), id.into()))
                    {
                        return Err(protocol(
                            "OpenCode v2 child interactions exceeded their bound",
                        ));
                    }
                    state.interaction_barrier = true;
                    state.pending_requests.insert((child.clone(), id.into()));
                    publish(
                        target,
                        &mut state,
                        Change::Pending {
                            session: child.clone(),
                            id: id.into(),
                            kind: kind.into(),
                            request: request.clone(),
                        },
                    );
                }
            }
        }
        drop(state);
        drop(_commit);
        for raw in early {
            process_event(target, raw, false);
        }
    }
    Ok(())
}

fn list(value: &Value) -> Result<&Vec<Value>, ProviderError> {
    value
        .as_array()
        .ok_or_else(|| protocol("OpenCode v2 recovery response is not a list"))
}

fn read_recovery(target: &EventTarget) -> Result<Recovery, ProviderError> {
    let native = api(target);
    let session = native.open_session(Some(&target.native_id))?;
    if session
        .pointer("/location/directory")
        .and_then(Value::as_str)
        != Some(target.directory.as_str())
    {
        return Err(protocol("OpenCode v2 location changed during recovery"));
    }
    let messages = native.json_request(
        reqwest::Method::GET,
        &format!(
            "/api/session/{}/message?limit={MAX_ASSEMBLED_MESSAGES}&order=desc",
            target.native_id
        ),
        None,
        api::ResponseShape::Direct,
    )?;
    if !messages.get("cursor").is_some_and(Value::is_object) {
        return Err(protocol("OpenCode v2 message page has no cursor envelope"));
    }
    let mut messages = list(&messages["data"])?.clone();
    if messages.len() > MAX_ASSEMBLED_MESSAGES {
        return Err(protocol("OpenCode v2 message page exceeded its bound"));
    }
    messages.reverse();
    let active = native.json_request(
        reqwest::Method::GET,
        "/api/session/active",
        None,
        api::ResponseShape::Data,
    )?;
    let inbox = native.json_request(
        reqwest::Method::GET,
        &format!("/api/session/{}/inbox", target.native_id),
        None,
        api::ResponseShape::Data,
    )?;
    let forms = native.json_request(
        reqwest::Method::GET,
        &format!("/api/session/{}/form", target.native_id),
        None,
        api::ResponseShape::Data,
    )?;
    // Session-scoped lists retain original owners and cannot leak another
    // project's global requests. Catalogues/prompt use the stored directory.
    let permissions = native.json_request(
        reqwest::Method::GET,
        &format!("/api/session/{}/permission", target.native_id),
        None,
        api::ResponseShape::Data,
    )?;
    list(&inbox)?;
    list(&forms)?;
    list(&permissions)?;
    if list(&inbox)?.len() > MAX_EVENT_IDS
        || list(&forms)?
            .len()
            .saturating_add(list(&permissions)?.len())
            > MAX_EVENT_IDS
    {
        return Err(protocol(
            "OpenCode v2 recovery interaction lists exceeded their bound",
        ));
    }
    for entry in list(&inbox)?
        .iter()
        .chain(list(&forms)?)
        .chain(list(&permissions)?)
    {
        text(entry, "id")?;
        if entry.get("sessionID").and_then(Value::as_str) != Some(target.native_id.as_str()) {
            return Err(protocol("OpenCode v2 recovery request has a foreign owner"));
        }
    }
    if !active.is_object() {
        return Err(protocol("OpenCode v2 activity is not a map"));
    }
    Ok(Recovery {
        session,
        messages,
        active,
        inbox,
        permissions,
        forms,
    })
}

fn busy(snapshot: &Recovery, native_id: &str) -> Result<bool, ProviderError> {
    if snapshot.session.get("id").and_then(Value::as_str) != Some(native_id) {
        return Err(protocol("OpenCode v2 recovery changed session identity"));
    }
    let time = snapshot
        .session
        .get("time")
        .filter(|time| time.is_object())
        .ok_or_else(|| protocol("OpenCode v2 recovery has no execution clock"))?;
    let read_time = |key| -> Result<Option<f64>, ProviderError> {
        time.get(key)
            .map(|value| {
                value
                    .as_f64()
                    .filter(|n| n.is_finite())
                    .ok_or_else(|| protocol("OpenCode v2 execution clock is malformed"))
            })
            .transpose()
    };
    let busy = read_time("busy")?;
    let idle = read_time("idle")?;
    let running = match (busy, idle) {
        (Some(busy), Some(idle)) => busy > idle,
        (Some(_), None) => true,
        (None, None) if snapshot.messages.is_empty() => false,
        (None, _) => return Err(protocol("OpenCode v2 execution state is unknown")),
    };
    if let Some(active) = snapshot.active.get(native_id) {
        if active.get("type").and_then(Value::as_str) != Some("running") {
            return Err(protocol("OpenCode v2 active entry is malformed"));
        }
        return Ok(true);
    }
    Ok(running)
}

fn recover(target: &EventTarget) -> Result<(), ProviderError> {
    let snapshot = read_recovery(target)?;
    let running = busy(&snapshot, &target.native_id)?;
    {
        let _commit = target
            .event_gate
            .lock()
            .map_err(|_| protocol("OpenCode event gate poisoned"))?;
        if !current(target) {
            return Err(ProviderError::new(
                "provider_disconnected",
                "OpenCode v2 recovery arrived after stream expiry",
            ));
        }
        let mut state = target
            .v2
            .lock()
            .map_err(|_| protocol("OpenCode v2 state lock poisoned"))?;
        state.inbox_pending = !list(&snapshot.inbox)?.is_empty();
        state.inbox_items = list(&snapshot.inbox)?
            .iter()
            .map(|entry| text(entry, "id").map(str::to_owned))
            .collect::<Result<HashSet<_>, _>>()?;
        for row in &snapshot.messages {
            if let Some(change) = state.seed_message(&target.native_id, row)? {
                publish(target, &mut state, change);
            }
        }
        if running {
            if let Some(id) = snapshot
                .messages
                .iter()
                .rev()
                .find(|row| row.get("type").and_then(Value::as_str) == Some("assistant"))
                .and_then(|row| row.get("id").and_then(Value::as_str))
            {
                state.active_messages.insert(
                    target.native_id.clone(),
                    (target.native_id.clone(), id.to_owned()),
                );
            }
        }
        let execution = state
            .executions
            .entry(target.native_id.clone())
            .or_default();
        execution.running = running;
        execution.snapshot_busy = snapshot
            .session
            .pointer("/time/busy")
            .and_then(Value::as_f64);
        execution.snapshot_idle = snapshot
            .session
            .pointer("/time/idle")
            .and_then(Value::as_f64);
        if running {
            publish(
                target,
                &mut state,
                Change::Started {
                    session: target.native_id.clone(),
                },
            );
        }
        drop(state);
        drop(_commit);
        recover_children(target)?;
        let _commit = target
            .event_gate
            .lock()
            .map_err(|_| protocol("OpenCode event gate poisoned"))?;
        if !current(target) {
            return Err(ProviderError::new(
                "provider_disconnected",
                "OpenCode v2 recovery expired during child calibration",
            ));
        }
        let mut state = target
            .v2
            .lock()
            .map_err(|_| protocol("OpenCode v2 state lock poisoned"))?;
        // Replay receipts before snapshots: native receipt publication can race
        // list/detail visibility. Never synthesize answer success from absence.
        for raw in state.buffered.clone() {
            if raw["type"].as_str().is_some_and(|kind| {
                matches!(
                    kind,
                    "permission.replied" | "form.replied" | "form.cancelled"
                )
            }) {
                let change = state.apply(&target.native_id, &raw)?;
                publish(target, &mut state, change);
            }
        }
        for (kind, entries) in [
            ("permission.asked", &snapshot.permissions),
            ("form.created", &snapshot.forms),
        ] {
            for request in list(entries)? {
                let session = request
                    .get("sessionID")
                    .and_then(Value::as_str)
                    .unwrap_or(&target.native_id);
                if session != target.native_id {
                    continue;
                }
                let id = text(request, "id")?;
                if !state.receipts.contains(&(session.into(), id.into())) {
                    if state.pending_requests.len() >= MAX_EVENT_IDS
                        && !state
                            .pending_requests
                            .contains(&(session.into(), id.into()))
                    {
                        return Err(protocol(
                            "OpenCode v2 recovered interactions exceeded their bound",
                        ));
                    }
                    state.interaction_barrier = true;
                    state.pending_requests.insert((session.into(), id.into()));
                    publish(
                        target,
                        &mut state,
                        Change::Pending {
                            session: session.into(),
                            id: id.into(),
                            kind: kind.into(),
                            request: request.clone(),
                        },
                    );
                }
            }
        }
    }
    // The reader continues buffering until the queue is empty under the gate.
    // It cannot overtake older events while a buffered message needs HTTP.
    loop {
        let buffered = {
            let _commit = target
                .event_gate
                .lock()
                .map_err(|_| protocol("OpenCode event gate poisoned"))?;
            if !current(target) {
                return Err(ProviderError::new(
                    "provider_disconnected",
                    "OpenCode v2 recovery expired while reconciling",
                ));
            }
            let mut state = target
                .v2
                .lock()
                .map_err(|_| protocol("OpenCode v2 state lock poisoned"))?;
            if state.buffered.is_empty() {
                state.recovering = false;
                break;
            }
            state.buffered_bytes = 0;
            std::mem::take(&mut state.buffered)
        };
        for raw in buffered {
            process_event(target, raw, false);
        }
    }
    recover_children(target)?;
    if !current(target) {
        return Err(ProviderError::new(
            "provider_disconnected",
            "OpenCode v2 buffered events could not be reconciled",
        ));
    }
    Ok(())
}

/// One card's native owner, resolved under the event gate. A reply may only go
/// to the session that asked (root or proven child) and only for the turn that
/// the card belongs to.
fn pending(
    target: &EventTarget,
    id: &str,
    kind: &str,
    turn_id: &str,
) -> Result<Interaction, ProviderError> {
    let _commit = target
        .event_gate
        .lock()
        .map_err(|_| protocol("OpenCode event gate poisoned"))?;
    if !current(target) {
        return Err(ProviderError::new(
            "provider_disconnected",
            "OpenCode event stream is disconnected",
        ));
    }
    let state = target
        .v2
        .lock()
        .map_err(|_| protocol("OpenCode v2 state lock poisoned"))?;
    let interaction = state
        .interactions
        .get(id)
        .filter(|one| one.kind == kind)
        .cloned()
        .ok_or_else(|| {
            ProviderError::new(
                "approval_not_pending",
                "OpenCode interaction is no longer pending",
            )
        })?;
    if !state.owned(&interaction.session, &target.native_id) {
        return Err(protocol("OpenCode v2 interaction has an unproven owner"));
    }
    if interaction.turn.as_deref().is_some_and(|turn| turn != turn_id) {
        // A card raised without an active turn (a background subagent, or an
        // idle root at attach) belongs to no turn and stays answerable; only a
        // card that names a different turn is refused.
        return Err(ProviderError::new(
            "approval_not_pending",
            "OpenCode interaction belongs to another turn",
        ));
    }
    Ok(interaction)
}

/// Retire one card, optionally publishing the receipt that settles it. The
/// native write already reached its owner, so the card is settled even when the
/// receipt says nothing about who answered it.
fn settle_card(
    target: &EventTarget,
    id: &str,
    receipt: Option<Value>,
) -> Result<(), ProviderError> {
    let settled = {
        let _commit = target
            .event_gate
            .lock()
            .map_err(|_| protocol("OpenCode event gate poisoned"))?;
        let mut state = target
            .v2
            .lock()
            .map_err(|_| protocol("OpenCode v2 state lock poisoned"))?;
        state.settle(id)
    };
    if let (Some(interaction), Some(receipt)) = (settled, receipt) {
        emit_scoped(
            &target.events,
            "opencode",
            &target.threadterm_session,
            Some(&target.native_id),
            interaction.turn.as_deref(),
            "chat.approval.resolved",
            receipt,
            Some(&target.worker_token),
        );
    }
    Ok(())
}

/// Map a native write failure onto the shared interaction contract.
///
/// `400` is definite: the native form is still pending and the card stays
/// editable, so the next attempt uses a new operation id. An already settled or
/// missing request retires the card. Anything else may already have reached the
/// native side, so the card becomes read-only and the stream is fenced: an
/// uncertain answer is never resent.
fn native_write_error(
    target: &EventTarget,
    id: &str,
    error: ProviderError,
    action: &str,
) -> ProviderError {
    let status = error
        .details
        .as_ref()
        .and_then(|details| details["httpStatus"].as_u64());
    match status {
        Some(400) => ProviderError::new(
            "answer_invalid",
            "OpenCode rejected this answer; review the field and submit a new operation",
        ),
        Some(404 | 409) => {
            let _ = settle_card(
                target,
                id,
                Some(json!({"approvalId":id,"status":"expired","outcome":"native",
                    "message":"The native request was already settled."})),
            );
            ProviderError::new(
                "approval_not_pending",
                "The native request was already settled; the card is now read-only",
            )
        }
        _ => {
            let _ = settle_card(
                target,
                id,
                Some(json!({"approvalId":id,"status":"outcomeUnknown","outcome":"unknown",
                    "message":format!("The native {action} outcome is unknown; reconcile before retrying.")})),
            );
            expire_stream(
                target,
                "v2_interaction_outcome_unknown",
                "OpenCode v2 interaction outcome is unknown after event-stream loss",
            );
            ProviderError::new(
                "approval_outcome_unknown",
                format!("The native {action} outcome is unknown and was not resent"),
            )
        }
    }
}

/// Answer (submit) or dismiss one emitted 2.2.5 form on the session that asked.
/// Values are the typed answers the stored card already validated; the native
/// service remains the authority on patterns, formats and settlement.
pub(super) fn answer(
    target: &EventTarget,
    turn_id: &str,
    approval_id: &str,
    response: &Value,
) -> Result<(), ProviderError> {
    validate_native_id(approval_id)?;
    let interaction = pending(target, approval_id, "form.created", turn_id)?;
    let dismiss = response.get("action").and_then(Value::as_str) == Some("dismiss");
    let sent = if dismiss {
        api(target).form_cancel(&interaction.session, approval_id)
    } else {
        let values = response.get("values").cloned().ok_or_else(|| {
            ProviderError::new("answer_invalid", "OpenCode form answer has no values")
        })?;
        api(target).form_reply(&interaction.session, approval_id, &values)
    };
    match sent {
        // The service records the answer receipt and its summary; the adapter
        // only retires its own pending state so nothing is written twice.
        Ok(()) => settle_card(target, approval_id, None),
        Err(error) => Err(native_write_error(target, approval_id, error, "answer")),
    }
}

/// Reply once or reject one emitted 2.2.5 permission request on its owner.
pub(super) fn approve(
    target: &EventTarget,
    turn_id: &str,
    approval_id: &str,
    choice_id: &str,
) -> Result<(), ProviderError> {
    validate_native_id(approval_id)?;
    let decision = match map_allow_deny_choice(choice_id)? {
        "allow" => "once",
        _ => "reject",
    };
    let interaction = pending(target, approval_id, "permission.asked", turn_id)?;
    match api(target).permission_reply(&interaction.session, approval_id, decision) {
        Ok(()) => settle_card(
            target,
            approval_id,
            Some(json!({"approvalId":approval_id,"status":"resolved","outcome":decision})),
        ),
        Err(error) => Err(native_write_error(target, approval_id, error, "approval")),
    }
}

#[cfg(test)]
#[path = "v2_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "v2_recovery_tests.rs"]
mod recovery_tests;

#[cfg(test)]
#[path = "v2_snapshot_tests.rs"]
mod snapshot_tests;

#[cfg(test)]
#[path = "v2_child_recovery_tests.rs"]
mod child_recovery_tests;

#[cfg(test)]
#[path = "v2_interaction_tests.rs"]
mod interaction_tests;

#[cfg(test)]
#[path = "v2_composer_tests.rs"]
mod composer_tests;

#[cfg(test)]
#[path = "v2_history_tests.rs"]
mod history_tests;
