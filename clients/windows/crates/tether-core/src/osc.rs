#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressState {
    Normal,
    Error,
    Indeterminate,
    Paused,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub state: ProgressState,
    pub percent: u8,
}

/// Commands Tether reads are short; a longer body is dropped rather than buffered.
pub const BODY_LIMIT: usize = 4096;
/// OSC 52 carries base64: room for `CLIPBOARD_LIMIT` bytes of decoded text.
pub const CLIPBOARD_BODY_LIMIT: usize = 101_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OscEvent {
    Osc { code: String, body: Vec<u8> },
    Reset,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum State {
    #[default]
    Ground,
    Escape,
    Code,
    Body,
    BodyEscape,
    Str,
    StrEscape,
}

/// Finds OSC sequences and RIS across read boundaries. DCS, APC, PM and SOS payloads
/// (kitty graphics among them) are skipped whole, so an `ESC ]` inside one is never a command.
#[derive(Debug, Default)]
pub struct OscScanner {
    state: State,
    code: String,
    body: Vec<u8>,
    overflowed: bool,
}

impl OscScanner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<OscEvent> {
        bytes.iter().filter_map(|&b| self.step(b)).collect()
    }

    fn limit(&self) -> usize {
        if self.code == "52" {
            CLIPBOARD_BODY_LIMIT
        } else {
            BODY_LIMIT
        }
    }

    fn step(&mut self, b: u8) -> Option<OscEvent> {
        match self.state {
            State::Ground => {
                if b == 0x1b {
                    self.state = State::Escape;
                }
            }
            State::Escape => match b {
                b']' => {
                    self.state = State::Code;
                    self.code.clear();
                    self.body.clear();
                    self.overflowed = false;
                }
                b'P' | b'_' | b'^' | b'X' => self.state = State::Str,
                b'c' => {
                    self.state = State::Ground;
                    return Some(OscEvent::Reset);
                }
                0x1b => {}
                _ => self.state = State::Ground,
            },
            State::Code => match b {
                b'0'..=b'9' if self.code.len() < 5 => self.code.push(b as char),
                b';' => self.state = State::Body,
                0x07 => return self.finish(),
                0x1b => self.state = State::BodyEscape,
                _ => self.state = State::Ground,
            },
            State::Body => match b {
                0x07 => return self.finish(),
                0x1b => self.state = State::BodyEscape,
                _ if self.body.len() < self.limit() => self.body.push(b),
                _ => self.overflowed = true,
            },
            State::BodyEscape => {
                if b == b'\\' {
                    return self.finish();
                }
                self.state = State::Escape;
                return self.step(b);
            }
            State::Str => {
                if b == 0x1b {
                    self.state = State::StrEscape;
                }
            }
            State::StrEscape => self.state = if b == b'\\' { State::Ground } else { State::Str },
        }
        None
    }

    fn finish(&mut self) -> Option<OscEvent> {
        self.state = State::Ground;
        if self.overflowed || self.code.is_empty() {
            return None;
        }
        Some(OscEvent::Osc {
            code: std::mem::take(&mut self.code),
            body: std::mem::take(&mut self.body),
        })
    }
}

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

pub const TITLE_LIMIT: usize = 128;
pub const PATH_LIMIT: usize = 4096;
pub const CLIPBOARD_LIMIT: usize = 75_000;
pub const NOTIFY_LIMIT: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    pub title: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReportEvent {
    Notify(Notification),
    Clipboard(String),
    ProgressChanged,
    CwdChanged,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TabReports {
    pub title: Option<String>,
    /// A hint: the host part of the OSC 7 URL is not checked.
    pub cwd: Option<String>,
    pub progress: Option<Progress>,
}

impl TabReports {
    pub fn apply(&mut self, ev: &OscEvent) -> Option<ReportEvent> {
        let (code, body) = match ev {
            OscEvent::Reset => return self.set_progress(None),
            OscEvent::Osc { code, body } => (code.as_str(), body.as_slice()),
        };
        match code {
            "0" | "2" => {
                self.title = sanitize(body, TITLE_LIMIT);
                None
            }
            "7" => {
                let path = path_from_url(body)?;
                if self.cwd.as_deref() == Some(path.as_str()) {
                    return None;
                }
                self.cwd = Some(path);
                Some(ReportEvent::CwdChanged)
            }
            "9" => self.osc9(body),
            "777" => notify_777(body).map(ReportEvent::Notify),
            "52" => clipboard_text(body).map(ReportEvent::Clipboard),
            "133" if body.first() == Some(&b'A') => self.set_progress(None),
            _ => None,
        }
    }

    fn set_progress(&mut self, p: Option<Progress>) -> Option<ReportEvent> {
        if self.progress == p {
            return None;
        }
        self.progress = p;
        Some(ReportEvent::ProgressChanged)
    }

    fn osc9(&mut self, body: &[u8]) -> Option<ReportEvent> {
        let text = String::from_utf8_lossy(body);
        let fields: Vec<&str> = text.split(';').collect();
        if fields[0] != "4" {
            return sanitize(body, NOTIFY_LIMIT)
                .map(|body| ReportEvent::Notify(Notification { title: None, body }));
        }
        let raw: i64 = fields.get(1)?.parse().ok()?;
        let percent = fields
            .get(2)
            .and_then(|f| f.parse::<i64>().ok())
            .map(|p| p.clamp(0, 100) as u8);
        let state = match raw {
            0 => return self.set_progress(None),
            1 => ProgressState::Normal,
            2 => ProgressState::Error,
            3 => ProgressState::Indeterminate,
            4 => ProgressState::Paused,
            _ => return None,
        };
        let percent = percent.or(self.progress.map(|p| p.percent)).unwrap_or(0);
        self.set_progress(Some(Progress { state, percent }))
    }
}

/// Unicode format characters (Cf) that can hide or reorder text: bidi controls, zero-width marks.
fn is_format(c: char) -> bool {
    matches!(
        c as u32,
        0xAD
            | 0x600..=0x605
            | 0x61C
            | 0x6DD
            | 0x70F
            | 0x180E
            | 0x200B..=0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x206F
            | 0xFEFF
            | 0xFFF9..=0xFFFB
    )
}

/// Program output is untrusted: control and format characters go, whitespace is trimmed.
pub fn sanitize(bytes: &[u8], limit: usize) -> Option<String> {
    let cleaned: String = String::from_utf8_lossy(bytes)
        .chars()
        .filter(|&c| !c.is_control() && !is_format(c))
        .collect();
    let trimmed = cleaned.trim();
    (!trimmed.is_empty()).then(|| trimmed.chars().take(limit).collect())
}

fn notify_777(body: &[u8]) -> Option<Notification> {
    let text = String::from_utf8_lossy(body);
    let mut parts = text.splitn(3, ';');
    if parts.next()? != "notify" {
        return None;
    }
    let title = parts.next().and_then(|t| sanitize(t.as_bytes(), TITLE_LIMIT));
    let body = parts.next().and_then(|b| sanitize(b.as_bytes(), NOTIFY_LIMIT));
    match (title, body) {
        (title, Some(body)) => Some(Notification { title, body }),
        (Some(title), None) => Some(Notification {
            title: None,
            body: title,
        }),
        (None, None) => None,
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn path_from_url(body: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(body);
    let rest = text.strip_prefix("file://")?;
    let path = percent_decode(&rest[rest.find('/')?..])?;
    (path.chars().count() <= PATH_LIMIT && !path.chars().any(char::is_control)).then_some(path)
}

fn clipboard_text(body: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(body);
    let (_, payload) = text.split_once(';')?;
    let mut payload: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
    if payload.is_empty() || payload == "?" {
        return None;
    }
    while payload.len() % 4 != 0 {
        payload.push('=');
    }
    let data = STANDARD.decode(payload).ok()?;
    if data.len() > CLIPBOARD_LIMIT {
        return None;
    }
    String::from_utf8(data).ok().filter(|s| !s.is_empty())
}

#[cfg(test)]
mod scanner_tests {
    use super::*;

    fn osc(code: &str, body: &str) -> OscEvent {
        OscEvent::Osc {
            code: code.into(),
            body: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn bel_and_st_both_terminate() {
        let mut sc = OscScanner::new();
        let ev = sc.feed(b"hi\x1b]0;title\x07mid\x1b]9;done\x1b\\end");
        assert_eq!(ev, vec![osc("0", "title"), osc("9", "done")]);
    }

    #[test]
    fn every_split_point_gives_the_same_events() {
        let stream: &[u8] = b"a\x1b]777;notify;T;B\x1b\\b\x1b]9;4;1;50\x07\x1bc\x1b]133;A\x07";
        let whole = OscScanner::new().feed(stream);
        assert_eq!(whole.len(), 4);
        for cut in 0..=stream.len() {
            let mut sc = OscScanner::new();
            let mut ev = sc.feed(&stream[..cut]);
            ev.extend(sc.feed(&stream[cut..]));
            assert_eq!(ev, whole, "split at {cut}");
        }
    }

    #[test]
    fn ris_is_a_reset() {
        assert_eq!(OscScanner::new().feed(b"x\x1bcy"), vec![OscEvent::Reset]);
    }

    #[test]
    fn dcs_apc_pm_sos_payloads_are_skipped_whole() {
        for intro in *b"P_^X" {
            let mut bytes = vec![0x1b, intro];
            bytes.extend_from_slice(b"Gf=100;\x1b]9;fake\x07\x1b\\");
            bytes.extend_from_slice(b"\x1b]2;real\x07");
            assert_eq!(
                OscScanner::new().feed(&bytes),
                vec![osc("2", "real")],
                "intro {intro}"
            );
        }
    }

    #[test]
    fn an_escape_inside_an_osc_cuts_it_and_starts_the_next_sequence() {
        assert_eq!(
            OscScanner::new().feed(b"\x1b]2;cut\x1b]2;next\x07"),
            vec![osc("2", "next")]
        );
    }

    #[test]
    fn overlong_bodies_and_codes_are_dropped() {
        let mut long = b"\x1b]2;".to_vec();
        long.extend(std::iter::repeat_n(b'x', BODY_LIMIT + 1));
        long.push(0x07);
        assert!(OscScanner::new().feed(&long).is_empty());
        assert!(OscScanner::new().feed(b"\x1b]123456;x\x07").is_empty());
        assert!(OscScanner::new().feed(b"\x1b];x\x07").is_empty());

        let mut clip = b"\x1b]52;c;".to_vec();
        clip.extend(std::iter::repeat_n(b'A', 100_000));
        clip.push(0x07);
        assert_eq!(OscScanner::new().feed(&clip).len(), 1);
    }

    #[test]
    fn code_without_body() {
        assert_eq!(
            OscScanner::new().feed(b"\x1b]104\x07"),
            vec![osc("104", "")]
        );
    }
}

#[cfg(test)]
mod report_tests {
    use super::*;

    fn apply_all(r: &mut TabReports, bytes: &[u8]) -> Vec<ReportEvent> {
        OscScanner::new()
            .feed(bytes)
            .iter()
            .filter_map(|e| r.apply(e))
            .collect()
    }

    fn note(title: Option<&str>, body: &str) -> ReportEvent {
        ReportEvent::Notify(Notification {
            title: title.map(Into::into),
            body: body.into(),
        })
    }

    #[test]
    fn titles_lose_control_and_bidi_characters_and_are_capped() {
        let mut r = TabReports::default();
        apply_all(&mut r, "\x1b]2; ok\u{202e}\u{200b}\u{1}\x07".as_bytes());
        assert_eq!(r.title.as_deref(), Some("ok"));
        apply_all(&mut r, format!("\x1b]0;{}\x07", "x".repeat(300)).as_bytes());
        assert_eq!(r.title.as_ref().map(|t| t.chars().count()), Some(TITLE_LIMIT));
        apply_all(&mut r, b"\x1b]2;   \x07");
        assert_eq!(r.title, None);
    }

    #[test]
    fn utf8_title_split_mid_character() {
        let bytes = "\x1b]2;café ✓\x07".as_bytes();
        let cut = bytes.iter().position(|&b| b == 0xC3).unwrap() + 1;
        let mut sc = OscScanner::new();
        let mut r = TabReports::default();
        for e in sc
            .feed(&bytes[..cut])
            .iter()
            .chain(sc.feed(&bytes[cut..]).iter())
        {
            r.apply(e);
        }
        assert_eq!(r.title.as_deref(), Some("café ✓"));
    }

    #[test]
    fn osc7_sets_the_cwd_from_a_file_url() {
        let mut r = TabReports::default();
        assert_eq!(
            apply_all(&mut r, b"\x1b]7;file://box/home/u/my%20dir\x07"),
            vec![ReportEvent::CwdChanged]
        );
        assert_eq!(r.cwd.as_deref(), Some("/home/u/my dir"));
        assert!(apply_all(&mut r, b"\x1b]7;file://box/home/u/my%20dir\x07").is_empty());
        apply_all(&mut r, b"\x1b]7;http://x/y\x07");
        apply_all(&mut r, b"\x1b]7;file://box/a%0Ab\x07");
        assert_eq!(r.cwd.as_deref(), Some("/home/u/my dir"));
    }

    #[test]
    fn osc9_and_777_are_notifications() {
        let mut r = TabReports::default();
        assert_eq!(
            apply_all(&mut r, b"\x1b]9;Build done\x07"),
            vec![note(None, "Build done")]
        );
        assert_eq!(
            apply_all(&mut r, b"\x1b]777;notify;Claude;Needs; you\x07"),
            vec![note(Some("Claude"), "Needs; you")]
        );
        assert_eq!(
            apply_all(&mut r, b"\x1b]777;notify;Only title;\x07"),
            vec![note(None, "Only title")]
        );
        assert!(apply_all(&mut r, b"\x1b]777;notify;;\x07").is_empty());
        assert!(apply_all(&mut r, b"\x1b]777;other;a;b\x07").is_empty());
        assert!(apply_all(&mut r, b"\x1b]9;\x07").is_empty());
    }

    #[test]
    fn osc9_4_is_progress_and_never_a_toast() {
        let mut r = TabReports::default();
        assert_eq!(
            apply_all(&mut r, b"\x1b]9;4;1;40\x07"),
            vec![ReportEvent::ProgressChanged]
        );
        assert_eq!(
            r.progress,
            Some(Progress {
                state: ProgressState::Normal,
                percent: 40
            })
        );
        apply_all(&mut r, b"\x1b]9;4;2\x07");
        assert_eq!(
            r.progress,
            Some(Progress {
                state: ProgressState::Error,
                percent: 40
            })
        );
        apply_all(&mut r, b"\x1b]9;4;3\x07");
        assert_eq!(r.progress.unwrap().state, ProgressState::Indeterminate);
        apply_all(&mut r, b"\x1b]9;4;4;250\x07");
        assert_eq!(
            r.progress,
            Some(Progress {
                state: ProgressState::Paused,
                percent: 100
            })
        );
        apply_all(&mut r, b"\x1b]9;4;0\x07");
        assert_eq!(r.progress, None);
        for body in [&b"\x1b]9;4;9;5\x07"[..], b"\x1b]9;4;x\x07", b"\x1b]9;4\x07"] {
            assert!(apply_all(&mut r, body).is_empty());
        }
    }

    #[test]
    fn prompt_mark_and_reset_clear_progress() {
        let mut r = TabReports::default();
        apply_all(&mut r, b"\x1b]9;4;1;10\x07");
        assert_eq!(
            apply_all(&mut r, b"\x1b]133;A\x07"),
            vec![ReportEvent::ProgressChanged]
        );
        assert_eq!(r.progress, None);
        assert!(apply_all(&mut r, b"\x1b]133;B\x07").is_empty());
        apply_all(&mut r, b"\x1b]9;4;3\x07");
        assert_eq!(
            apply_all(&mut r, b"\x1bc"),
            vec![ReportEvent::ProgressChanged]
        );
    }

    #[test]
    fn osc52_copies_text_but_never_answers_a_query() {
        let mut r = TabReports::default();
        assert_eq!(
            apply_all(&mut r, b"\x1b]52;c;aGVsbG8\x07"),
            vec![ReportEvent::Clipboard("hello".into())]
        );
        assert!(apply_all(&mut r, b"\x1b]52;c;?\x07").is_empty());
        assert!(apply_all(&mut r, b"\x1b]52;c;\x07").is_empty());
        assert!(apply_all(&mut r, b"\x1b]52;c;!!!\x07").is_empty());
    }
}
