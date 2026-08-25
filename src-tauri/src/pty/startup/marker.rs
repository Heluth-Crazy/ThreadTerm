const MARKER_PREFIX: &[u8] = b"\x1b]777;threadterm;ready;";
const NONCE_LEN: usize = 32;
const MARKER_BODY_LEN: usize = MARKER_PREFIX.len() + NONCE_LEN;

pub const STARTUP_MARKER_INVALID: &str = "startup_marker_invalid";
#[cfg(test)]
pub const STARTUP_MARKER_MAX_TAIL: usize = 128;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Ground,
    Esc,
    Marker,
    String { dcs: bool },
    StringEsc { dcs: bool },
}

pub struct ReadyMarkerFilter {
    nonce: [u8; NONCE_LEN],
    pending: Vec<u8>,
    state: State,
}

pub struct ReadyMarkerOutput {
    pub visible: Vec<u8>,
    pub matched: usize,
}

impl ReadyMarkerFilter {
    pub fn new(nonce: &str) -> Result<Self, &'static str> {
        if nonce.len() != NONCE_LEN
            || !nonce
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err(STARTUP_MARKER_INVALID);
        }
        let mut owned_nonce = [0u8; NONCE_LEN];
        owned_nonce.copy_from_slice(nonce.as_bytes());
        Ok(Self {
            nonce: owned_nonce,
            pending: Vec::new(),
            state: State::Ground,
        })
    }

    pub fn consume(&mut self, bytes: &[u8]) -> ReadyMarkerOutput {
        let mut visible = Vec::with_capacity(bytes.len());
        let mut matched = 0;
        for &byte in bytes {
            self.feed_byte(byte, &mut visible, &mut matched);
        }
        ReadyMarkerOutput { visible, matched }
    }

    pub fn finish(&mut self) -> ReadyMarkerOutput {
        let visible = std::mem::take(&mut self.pending);
        self.state = State::Ground;
        ReadyMarkerOutput {
            visible,
            matched: 0,
        }
    }

    pub fn reset(&mut self) {
        self.pending.clear();
        self.state = State::Ground;
    }

    pub fn buffered_len(&self) -> usize {
        self.pending.len()
    }

    fn feed_byte(&mut self, byte: u8, visible: &mut Vec<u8>, matched: &mut usize) {
        loop {
            match self.state {
                State::Ground => {
                    if byte == 0x1b {
                        self.pending.push(byte);
                        self.state = State::Esc;
                    } else {
                        visible.push(byte);
                    }
                    return;
                }
                State::Esc => {
                    if byte == b']' {
                        self.pending.push(byte);
                        self.state = State::Marker;
                    } else if byte == b'P' {
                        self.pending.push(byte);
                        self.emit_pending(visible);
                        self.state = State::String { dcs: true };
                    } else {
                        self.emit_pending(visible);
                        self.state = State::Ground;
                        continue;
                    }
                    return;
                }
                State::Marker => {
                    if self.pending.len() < MARKER_BODY_LEN {
                        if byte == self.body_byte(self.pending.len()) {
                            self.pending.push(byte);
                            return;
                        }
                        self.emit_pending(visible);
                        self.state = State::String { dcs: false };
                        continue;
                    }
                    if self.pending.len() == MARKER_BODY_LEN && byte == 0x07 {
                        self.pending.clear();
                        self.state = State::Ground;
                        *matched += 1;
                    } else if self.pending.len() == MARKER_BODY_LEN && byte == 0x1b {
                        self.pending.push(byte);
                    } else if self.pending.len() == MARKER_BODY_LEN + 1 && byte == b'\\' {
                        self.pending.clear();
                        self.state = State::Ground;
                        *matched += 1;
                    } else {
                        self.emit_pending(visible);
                        self.state = State::String { dcs: false };
                        continue;
                    }
                    return;
                }
                State::String { dcs } => {
                    if !dcs && byte == 0x07 {
                        visible.push(byte);
                        self.state = State::Ground;
                    } else if byte == 0x1b {
                        self.pending.push(byte);
                        self.state = State::StringEsc { dcs };
                    } else {
                        visible.push(byte);
                    }
                    return;
                }
                State::StringEsc { dcs } => {
                    if byte == b'\\' {
                        self.pending.push(byte);
                        self.emit_pending(visible);
                        self.state = State::Ground;
                    } else {
                        self.emit_pending(visible);
                        self.state = State::String { dcs };
                        continue;
                    }
                    return;
                }
            }
        }
    }

    fn body_byte(&self, index: usize) -> u8 {
        if index < MARKER_PREFIX.len() {
            MARKER_PREFIX[index]
        } else {
            self.nonce[index - MARKER_PREFIX.len()]
        }
    }

    fn emit_pending(&mut self, visible: &mut Vec<u8>) {
        visible.extend(std::mem::take(&mut self.pending));
    }
}
