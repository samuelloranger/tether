#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub bytes: Vec<u8>,
    /// Byte offsets of the line in the stream, newline included in `end`.
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum LineError {
    #[error("a line is longer than {limit} bytes")]
    LineTooLong { limit: usize },
}

pub const DEFAULT_MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// Splits on 0x0A bytes, never on decoded characters, so a multi-byte UTF-8 character cut by a
/// chunk boundary stays whole in the line it belongs to.
#[derive(Debug, Clone)]
pub struct LineSplitter {
    max_line_bytes: usize,
    buffer: Vec<u8>,
    buffer_start: usize,
    failed: bool,
}

impl Default for LineSplitter {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_LINE_BYTES, 0)
    }
}

impl LineSplitter {
    pub fn new(max_line_bytes: usize, start_offset: usize) -> Self {
        Self {
            max_line_bytes,
            buffer: Vec::new(),
            buffer_start: start_offset,
            failed: false,
        }
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<Line>, LineError> {
        if self.failed {
            return Err(self.error());
        }
        self.buffer.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut consumed = 0;
        while let Some(rel) = self.buffer[consumed..].iter().position(|&b| b == 0x0A) {
            let mut body = &self.buffer[consumed..consumed + rel];
            if body.last() == Some(&0x0D) {
                body = &body[..body.len() - 1];
            }
            if rel > self.max_line_bytes {
                return Err(self.fail());
            }
            if !body.is_empty() {
                lines.push(Line {
                    bytes: body.to_vec(),
                    start: self.buffer_start + consumed,
                    end: self.buffer_start + consumed + rel + 1,
                });
            }
            consumed += rel + 1;
        }
        self.buffer.drain(..consumed);
        self.buffer_start += consumed;
        if self.buffer.len() > self.max_line_bytes {
            return Err(self.fail());
        }
        Ok(lines)
    }

    fn error(&self) -> LineError {
        LineError::LineTooLong {
            limit: self.max_line_bytes,
        }
    }

    fn fail(&mut self) -> LineError {
        self.failed = true;
        self.buffer = Vec::new();
        self.error()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(lines: &[Line]) -> Vec<String> {
        lines
            .iter()
            .map(|l| String::from_utf8_lossy(&l.bytes).into_owned())
            .collect()
    }

    #[test]
    fn lines_split_across_arbitrary_chunks() {
        let mut s = LineSplitter::default();
        let mut out = Vec::new();
        for chunk in ["{\"a\":", "1}\n{\"b\"", ":2}\n{\"c\":3}", "\n"] {
            out.extend(texts(&s.feed(chunk.as_bytes()).unwrap()));
        }
        assert_eq!(out, ["{\"a\":1}", "{\"b\":2}", "{\"c\":3}"]);
    }

    #[test]
    fn a_multibyte_character_cut_at_every_byte_boundary_stays_whole() {
        let line = "{\"t\":\"é 你 😀\"}";
        let bytes = format!("{line}\n").into_bytes();
        for cut in 1..bytes.len() {
            let mut s = LineSplitter::default();
            let mut out = texts(&s.feed(&bytes[..cut]).unwrap());
            out.extend(texts(&s.feed(&bytes[cut..]).unwrap()));
            assert_eq!(out, [line], "cut at {cut}");
        }
    }

    #[test]
    fn crlf_is_tolerated_and_blank_lines_are_skipped() {
        let mut s = LineSplitter::default();
        let lines = s.feed(b"a\r\n\r\n\nb\r\n").unwrap();
        assert_eq!(texts(&lines), ["a", "b"]);
        assert_eq!(lines.iter().map(|l| l.start).collect::<Vec<_>>(), [0, 6]);
        assert_eq!(lines.iter().map(|l| l.end).collect::<Vec<_>>(), [3, 9]);
    }

    #[test]
    fn offsets_advance_across_chunks() {
        let mut s = LineSplitter::default();
        s.feed(b"abc\nde").unwrap();
        let lines = s.feed(b"f\n").unwrap();
        assert_eq!(
            lines,
            [Line {
                bytes: b"def".to_vec(),
                start: 4,
                end: 8
            }]
        );
    }

    #[test]
    fn an_unterminated_line_past_the_cap_fails_loudly() {
        let mut s = LineSplitter::new(8, 0);
        assert!(s.feed(b"12345678").is_ok());
        assert_eq!(s.feed(b"9"), Err(LineError::LineTooLong { limit: 8 }));
        assert!(s.feed(b"\n").is_err());
    }

    #[test]
    fn a_complete_line_past_the_cap_fails_too() {
        let mut s = LineSplitter::new(4, 0);
        assert!(s.feed(b"ok\nwaytoolong\n").is_err());
    }
}
