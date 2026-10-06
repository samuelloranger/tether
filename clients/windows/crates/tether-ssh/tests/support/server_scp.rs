use std::sync::{Arc, Mutex};

use russh::ChannelId;
use russh::server::Session;

use super::server::Recorded;

/// Undo `shell_quote`: `'a'"'"'b'` → `a'b`. Only the form core produces.
pub fn unquote(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.trim().chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                for c in chars.by_ref() {
                    if c == '\'' {
                        break;
                    }
                    out.push(c);
                }
            }
            '"' => {
                for c in chars.by_ref() {
                    if c == '"' {
                        break;
                    }
                    out.push(c);
                }
            }
            other => out.push(other),
        }
    }
    out
}

pub struct ScpSink {
    target: String,
    buf: Vec<u8>,
    expect: Option<(usize, String)>,
}

impl ScpSink {
    pub fn new(target: String) -> Self {
        ScpSink {
            target,
            buf: Vec::new(),
            expect: None,
        }
    }

    pub fn feed(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
        state: &Arc<Mutex<Recorded>>,
    ) {
        self.buf.extend_from_slice(data);
        loop {
            match &self.expect {
                None => {
                    let Some(nl) = self.buf.iter().position(|b| *b == b'\n') else {
                        return;
                    };
                    let line = String::from_utf8_lossy(&self.buf[..nl]).into_owned();
                    self.buf.drain(..=nl);
                    if self.target.starts_with("/refuse") {
                        let _ = session
                            .data(channel, b"\x01scp: /refuse: Permission denied\n".to_vec());
                        return;
                    }
                    let mut parts = line.splitn(3, ' ');
                    let (_mode, len, name) = (parts.next(), parts.next(), parts.next());
                    let len: usize = len.and_then(|l| l.parse().ok()).unwrap_or(0);
                    self.expect = Some((len, name.unwrap_or("").to_string()));
                    let _ = session.data(channel, vec![0u8]);
                }
                Some((len, _name)) => {
                    if self.buf.len() < len + 1 {
                        return;
                    }
                    let body = self.buf[..*len].to_vec();
                    self.buf.drain(..=*len);
                    state
                        .lock()
                        .unwrap()
                        .uploads
                        .insert(self.target.clone(), body);
                    self.expect = None;
                    let _ = session.data(channel, vec![0u8]);
                }
            }
        }
    }
}
