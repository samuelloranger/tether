//! Inline-image protocols, parsed and budgeted with no pixels and no grid: the kitty graphics
//! APC (`ESC _ G … ST`) and the iTerm2 `OSC 1337 ; File=…`. `Splitter` lifts those sequences out
//! of the PTY byte stream so the terminal can place them at the cursor; everything else passes
//! through untouched and in order.

use std::collections::VecDeque;

/// Largest base64 body (all chunks together) accepted for one image.
pub const MAX_PAYLOAD: usize = 48 << 20;
pub const MAX_DIMENSION: u32 = 8192;
pub const MAX_PIXELS: u64 = 16 << 20;
/// A placement is anchored by one tag per row; taller ones are scaled down to fit.
pub const MAX_IMAGE_ROWS: u32 = 64;

const ITERM_PREFIX: &[u8] = b"1337;File=";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Bytes(Vec<u8>),
    /// Body of a kitty graphics APC, after `ESC _ G`.
    Kitty(Vec<u8>),
    /// Body of an iTerm2 `File=` OSC, after `File=`.
    Iterm(Vec<u8>),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum State {
    #[default]
    Ground,
    Esc,
    ApcHead,
    OscHead(usize),
    Kitty,
    KittyEsc,
    Iterm,
    ItermEsc,
    DiscardApc,
    DiscardApcEsc,
    DiscardOsc,
    DiscardOscEsc,
    PassStr,
    PassStrEsc,
    PassOsc,
}

#[derive(Debug, Default)]
pub struct Splitter {
    state: State,
    held: Vec<u8>,
    body: Vec<u8>,
    out: Vec<Segment>,
    plain: Vec<u8>,
}

impl Splitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Bytes that might start an image sequence are held back until the next read decides, so a
    /// sequence split across reads is never half-fed to the grid.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Segment> {
        let mut rest = bytes;
        while !rest.is_empty() {
            if self.state == State::Ground {
                let plain = rest.iter().position(|&b| b == 0x1b).unwrap_or(rest.len());
                self.plain.extend_from_slice(&rest[..plain]);
                rest = &rest[plain..];
                if rest.is_empty() {
                    break;
                }
            }
            self.step(rest[0]);
            rest = &rest[1..];
        }
        self.flush_plain();
        std::mem::take(&mut self.out)
    }

    fn flush_plain(&mut self) {
        if !self.plain.is_empty() {
            self.out
                .push(Segment::Bytes(std::mem::take(&mut self.plain)));
        }
    }

    fn release(&mut self) {
        self.plain.append(&mut self.held);
    }

    fn step(&mut self, b: u8) {
        match self.state {
            State::Ground => {
                if b == 0x1b {
                    self.held.push(b);
                    self.state = State::Esc;
                } else {
                    self.plain.push(b);
                }
            }
            State::Esc => match b {
                b'_' => {
                    self.held.push(b);
                    self.state = State::ApcHead;
                }
                b']' => {
                    self.held.push(b);
                    self.state = State::OscHead(0);
                }
                b'P' | b'^' | b'X' => {
                    self.release();
                    self.plain.push(b);
                    self.state = State::PassStr;
                }
                0x1b => {
                    self.release();
                    self.held.push(b);
                }
                _ => {
                    self.release();
                    self.plain.push(b);
                    self.state = State::Ground;
                }
            },
            State::ApcHead => {
                if b == b'G' {
                    self.held.clear();
                    self.body.clear();
                    self.state = State::Kitty;
                } else {
                    self.release();
                    self.state = State::PassStr;
                    self.step(b);
                }
            }
            State::OscHead(n) => {
                if b == ITERM_PREFIX[n] {
                    self.held.push(b);
                    if n + 1 == ITERM_PREFIX.len() {
                        self.held.clear();
                        self.body.clear();
                        self.state = State::Iterm;
                    } else {
                        self.state = State::OscHead(n + 1);
                    }
                } else {
                    self.release();
                    self.state = State::PassOsc;
                    self.step(b);
                }
            }
            State::Kitty => match b {
                0x1b => self.state = State::KittyEsc,
                _ if self.body.len() >= MAX_PAYLOAD => {
                    self.body = Vec::new();
                    self.state = State::DiscardApc;
                }
                _ => self.body.push(b),
            },
            State::KittyEsc => {
                if b == b'\\' {
                    self.flush_plain();
                    self.out
                        .push(Segment::Kitty(std::mem::take(&mut self.body)));
                    self.state = State::Ground;
                } else {
                    self.body = Vec::new();
                    self.abort_to_escape(b);
                }
            }
            State::Iterm => match b {
                0x07 => {
                    self.flush_plain();
                    self.out
                        .push(Segment::Iterm(std::mem::take(&mut self.body)));
                    self.state = State::Ground;
                }
                0x1b => self.state = State::ItermEsc,
                _ if self.body.len() >= MAX_PAYLOAD => {
                    self.body = Vec::new();
                    self.state = State::DiscardOsc;
                }
                _ => self.body.push(b),
            },
            State::ItermEsc => {
                if b == b'\\' {
                    self.flush_plain();
                    self.out
                        .push(Segment::Iterm(std::mem::take(&mut self.body)));
                    self.state = State::Ground;
                } else {
                    self.body = Vec::new();
                    self.abort_to_escape(b);
                }
            }
            State::DiscardApc => {
                if b == 0x1b {
                    self.state = State::DiscardApcEsc;
                }
            }
            State::DiscardApcEsc => {
                self.state = if b == b'\\' {
                    State::Ground
                } else {
                    State::DiscardApc
                }
            }
            State::DiscardOsc => match b {
                0x07 => self.state = State::Ground,
                0x1b => self.state = State::DiscardOscEsc,
                _ => {}
            },
            State::DiscardOscEsc => {
                self.state = if b == b'\\' {
                    State::Ground
                } else {
                    State::DiscardOsc
                }
            }
            State::PassStr => {
                self.plain.push(b);
                if b == 0x1b {
                    self.state = State::PassStrEsc;
                }
            }
            State::PassStrEsc => {
                self.plain.push(b);
                self.state = match b {
                    b'\\' => State::Ground,
                    0x1b => State::PassStrEsc,
                    _ => State::PassStr,
                };
            }
            State::PassOsc => match b {
                0x07 => {
                    self.plain.push(b);
                    self.state = State::Ground;
                }
                0x1b => {
                    self.held.push(b);
                    self.state = State::Esc;
                }
                _ => self.plain.push(b),
            },
        }
    }

    /// An ESC inside an image body that is not `ESC \` ends the sequence unfinished: the body is
    /// dropped and the ESC starts whatever follows.
    fn abort_to_escape(&mut self, b: u8) {
        self.held.clear();
        self.held.push(0x1b);
        self.state = State::Esc;
        self.step(b);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Transmit,
    TransmitDisplay,
    Display,
    Delete,
    Query,
    Unsupported(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Medium {
    Direct,
    Other(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Rgb,
    Rgba,
    Png,
    Other(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteTarget {
    All,
    Id,
    Number,
    Cursor,
    Cell,
    Column,
    Row,
    ZIndex,
    Unsupported(u8),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KittyCommand {
    pub action: Action,
    pub format: Format,
    pub medium: Medium,
    pub zlib: bool,
    pub width: u32,
    pub height: u32,
    pub id: u32,
    pub number: u32,
    pub placement: u32,
    pub more: bool,
    pub cols: u32,
    pub rows: u32,
    pub src: (u32, u32, u32, u32),
    pub offset: (u32, u32),
    pub z: i32,
    pub no_move: bool,
    pub virtual_placement: bool,
    pub quiet: u8,
    pub delete: DeleteTarget,
    pub free: bool,
    /// `x`/`y` of a delete, which share their letters with the source rectangle.
    pub delete_x: i32,
    pub delete_y: i32,
    /// Base64, still encoded.
    pub payload: Vec<u8>,
}

impl Default for KittyCommand {
    fn default() -> Self {
        KittyCommand {
            action: Action::Transmit,
            format: Format::Rgba,
            medium: Medium::Direct,
            zlib: false,
            width: 0,
            height: 0,
            id: 0,
            number: 0,
            placement: 0,
            more: false,
            cols: 0,
            rows: 0,
            src: (0, 0, 0, 0),
            offset: (0, 0),
            z: 0,
            no_move: false,
            virtual_placement: false,
            quiet: 0,
            delete: DeleteTarget::All,
            free: false,
            delete_x: 0,
            delete_y: 0,
            payload: Vec::new(),
        }
    }
}

impl KittyCommand {
    pub fn has_reply_id(&self) -> bool {
        self.id != 0 || self.number != 0
    }

    /// `None` when a key has a malformed value; the command is dropped.
    pub fn parse(body: &[u8]) -> Option<KittyCommand> {
        let (control, payload) = match body.iter().position(|&b| b == b';') {
            Some(i) => (&body[..i], &body[i + 1..]),
            None => (body, &body[..0]),
        };
        let mut cmd = KittyCommand::default();
        let mut format = 32u32;
        let mut medium = b'd';
        let mut delete_letter = b'a';
        let mut action = b't';
        for pair in control.split(|&b| b == b',') {
            if pair.is_empty() {
                continue;
            }
            let (key, value) = match pair {
                [k, b'=', rest @ ..] => (*k, rest),
                _ => return None,
            };
            let num = || -> Option<i64> { std::str::from_utf8(value).ok()?.parse().ok() };
            let unsigned = || -> Option<u32> { u32::try_from(num()?).ok() };
            let letter = || -> Option<u8> { (value.len() == 1).then(|| value[0]) };
            match key {
                b'a' => action = letter()?,
                b'f' => format = unsigned()?,
                b't' => medium = letter()?,
                b'o' => cmd.zlib = letter()? == b'z',
                b's' => cmd.width = unsigned()?,
                b'v' => cmd.height = unsigned()?,
                b'i' => cmd.id = unsigned()?,
                b'I' => cmd.number = unsigned()?,
                b'p' => cmd.placement = unsigned()?,
                b'm' => cmd.more = unsigned()? == 1,
                b'c' => cmd.cols = unsigned()?,
                b'r' => cmd.rows = unsigned()?,
                b'x' => {
                    cmd.src.0 = unsigned().unwrap_or(0);
                    cmd.delete_x = num()? as i32;
                }
                b'y' => {
                    cmd.src.1 = unsigned().unwrap_or(0);
                    cmd.delete_y = num()? as i32;
                }
                b'w' => cmd.src.2 = unsigned()?,
                b'h' => cmd.src.3 = unsigned()?,
                b'X' => cmd.offset.0 = unsigned()?,
                b'Y' => cmd.offset.1 = unsigned()?,
                b'z' => cmd.z = i32::try_from(num()?).ok()?,
                b'C' => cmd.no_move = unsigned()? == 1,
                b'U' => cmd.virtual_placement = unsigned()? == 1,
                b'q' => cmd.quiet = unsigned()?.min(2) as u8,
                b'd' => delete_letter = letter()?,
                _ => {}
            }
        }
        cmd.action = match action {
            b't' => Action::Transmit,
            b'T' => Action::TransmitDisplay,
            b'p' => Action::Display,
            b'd' => Action::Delete,
            b'q' => Action::Query,
            other => Action::Unsupported(other),
        };
        cmd.format = match format {
            24 => Format::Rgb,
            32 => Format::Rgba,
            100 => Format::Png,
            other => Format::Other(other),
        };
        cmd.medium = match medium {
            b'd' => Medium::Direct,
            other => Medium::Other(other),
        };
        cmd.free = delete_letter.is_ascii_uppercase();
        cmd.delete = match delete_letter.to_ascii_lowercase() {
            b'a' => DeleteTarget::All,
            b'i' => DeleteTarget::Id,
            b'n' => DeleteTarget::Number,
            b'c' => DeleteTarget::Cursor,
            b'p' => DeleteTarget::Cell,
            b'x' => DeleteTarget::Column,
            b'y' => DeleteTarget::Row,
            b'z' => DeleteTarget::ZIndex,
            other => DeleteTarget::Unsupported(other),
        };
        cmd.payload = payload.to_vec();
        Some(cmd)
    }
}

/// Joins `m=1` chunks. Later chunks only carry `m`, `q` and data; whatever else they say is
/// ignored, as kitty does.
#[derive(Debug, Default)]
pub struct Assembler {
    pending: Option<KittyCommand>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Assembled {
    Wait,
    Ready(KittyCommand),
    TooLarge(KittyCommand),
}

impl Assembler {
    pub fn push(&mut self, chunk: KittyCommand) -> Assembled {
        let Some(mut first) = self.pending.take() else {
            if chunk.more {
                self.pending = Some(chunk);
                return Assembled::Wait;
            }
            return Assembled::Ready(chunk);
        };
        if first.payload.len() + chunk.payload.len() > MAX_PAYLOAD {
            first.payload = Vec::new();
            return Assembled::TooLarge(first);
        }
        first.payload.extend_from_slice(&chunk.payload);
        if chunk.more {
            self.pending = Some(first);
            Assembled::Wait
        } else {
            Assembled::Ready(first)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KittyError {
    Invalid,
    NoEntry,
    Unsupported,
    TooLarge,
    Decode,
}

impl KittyError {
    pub fn text(self, detail: &str) -> String {
        let code = match self {
            KittyError::Invalid | KittyError::Decode => "EINVAL",
            KittyError::NoEntry => "ENOENT",
            KittyError::Unsupported => "ENOTSUP",
            KittyError::TooLarge => "EFBIG",
        };
        format!("{code}:{detail}")
    }
}

/// The `ESC _ G … ESC \` answer. Nothing is sent when the command named no image, and `q`
/// silences OK (1) or everything (2).
pub fn kitty_reply(cmd: &KittyCommand, result: Result<(), String>) -> Option<Vec<u8>> {
    if !cmd.has_reply_id() {
        return None;
    }
    let message = match result {
        Ok(()) if cmd.quiet >= 1 => return None,
        Ok(()) => "OK".to_string(),
        Err(_) if cmd.quiet >= 2 => return None,
        Err(text) => text,
    };
    let mut keys = String::new();
    if cmd.id != 0 {
        keys.push_str(&format!("i={}", cmd.id));
    }
    if cmd.number != 0 {
        if !keys.is_empty() {
            keys.push(',');
        }
        keys.push_str(&format!("I={}", cmd.number));
    }
    if cmd.placement != 0 {
        keys.push_str(&format!(",p={}", cmd.placement));
    }
    Some(format!("\x1b_G{keys};{message}\x1b\\").into_bytes())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Dim {
    #[default]
    Auto,
    Cells(u32),
    Pixels(u32),
    Percent(u32),
}

impl Dim {
    fn parse(value: &str) -> Dim {
        if value.eq_ignore_ascii_case("auto") || value.is_empty() {
            return Dim::Auto;
        }
        let (digits, make): (&str, fn(u32) -> Dim) = if let Some(d) = value.strip_suffix("px") {
            (d, Dim::Pixels)
        } else if let Some(d) = value.strip_suffix('%') {
            (d, Dim::Percent)
        } else {
            (value, Dim::Cells)
        };
        match digits.parse::<u32>() {
            Ok(n) if n > 0 => make(n),
            _ => Dim::Auto,
        }
    }

    pub fn to_cells(self, cell_px: u32, total_cells: u32) -> Option<u32> {
        match self {
            Dim::Auto => None,
            Dim::Cells(n) => Some(n),
            Dim::Pixels(px) => Some(px.div_ceil(cell_px.max(1))),
            Dim::Percent(p) => Some((total_cells as u64 * p as u64 / 100).max(1) as u32),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItermFile {
    pub inline: bool,
    pub width: Dim,
    pub height: Dim,
    pub preserve_aspect: bool,
    /// Base64, still encoded.
    pub payload: Vec<u8>,
}

impl ItermFile {
    pub fn parse(body: &[u8]) -> Option<ItermFile> {
        let colon = body.iter().position(|&b| b == b':')?;
        let args = std::str::from_utf8(&body[..colon]).ok()?;
        let mut file = ItermFile {
            inline: false,
            width: Dim::Auto,
            height: Dim::Auto,
            preserve_aspect: true,
            payload: body[colon + 1..].to_vec(),
        };
        for arg in args.split(';') {
            let Some((key, value)) = arg.split_once('=') else {
                continue;
            };
            match key.to_ascii_lowercase().as_str() {
                "inline" => file.inline = value == "1",
                "width" => file.width = Dim::parse(value),
                "height" => file.height = Dim::parse(value),
                "preserveaspectratio" => file.preserve_aspect = value != "0",
                _ => {}
            }
        }
        Some(file)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FitRequest {
    pub image_w: u32,
    pub image_h: u32,
    pub cell_w: u32,
    pub cell_h: u32,
    pub want_cols: Option<u32>,
    pub want_rows: Option<u32>,
    pub max_cols: u32,
    pub max_rows: u32,
    /// Both sizes given and the image fills the box, aspect ratio be damned.
    pub stretch: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fit {
    pub cols: u32,
    pub rows: u32,
    /// Share of the cell box the picture covers, from the top-left.
    pub fill_w: f32,
    pub fill_h: f32,
}

/// The cell box an image occupies and how much of it the picture covers. Anything that would
/// not fit the line or `MAX_IMAGE_ROWS` is scaled down, never clipped, so a placement is always
/// whole on the grid it was made for.
pub fn fit(req: FitRequest) -> Fit {
    let cw = req.cell_w.max(1) as f32;
    let ch = req.cell_h.max(1) as f32;
    let (iw, ih) = (req.image_w.max(1) as f32, req.image_h.max(1) as f32);
    let max_cols = req.max_cols.max(1);
    let max_rows = req.max_rows.clamp(1, MAX_IMAGE_ROWS);

    if req.stretch
        && let (Some(c), Some(r)) = (req.want_cols, req.want_rows)
    {
        return Fit {
            cols: c.clamp(1, max_cols),
            rows: r.clamp(1, max_rows),
            fill_w: 1.0,
            fill_h: 1.0,
        };
    }

    let mut scale = match (req.want_cols, req.want_rows) {
        (Some(c), Some(r)) => (c as f32 * cw / iw).min(r as f32 * ch / ih),
        (Some(c), None) => c as f32 * cw / iw,
        (None, Some(r)) => r as f32 * ch / ih,
        (None, None) => 1.0,
    };
    scale = scale
        .min(max_cols as f32 * cw / iw)
        .min(max_rows as f32 * ch / ih);
    let (dw, dh) = (iw * scale, ih * scale);
    let cols = ((dw / cw).ceil() as u32).clamp(1, max_cols);
    let rows = ((dh / ch).ceil() as u32).clamp(1, max_rows);
    Fit {
        cols,
        rows,
        fill_w: (dw / (cols as f32 * cw)).min(1.0),
        fill_h: (dh / (rows as f32 * ch)).min(1.0),
    }
}

/// Oldest-first eviction over a byte and count cap.
#[derive(Debug)]
pub struct Budget {
    max_bytes: usize,
    max_count: usize,
    total: usize,
    order: VecDeque<(u64, usize)>,
}

impl Budget {
    pub fn new(max_bytes: usize, max_count: usize) -> Self {
        Budget {
            max_bytes,
            max_count,
            total: 0,
            order: VecDeque::new(),
        }
    }

    pub fn total(&self) -> usize {
        self.total
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    /// `None` when the item alone exceeds the byte cap. Otherwise the ids to drop, oldest first.
    pub fn admit(&mut self, id: u64, bytes: usize) -> Option<Vec<u64>> {
        if bytes > self.max_bytes {
            return None;
        }
        let mut evicted = Vec::new();
        while !self.order.is_empty()
            && (self.total + bytes > self.max_bytes || self.order.len() + 1 > self.max_count)
        {
            let (old, size) = self.order.pop_front().unwrap();
            self.total -= size;
            evicted.push(old);
        }
        self.order.push_back((id, bytes));
        self.total += bytes;
        Some(evicted)
    }

    pub fn remove(&mut self, id: u64) {
        if let Some(i) = self.order.iter().position(|&(o, _)| o == id) {
            self.total -= self.order[i].1;
            self.order.remove(i);
        }
    }

    pub fn over_half(&self) -> bool {
        self.total * 2 > self.max_bytes || self.order.len() * 2 > self.max_count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split_all(chunks: &[&[u8]]) -> Vec<Segment> {
        let mut s = Splitter::new();
        let mut out: Vec<Segment> = Vec::new();
        for c in chunks {
            for seg in s.feed(c) {
                match (out.last_mut(), seg) {
                    (Some(Segment::Bytes(a)), Segment::Bytes(b)) => a.extend(b),
                    (_, seg) => out.push(seg),
                }
            }
        }
        out
    }

    fn bytes(s: &str) -> Segment {
        Segment::Bytes(s.as_bytes().to_vec())
    }

    #[test]
    fn plain_text_and_other_escapes_pass_through() {
        let input = b"ab\x1b[31mc\x1b]0;title\x07d\x1b]8;;http://x\x1b\\e";
        assert_eq!(
            split_all(&[input]),
            [Segment::Bytes(input.to_vec())],
            "nothing to lift"
        );
    }

    #[test]
    fn a_kitty_apc_is_lifted_with_the_text_around_it_in_order() {
        assert_eq!(
            split_all(&[b"a\x1b_Ga=T,f=100;AAAA\x1b\\b"]),
            [
                bytes("a"),
                Segment::Kitty(b"a=T,f=100;AAAA".to_vec()),
                bytes("b")
            ]
        );
    }

    #[test]
    fn an_iterm_file_ends_on_bel_or_st() {
        assert_eq!(
            split_all(&[b"\x1b]1337;File=inline=1:QUJD\x07x\x1b]1337;File=inline=1:REVG\x1b\\"]),
            [
                Segment::Iterm(b"inline=1:QUJD".to_vec()),
                bytes("x"),
                Segment::Iterm(b"inline=1:REVG".to_vec())
            ]
        );
    }

    #[test]
    fn every_split_point_gives_the_same_segments() {
        let input = b"a\x1b_Gi=1;AA\x1b\\b\x1b]1337;File=inline=1:AA\x07c\x1b[1md\x1b]133;A\x07";
        let whole = split_all(&[input]);
        for cut in 0..=input.len() {
            assert_eq!(split_all(&[&input[..cut], &input[cut..]]), whole, "{cut}");
        }
        for byte in 0..input.len() {
            let singles: Vec<&[u8]> = input.chunks(1).collect();
            assert_eq!(split_all(&singles), whole, "{byte}");
        }
    }

    #[test]
    fn non_graphics_strings_pass_through_even_with_an_image_prefix_inside() {
        let input = b"\x1b_Xnope\x1b_Ga=T\x1b\\after\x1bPq\x1b_Gx\x1b\\z";
        assert_eq!(split_all(&[input]), [Segment::Bytes(input.to_vec())]);
    }

    #[test]
    fn other_osc_1337_commands_pass_through() {
        let input = b"\x1b]1337;SetMark\x07\x1b]1337;File\x07";
        assert_eq!(split_all(&[input]), [Segment::Bytes(input.to_vec())]);
    }

    #[test]
    fn an_escape_inside_an_image_body_aborts_it() {
        assert_eq!(
            split_all(&[b"\x1b_Gabc\x1b[1mtext"]),
            [bytes("\x1b[1mtext")]
        );
        assert_eq!(
            split_all(&[b"\x1b]1337;File=inline=1:ab\x1b[1mtext"]),
            [bytes("\x1b[1mtext")]
        );
    }

    #[test]
    fn a_lone_trailing_escape_is_held_for_the_next_read() {
        let mut s = Splitter::new();
        assert!(s.feed(b"x\x1b").iter().all(|seg| match seg {
            Segment::Bytes(b) => b == b"x",
            _ => false,
        }));
        assert_eq!(s.feed(b"[0m"), [bytes("\x1b[0m")]);
    }

    #[test]
    fn an_oversized_body_is_swallowed_to_its_terminator() {
        let mut s = Splitter::new();
        s.feed(b"\x1b_G");
        let filler = vec![b'A'; MAX_PAYLOAD + 10];
        assert!(s.feed(&filler).is_empty());
        assert_eq!(s.feed(b"\x1b\\ok"), [bytes("ok")]);
    }

    #[test]
    fn kitty_keys_parse() {
        let c = KittyCommand::parse(
            b"a=T,f=100,i=7,I=2,p=3,m=1,c=10,r=4,x=1,y=2,w=30,h=40,X=5,Y=6,z=-3,C=1,q=2;QUJD",
        )
        .unwrap();
        assert_eq!(c.action, Action::TransmitDisplay);
        assert_eq!(c.format, Format::Png);
        assert_eq!((c.id, c.number, c.placement), (7, 2, 3));
        assert!(c.more && c.no_move);
        assert_eq!((c.cols, c.rows), (10, 4));
        assert_eq!(c.src, (1, 2, 30, 40));
        assert_eq!(c.offset, (5, 6));
        assert_eq!((c.z, c.quiet), (-3, 2));
        assert_eq!(c.payload, b"QUJD");
    }

    #[test]
    fn defaults_are_a_direct_rgba_transmit() {
        let c = KittyCommand::parse(b"s=1,v=1;AAAA").unwrap();
        assert_eq!(c.action, Action::Transmit);
        assert_eq!((c.format, c.medium), (Format::Rgba, Medium::Direct));
    }

    #[test]
    fn delete_letters_pick_target_and_free() {
        let c = KittyCommand::parse(b"a=d,d=I,i=4").unwrap();
        assert_eq!((c.delete, c.free), (DeleteTarget::Id, true));
        let c = KittyCommand::parse(b"a=d,d=a").unwrap();
        assert_eq!((c.delete, c.free), (DeleteTarget::All, false));
        let c = KittyCommand::parse(b"a=d").unwrap();
        assert_eq!(c.delete, DeleteTarget::All);
        let c = KittyCommand::parse(b"a=d,d=p,x=3,y=4").unwrap();
        assert_eq!(
            (c.delete, c.delete_x, c.delete_y),
            (DeleteTarget::Cell, 3, 4)
        );
    }

    #[test]
    fn malformed_keys_drop_the_command() {
        assert!(KittyCommand::parse(b"a=T,i=abc").is_none());
        assert!(KittyCommand::parse(b"garbage").is_none());
        assert!(KittyCommand::parse(b"a=T,s=-1").is_none());
        assert!(KittyCommand::parse(b"a=,i=1").is_none());
    }

    #[test]
    fn chunks_join_and_only_the_first_keys_count() {
        let mut a = Assembler::default();
        let first = KittyCommand::parse(b"a=T,f=100,i=9,m=1;AAAA").unwrap();
        assert_eq!(a.push(first), Assembled::Wait);
        let mid = KittyCommand::parse(b"m=1,i=1,f=24;BBBB").unwrap();
        assert_eq!(a.push(mid), Assembled::Wait);
        let last = KittyCommand::parse(b"m=0;CCCC").unwrap();
        let Assembled::Ready(done) = a.push(last) else {
            panic!("not ready")
        };
        assert_eq!((done.id, done.format), (9, Format::Png));
        assert_eq!(done.payload, b"AAAABBBBCCCC");
        let Assembled::Ready(next) = a.push(KittyCommand::parse(b"a=q,i=1;AAAA").unwrap()) else {
            panic!("a finished stream does not linger")
        };
        assert_eq!(next.action, Action::Query);
    }

    #[test]
    fn chunks_over_the_cap_are_refused() {
        let mut a = Assembler::default();
        let mut first = KittyCommand::parse(b"a=T,i=1,m=1;").unwrap();
        first.payload = vec![b'A'; MAX_PAYLOAD - 1];
        assert_eq!(a.push(first), Assembled::Wait);
        let mut next = KittyCommand::parse(b"m=1;").unwrap();
        next.payload = vec![b'A'; 8];
        let Assembled::TooLarge(cmd) = a.push(next) else {
            panic!("accepted")
        };
        assert_eq!(cmd.id, 1);
        let Assembled::Ready(_) = a.push(KittyCommand::parse(b"a=q,i=2;AAAA").unwrap()) else {
            panic!("state not cleared")
        };
    }

    #[test]
    fn replies_follow_ids_and_quiet() {
        let c = KittyCommand::parse(b"a=q,i=31;AAAA").unwrap();
        assert_eq!(
            kitty_reply(&c, Ok(())).unwrap(),
            b"\x1b_Gi=31;OK\x1b\\".to_vec()
        );
        let c = KittyCommand::parse(b"a=T,I=5,p=2").unwrap();
        assert_eq!(
            kitty_reply(&c, Err(KittyError::NoEntry.text("no such image"))).unwrap(),
            b"\x1b_GI=5,p=2;ENOENT:no such image\x1b\\".to_vec()
        );
        assert!(kitty_reply(&KittyCommand::parse(b"a=q").unwrap(), Ok(())).is_none());
        let c = KittyCommand::parse(b"i=1,q=1").unwrap();
        assert!(kitty_reply(&c, Ok(())).is_none());
        assert!(kitty_reply(&c, Err("EINVAL:x".into())).is_some());
        let c = KittyCommand::parse(b"i=1,q=2").unwrap();
        assert!(kitty_reply(&c, Err("EINVAL:x".into())).is_none());
    }

    #[test]
    fn iterm_args_parse() {
        let f = ItermFile::parse(
            b"name=YS5wbmc=;inline=1;width=40;height=10px;preserveAspectRatio=0:QUJD",
        )
        .unwrap();
        assert!(f.inline && !f.preserve_aspect);
        assert_eq!((f.width, f.height), (Dim::Cells(40), Dim::Pixels(10)));
        assert_eq!(f.payload, b"QUJD");
        let f = ItermFile::parse(b"inline=0;width=auto;height=50%:AA").unwrap();
        assert!(!f.inline && f.preserve_aspect);
        assert_eq!((f.width, f.height), (Dim::Auto, Dim::Percent(50)));
        assert!(ItermFile::parse(b"no colon here").is_none());
        assert_eq!(Dim::parse("0").to_cells(9, 80), None);
        assert_eq!(Dim::Percent(50).to_cells(9, 80), Some(40));
        assert_eq!(Dim::Pixels(19).to_cells(9, 80), Some(3));
    }

    fn req(w: u32, h: u32) -> FitRequest {
        FitRequest {
            image_w: w,
            image_h: h,
            cell_w: 10,
            cell_h: 20,
            want_cols: None,
            want_rows: None,
            max_cols: 80,
            max_rows: 24,
            stretch: false,
        }
    }

    #[test]
    fn natural_size_rounds_up_to_whole_cells_and_keeps_pixels() {
        let f = fit(req(95, 50));
        assert_eq!((f.cols, f.rows), (10, 3));
        assert!((f.fill_w - 0.95).abs() < 1e-3 && (f.fill_h - 50.0 / 60.0).abs() < 1e-3);
    }

    #[test]
    fn one_requested_side_derives_the_other() {
        let f = fit(FitRequest {
            want_cols: Some(20),
            ..req(100, 100)
        });
        assert_eq!((f.cols, f.rows), (20, 10));
        let f = fit(FitRequest {
            want_rows: Some(5),
            ..req(100, 100)
        });
        assert_eq!((f.cols, f.rows), (10, 5));
    }

    #[test]
    fn both_sides_fit_inside_unless_stretched() {
        let f = fit(FitRequest {
            want_cols: Some(20),
            want_rows: Some(20),
            ..req(100, 100)
        });
        assert_eq!((f.cols, f.rows), (20, 10));
        let f = fit(FitRequest {
            want_cols: Some(20),
            want_rows: Some(20),
            stretch: true,
            ..req(100, 100)
        });
        assert_eq!((f.cols, f.rows, f.fill_w, f.fill_h), (20, 20, 1.0, 1.0));
    }

    #[test]
    fn oversize_scales_down_to_the_line_and_the_row_cap() {
        let f = fit(req(4000, 100));
        assert_eq!(f.cols, 80);
        assert!(f.rows >= 1 && f.rows <= 24);
        let f = fit(FitRequest {
            max_rows: 500,
            ..req(100, 100_000)
        });
        assert_eq!(f.rows, MAX_IMAGE_ROWS);
        let f = fit(FitRequest {
            max_cols: 5,
            want_cols: Some(40),
            ..req(100, 100)
        });
        assert!(f.cols <= 5);
    }

    #[test]
    fn degenerate_sizes_still_give_one_cell() {
        let f = fit(FitRequest {
            cell_w: 0,
            cell_h: 0,
            max_cols: 0,
            max_rows: 0,
            ..req(0, 0)
        });
        assert!(f.cols >= 1 && f.rows >= 1);
    }

    #[test]
    fn the_budget_evicts_oldest_on_bytes_and_count() {
        let mut b = Budget::new(100, 3);
        assert_eq!(b.admit(1, 40), Some(vec![]));
        assert_eq!(b.admit(2, 40), Some(vec![]));
        assert_eq!(b.admit(3, 40), Some(vec![1]));
        assert_eq!(b.total(), 80);
        assert_eq!(b.admit(4, 10), Some(vec![]));
        assert_eq!(b.admit(5, 10), Some(vec![2]));
        assert_eq!(b.len(), 3);
        assert_eq!(b.admit(6, 101), None);
        b.remove(3);
        b.remove(99);
        assert_eq!(b.total(), 20);
        assert!(!b.is_empty());
    }
}
