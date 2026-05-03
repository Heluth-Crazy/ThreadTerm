#[derive(Default)]
pub(super) struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub(super) fn decode(&mut self, chunk: &[u8]) -> String {
        let mut bytes = Vec::with_capacity(self.pending.len() + chunk.len());
        bytes.extend_from_slice(&self.pending);
        bytes.extend_from_slice(chunk);
        self.pending.clear();

        let mut output = String::new();
        let mut input = bytes.as_slice();
        loop {
            match std::str::from_utf8(input) {
                Ok(valid) => {
                    output.push_str(valid);
                    break;
                }
                Err(err) => {
                    let valid_up_to = err.valid_up_to();
                    if valid_up_to > 0 {
                        output.push_str(
                            std::str::from_utf8(&input[..valid_up_to])
                                .expect("valid_up_to must be valid UTF-8"),
                        );
                    }
                    match err.error_len() {
                        Some(invalid_len) => {
                            output.push('\u{FFFD}');
                            input = &input[valid_up_to + invalid_len..];
                        }
                        None => {
                            self.pending.extend_from_slice(&input[valid_up_to..]);
                            break;
                        }
                    }
                }
            }
        }
        output
    }

    pub(super) fn flush_lossy(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let pending = std::mem::take(&mut self.pending);
        String::from_utf8_lossy(&pending).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8StreamDecoder;

    #[test]
    fn preserves_split_cjk_codepoint() {
        let mut decoder = Utf8StreamDecoder::default();
        let text = "中文";
        let bytes = text.as_bytes();

        assert_eq!(decoder.decode(&bytes[..1]), "");
        assert_eq!(decoder.decode(&bytes[1..3]), "中");
        assert_eq!(decoder.decode(&bytes[3..]), "文");
        assert_eq!(decoder.flush_lossy(), "");
    }

    #[test]
    fn preserves_split_emoji_codepoint() {
        let mut decoder = Utf8StreamDecoder::default();
        let text = "ok 😀 done";
        let bytes = text.as_bytes();
        let split = text.find('😀').expect("emoji exists") + 2;

        let first = decoder.decode(&bytes[..split]);
        let second = decoder.decode(&bytes[split..]);

        assert_eq!(format!("{first}{second}"), text);
        assert_eq!(decoder.flush_lossy(), "");
    }

    #[test]
    fn replaces_invalid_byte_but_keeps_following_text() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.decode(b"ok \xff next"), "ok \u{FFFD} next");
        assert_eq!(decoder.flush_lossy(), "");
    }

    #[test]
    fn flushes_incomplete_tail_lossily_on_eof() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.decode(&[0xE4, 0xB8]), "");
        assert_eq!(decoder.flush_lossy(), "\u{FFFD}");
    }
}
