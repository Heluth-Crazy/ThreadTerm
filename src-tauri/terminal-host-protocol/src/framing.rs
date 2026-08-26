use std::{error::Error, fmt};

pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// A hello is received before authentication, so it has a deliberately tighter
/// allocation limit than ordinary authenticated protocol traffic.
pub const MAX_HELLO_FRAME_BYTES: usize = 64 * 1024;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FrameError {
    ZeroLength,
    TooLarge,
    TruncatedHeader,
    TruncatedBody,
    InvalidUtf8,
    InvalidJson,
}
impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::ZeroLength => "zero_length_frame",
            Self::TooLarge => "frame_too_large",
            Self::TruncatedHeader => "truncated_frame_header",
            Self::TruncatedBody => "truncated_frame_body",
            Self::InvalidUtf8 => "invalid_utf8_frame",
            Self::InvalidJson => "invalid_json_frame",
        })
    }
}
impl Error for FrameError {}

pub struct FrameDecoder {
    max_frame_bytes: usize,
    header: Vec<u8>,
    expected: Option<usize>,
    body: Vec<u8>,
}
impl Default for FrameDecoder {
    fn default() -> Self {
        Self::with_max_frame_bytes(MAX_FRAME_BYTES)
    }
}
impl FrameDecoder {
    pub fn with_max_frame_bytes(max_frame_bytes: usize) -> Self {
        assert!(
            (1..=MAX_FRAME_BYTES).contains(&max_frame_bytes),
            "frame cap must be within the protocol maximum"
        );
        Self {
            max_frame_bytes,
            header: Vec::new(),
            expected: None,
            body: Vec::new(),
        }
    }
    pub fn push(&mut self, mut input: &[u8]) -> Result<Vec<Vec<u8>>, FrameError> {
        let mut frames = Vec::new();
        while !input.is_empty() {
            if self.expected.is_none() {
                let need = 4 - self.header.len();
                let take = need.min(input.len());
                self.header.extend_from_slice(&input[..take]);
                input = &input[take..];
                if self.header.len() < 4 {
                    continue;
                }
                let length =
                    u32::from_le_bytes(self.header[..].try_into().expect("four byte header"))
                        as usize;
                self.header.clear();
                if length == 0 {
                    self.reset();
                    return Err(FrameError::ZeroLength);
                }
                if length > self.max_frame_bytes {
                    self.reset();
                    return Err(FrameError::TooLarge);
                }
                self.body.reserve_exact(length);
                self.expected = Some(length);
            }
            let expected = self.expected.expect("set after validated header");
            let take = (expected - self.body.len()).min(input.len());
            self.body.extend_from_slice(&input[..take]);
            input = &input[take..];
            if self.body.len() == expected {
                frames.push(std::mem::take(&mut self.body));
                self.expected = None;
            }
        }
        Ok(frames)
    }
    pub fn finish(self) -> Result<(), FrameError> {
        if !self.header.is_empty() {
            Err(FrameError::TruncatedHeader)
        } else if self.expected.is_some() {
            Err(FrameError::TruncatedBody)
        } else {
            Ok(())
        }
    }
    pub fn decode_json<T: serde::de::DeserializeOwned>(
        &mut self,
        input: &[u8],
    ) -> Result<Vec<T>, FrameError> {
        self.push(input)?
            .into_iter()
            .map(|bytes| {
                let value = std::str::from_utf8(&bytes).map_err(|_| FrameError::InvalidUtf8)?;
                serde_json::from_str(value).map_err(|_| FrameError::InvalidJson)
            })
            .collect()
    }
    fn reset(&mut self) {
        self.header.clear();
        self.expected = None;
        self.body.clear();
    }
}
pub fn encode_frame(body: &[u8]) -> Result<Vec<u8>, FrameError> {
    if body.is_empty() {
        return Err(FrameError::ZeroLength);
    }
    if body.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(body);
    Ok(frame)
}
pub fn encode_json_frame<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, FrameError> {
    encode_frame(&serde_json::to_vec(value).map_err(|_| FrameError::InvalidJson)?)
}
