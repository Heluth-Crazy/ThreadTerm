use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PARSER_VERSION: u32 = 2;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Buckets {
    pub input: Option<i64>,
    pub cache_read: Option<i64>,
    pub cache_write5m: Option<i64>,
    pub cache_write1h: Option<i64>,
    /// Exact cache writes where the native format does not report a TTL.
    /// They remain token coverage but are deliberately not priceable.
    pub cache_write_unknown: Option<i64>,
    pub output: Option<i64>,
    pub reasoning: Option<i64>,
}

impl Buckets {
    pub fn total(&self) -> i64 {
        [
            self.input,
            self.cache_read,
            self.cache_write5m,
            self.cache_write1h,
            self.cache_write_unknown,
            self.output,
        ]
        .into_iter()
        .flatten()
        .sum()
    }
    pub fn merge_max(&mut self, other: &Self) {
        fn merge(a: &mut Option<i64>, b: Option<i64>) {
            if let Some(b) = b {
                *a = Some(a.unwrap_or(0).max(b));
            }
        }
        merge(&mut self.input, other.input);
        merge(&mut self.cache_read, other.cache_read);
        merge(&mut self.cache_write5m, other.cache_write5m);
        merge(&mut self.cache_write1h, other.cache_write1h);
        merge(&mut self.cache_write_unknown, other.cache_write_unknown);
        merge(&mut self.output, other.output);
        merge(&mut self.reasoning, other.reasoning);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub key: String,
    pub provider: String,
    pub model: Option<String>,
    pub occurred_at: String,
    pub native_session_id: String,
    pub parent_native_session_id: Option<String>,
    pub subagent: bool,
    #[serde(flatten)]
    pub buckets: Buckets,
    pub quality: String,
    pub reported_cost: Option<f64>,
    pub cwd: Option<String>,
    pub source: String,
    pub parser_version: u32,
    pub threadterm_session_id: Option<String>,
    pub turn_id: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
}

impl Fact {
    pub fn new(provider: &str, session: &str, key: &str, occurred_at: &str) -> Self {
        Self {
            key: format!("{provider}:{key}"),
            provider: provider.into(),
            model: None,
            occurred_at: occurred_at.into(),
            native_session_id: session.into(),
            parent_native_session_id: None,
            subagent: false,
            buckets: Buckets::default(),
            quality: "exact".into(),
            reported_cost: None,
            cwd: None,
            source: String::new(),
            parser_version: PARSER_VERSION,
            threadterm_session_id: None,
            turn_id: None,
            started_at: None,
            ended_at: None,
        }
    }
}

/// Persist only numeric counters, native coordinates, model IDs and the cwd.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderState {
    pub session_id: String,
    pub parent_session_id: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub data: Value,
}

#[derive(Default, Debug)]
pub struct Parsed {
    pub facts: Vec<Fact>,
    pub problems: Vec<String>,
    /// Native keys superseded by an authoritative observation from this line.
    /// The scanner applies these before it stores `facts`, so a typed Codex
    /// request can replace a previously persisted legacy cumulative mirror.
    pub replaced_keys: Vec<String>,
    /// A supported usage record establishes native authority for this session.
    pub covered_sessions: Vec<String>,
}

pub fn number(value: &Value, names: &[&str]) -> Option<i64> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_i64))
        .filter(|n| *n >= 0)
}

pub fn text<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_str))
}

pub fn timestamp(value: &Value) -> Option<String> {
    if let Some(s) = value.as_str() {
        return chrono::DateTime::parse_from_rfc3339(s).ok().map(|t| {
            t.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });
    }
    let n = value.as_i64()?;
    let millis = if n.abs() < 100_000_000_000 {
        n.checked_mul(1000)?
    } else {
        n
    };
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
