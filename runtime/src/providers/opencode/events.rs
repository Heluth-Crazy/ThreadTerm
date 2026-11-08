//! Native framing/liveness only. V2 transcript/recovery projection remains fenced.
use super::{ApiDialect, MAX_SSE_LINE_BYTES, SSE_EVENT_SILENCE_LIMIT};
use serde_json::Value;
use std::io;
use std::time::Duration;

pub(super) enum NativeFrame {
    Heartbeat,
    Event(Value),
}

pub(super) fn silence_limit(dialect: ApiDialect) -> Duration {
    match dialect {
        ApiDialect::Legacy => SSE_EVENT_SILENCE_LIMIT,
        ApiDialect::V2 => Duration::from_secs(50),
    }
}

pub(super) struct FrameDecoder {
    dialect: ApiDialect,
    data: String,
    bytes: usize,
    lines: usize,
    exact_heartbeat: bool,
}

impl FrameDecoder {
    pub(super) fn new(dialect: ApiDialect) -> Self {
        Self {
            dialect,
            data: String::new(),
            bytes: 0,
            lines: 0,
            exact_heartbeat: false,
        }
    }

    pub(super) fn push_line(&mut self, line: &str) -> io::Result<Option<NativeFrame>> {
        if !line.ends_with('\n') || self.bytes.saturating_add(line.len()) > MAX_SSE_LINE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "OpenCode SSE frame is incomplete or exceeds its size limit",
            ));
        }
        self.bytes += line.len();
        let line = line.strip_suffix('\n').unwrap_or(line);
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            let frame = if !self.data.is_empty() {
                serde_json::from_str::<Value>(&self.data)
                    .ok()
                    .filter(|raw| match self.dialect {
                        ApiDialect::Legacy => super::valid_native_sse_frame(raw),
                        ApiDialect::V2 => {
                            raw.get("id")
                                .and_then(Value::as_str)
                                .is_some_and(|id| !id.is_empty())
                                && raw
                                    .get("type")
                                    .and_then(Value::as_str)
                                    .is_some_and(|kind| !kind.is_empty())
                                && raw.get("data").is_some_and(Value::is_object)
                        }
                    })
                    .map(NativeFrame::Event)
            } else if self.dialect == ApiDialect::V2 && self.lines == 1 && self.exact_heartbeat {
                Some(NativeFrame::Heartbeat)
            } else {
                None
            };
            self.data.clear();
            self.bytes = 0;
            self.lines = 0;
            self.exact_heartbeat = false;
            return Ok(frame);
        }
        self.lines += 1;
        self.exact_heartbeat = line == ": heartbeat";
        if let Some(data) = line.strip_prefix("data:") {
            if !self.data.is_empty() {
                self.data.push('\n');
            }
            // Keep the legacy whitespace behavior. JSON decoding owns validity.
            self.data.push_str(data.trim_start());
        }
        Ok(None)
    }
}

#[cfg(test)]
#[path = "events_tests.rs"]
mod tests;
