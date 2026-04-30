use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const ESC: char = '\x1b';
const BEL: char = '\x07';

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlockStartedPayload {
    pub session_id: String,
    pub block_id: String,
    pub command: String,
    pub cwd: String,
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlockFinishedPayload {
    pub session_id: String,
    pub block_id: String,
    pub exit_code: i32,
    pub finished_at: u64,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockEvent {
    Started(BlockStartedPayload),
    Finished(BlockFinishedPayload),
}

impl BlockEvent {
    pub fn emit(&self, app_handle: &AppHandle) {
        match self {
            Self::Started(payload) => {
                let _ = app_handle.emit("pty://block-started", payload);
            }
            Self::Finished(payload) => {
                let _ = app_handle.emit("pty://block-finished", payload);
            }
        }
    }
}

#[derive(Debug, Clone)]
enum ParseMode {
    Ground,
    Escape,
    Osc { data: String, saw_escape: bool },
}

#[derive(Debug, Clone)]
struct ActiveBlock {
    block_id: String,
}

#[derive(Debug, Clone)]
pub struct BlockParser {
    session_id: String,
    mode: ParseMode,
    capture_command: bool,
    command_buffer: String,
    pending_cmd_id: Option<String>,
    pending_cwd: Option<String>,
    pending_duration_ms: Option<u64>,
    pending_finish: Option<BlockFinishedPayload>,
    active_block: Option<ActiveBlock>,
    next_block_index: u64,
}

impl BlockParser {
    pub fn new(session_id: String) -> Self {
        Self {
            session_id,
            mode: ParseMode::Ground,
            capture_command: false,
            command_buffer: String::new(),
            pending_cmd_id: None,
            pending_cwd: None,
            pending_duration_ms: None,
            pending_finish: None,
            active_block: None,
            next_block_index: 0,
        }
    }

    pub fn ingest(&mut self, input: &str) -> Vec<BlockEvent> {
        let mut events = Vec::new();

        for ch in input.chars() {
            let mut next_mode = None;
            let mut completed_osc = None;

            match &mut self.mode {
                ParseMode::Ground => {
                    if ch == ESC {
                        next_mode = Some(ParseMode::Escape);
                    } else {
                        self.capture_char(ch);
                    }
                }
                ParseMode::Escape => {
                    if ch == ']' {
                        next_mode = Some(ParseMode::Osc {
                            data: String::new(),
                            saw_escape: false,
                        });
                    } else {
                        next_mode = Some(ParseMode::Ground);
                    }
                }
                ParseMode::Osc { data, saw_escape } => {
                    if *saw_escape {
                        if ch == '\\' {
                            completed_osc = Some(data.clone());
                            next_mode = Some(ParseMode::Ground);
                        } else {
                            data.push(ESC);
                            data.push(ch);
                            *saw_escape = false;
                        }
                    } else if ch == BEL {
                        completed_osc = Some(data.clone());
                        next_mode = Some(ParseMode::Ground);
                    } else if ch == ESC {
                        *saw_escape = true;
                    } else {
                        data.push(ch);
                    }
                }
            }

            if let Some(mode) = next_mode {
                self.mode = mode;
            }
            if let Some(osc) = completed_osc {
                self.handle_osc(&osc, &mut events);
            }
        }

        self.flush_pending_finish(&mut events);
        events
    }

    fn capture_char(&mut self, ch: char) {
        if !self.capture_command {
            return;
        }

        if ch == '\r' || ch == '\n' || ch == '\t' || !ch.is_control() {
            self.command_buffer.push(ch);
        }
    }

    fn handle_osc(&mut self, content: &str, events: &mut Vec<BlockEvent>) {
        let parts: Vec<&str> = content.split(';').map(str::trim).collect();
        match parts.as_slice() {
            ["133", action, rest @ ..] => self.handle_osc_133(action, rest, events),
            ["6973", rest @ ..] => self.handle_threadterm_osc(rest, events),
            _ => {}
        }
    }

    fn handle_osc_133(&mut self, action: &str, rest: &[&str], events: &mut Vec<BlockEvent>) {
        match action {
            "A" => {
                self.capture_command = false;
                self.command_buffer.clear();
            }
            "B" => {
                self.flush_pending_finish(events);
                self.capture_command = true;
                self.command_buffer.clear();
                self.pending_cmd_id = None;
                self.pending_cwd = None;
                self.pending_duration_ms = None;
            }
            "C" => {
                self.capture_command = false;
                if self.active_block.is_none() {
                    self.start_block(events);
                }
            }
            "D" => {
                let exit_code = rest
                    .first()
                    .and_then(|value| value.parse::<i32>().ok())
                    .unwrap_or(0);
                self.finish_block(exit_code);
            }
            _ => {}
        }
    }

    fn handle_threadterm_osc(&mut self, fields: &[&str], events: &mut Vec<BlockEvent>) {
        for field in fields {
            let Some((key, value)) = field.split_once('=') else {
                continue;
            };
            match key.trim() {
                "cmd_id" => self.pending_cmd_id = Some(value.trim().to_string()),
                "cwd" => {
                    self.pending_cwd = decode_base64_utf8(value.trim());
                }
                "duration" => {
                    if let Ok(duration) = value.trim().parse::<u64>() {
                        self.pending_duration_ms = Some(duration);
                        if let Some(mut finish) = self.pending_finish.take() {
                            finish.duration_ms = Some(duration);
                            events.push(BlockEvent::Finished(finish));
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn start_block(&mut self, events: &mut Vec<BlockEvent>) {
        self.next_block_index += 1;
        let block_id = self
            .pending_cmd_id
            .take()
            .unwrap_or_else(|| format!("{}-block-{}", self.session_id, self.next_block_index));
        let command = clean_command(&self.command_buffer);
        let cwd = self.pending_cwd.take().unwrap_or_default();
        let started_at = now_millis();

        self.active_block = Some(ActiveBlock {
            block_id: block_id.clone(),
        });
        events.push(BlockEvent::Started(BlockStartedPayload {
            session_id: self.session_id.clone(),
            block_id,
            command,
            cwd,
            started_at,
        }));
        self.command_buffer.clear();
    }

    fn finish_block(&mut self, exit_code: i32) {
        let Some(active) = self.active_block.take() else {
            return;
        };
        self.pending_finish = Some(BlockFinishedPayload {
            session_id: self.session_id.clone(),
            block_id: active.block_id,
            exit_code,
            finished_at: now_millis(),
            duration_ms: self.pending_duration_ms.take(),
        });
    }

    fn flush_pending_finish(&mut self, events: &mut Vec<BlockEvent>) {
        if let Some(finish) = self.pending_finish.take() {
            events.push(BlockEvent::Finished(finish));
        }
    }
}

fn clean_command(buffer: &str) -> String {
    buffer
        .replace('\r', "\n")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .next_back()
        .unwrap_or("")
        .to_string()
}

fn decode_base64_utf8(input: &str) -> Option<String> {
    let mut out = Vec::new();
    let mut chunk = [0u8; 4];
    let mut chunk_len = 0usize;

    for byte in input.bytes().filter(|byte| !byte.is_ascii_whitespace()) {
        chunk[chunk_len] = byte;
        chunk_len += 1;
        if chunk_len == 4 {
            decode_base64_chunk(&chunk, &mut out)?;
            chunk_len = 0;
        }
    }

    if chunk_len != 0 {
        for slot in chunk.iter_mut().skip(chunk_len) {
            *slot = b'=';
        }
        decode_base64_chunk(&chunk, &mut out)?;
    }

    String::from_utf8(out).ok()
}

fn decode_base64_chunk(chunk: &[u8; 4], out: &mut Vec<u8>) -> Option<()> {
    let mut values = [0u8; 4];
    let mut padding = 0usize;

    for (idx, byte) in chunk.iter().enumerate() {
        if *byte == b'=' {
            values[idx] = 0;
            padding += 1;
        } else {
            values[idx] = base64_value(*byte)?;
        }
    }

    out.push((values[0] << 2) | (values[1] >> 4));
    if padding < 2 {
        out.push((values[1] << 4) | (values[2] >> 2));
    }
    if padding == 0 {
        out.push((values[2] << 6) | values[3]);
    }

    Some(())
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
