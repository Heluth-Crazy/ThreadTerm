use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
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
    /// `None` represents an aborted block (e.g. the prompt restarted before
    /// the previous command's `D` ever arrived). The frontend store maps
    /// `exitCode === undefined → state: 'aborted'`.
    pub exit_code: Option<i32>,
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
        let _ = match self {
            Self::Started(p) => app_handle.emit("pty://block-started", p),
            Self::Finished(p) => app_handle.emit("pty://block-finished", p),
        };
    }
}

#[derive(Debug, Clone, Default)]
enum ParseMode {
    #[default]
    Ground,
    Escape,
    Osc { data: String, saw_escape: bool },
}

#[derive(Debug, Clone, Default)]
pub struct BlockParser {
    session_id: String,
    mode: ParseMode,
    capture_command: bool,
    command_buffer: String,
    pending_cmd_id: Option<String>,
    pending_cwd: Option<String>,
    pending_duration_ms: Option<u64>,
    pending_finish: Option<BlockFinishedPayload>,
    active_block_id: Option<String>,
    next_block_index: u64,
}

impl BlockParser {
    pub fn new(session_id: String) -> Self {
        Self {
            session_id,
            ..Default::default()
        }
    }

    pub fn ingest(&mut self, input: &str) -> Vec<BlockEvent> {
        let mut events = Vec::new();
        for ch in input.chars() {
            let (next_mode, osc) = self.step(ch);
            if let Some(mode) = next_mode { self.mode = mode; }
            if let Some(osc) = osc { self.handle_osc(&osc, &mut events); }
        }
        self.flush_pending_finish(&mut events);
        events
    }

    fn step(&mut self, ch: char) -> (Option<ParseMode>, Option<String>) {
        match &mut self.mode {
            ParseMode::Ground if ch == ESC => (Some(ParseMode::Escape), None),
            ParseMode::Ground => {
                if self.capture_command
                    && (ch == '\r' || ch == '\n' || ch == '\t' || !ch.is_control())
                {
                    self.command_buffer.push(ch);
                }
                (None, None)
            }
            ParseMode::Escape => {
                let next = if ch == ']' {
                    ParseMode::Osc { data: String::new(), saw_escape: false }
                } else {
                    ParseMode::Ground
                };
                (Some(next), None)
            }
            ParseMode::Osc { data, saw_escape } if *saw_escape => {
                if ch == '\\' {
                    return (Some(ParseMode::Ground), Some(std::mem::take(data)));
                }
                data.push(ESC);
                data.push(ch);
                *saw_escape = false;
                (None, None)
            }
            ParseMode::Osc { data, .. } if ch == BEL => {
                (Some(ParseMode::Ground), Some(std::mem::take(data)))
            }
            ParseMode::Osc { saw_escape, .. } if ch == ESC => {
                *saw_escape = true;
                (None, None)
            }
            ParseMode::Osc { data, .. } => {
                data.push(ch);
                (None, None)
            }
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

    // Repeated `A` after `C` = prompt restarted (p10k / Starship re-emit);
    // abort the still-active block so listeners never see leaked entries.
    fn handle_osc_133(&mut self, action: &str, rest: &[&str], events: &mut Vec<BlockEvent>) {
        match action {
            "A" => {
                if self.active_block_id.is_some() {
                    self.finish_block(None);
                    self.flush_pending_finish(events);
                }
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
            "C" if self.active_block_id.is_none() => {
                self.capture_command = false;
                self.start_block(events);
            }
            "C" => self.capture_command = false,
            "D" => {
                let code = rest.first().and_then(|v| v.parse::<i32>().ok()).unwrap_or(0);
                self.finish_block(Some(code));
            }
            _ => {}
        }
    }

    fn handle_threadterm_osc(&mut self, fields: &[&str], events: &mut Vec<BlockEvent>) {
        for field in fields {
            let Some((key, value)) = field.split_once('=') else { continue };
            let value = value.trim();
            match key.trim() {
                "cmd_id" => self.pending_cmd_id = Some(value.to_string()),
                "cwd" => self.pending_cwd = decode_base64_utf8(value),
                "duration" => {
                    let Ok(duration) = value.parse::<u64>() else { continue };
                    self.pending_duration_ms = Some(duration);
                    if let Some(mut finish) = self.pending_finish.take() {
                        finish.duration_ms = Some(duration);
                        events.push(BlockEvent::Finished(finish));
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
        self.active_block_id = Some(block_id.clone());
        events.push(BlockEvent::Started(BlockStartedPayload {
            session_id: self.session_id.clone(),
            block_id,
            command: clean_command(&self.command_buffer),
            cwd: self.pending_cwd.take().unwrap_or_default(),
            started_at: now_millis(),
        }));
        self.command_buffer.clear();
    }

    fn finish_block(&mut self, exit_code: Option<i32>) {
        let Some(block_id) = self.active_block_id.take() else { return };
        self.pending_finish = Some(BlockFinishedPayload {
            session_id: self.session_id.clone(),
            block_id,
            exit_code,
            finished_at: now_millis(),
            duration_ms: self.pending_duration_ms.take(),
        });
    }

    fn flush_pending_finish(&mut self, events: &mut Vec<BlockEvent>) {
        if let Some(f) = self.pending_finish.take() {
            events.push(BlockEvent::Finished(f));
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
    let stripped: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    String::from_utf8(BASE64.decode(stripped).ok()?).ok()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
