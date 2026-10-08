//! Inline images on top of `alacritty_terminal`, which knows nothing about them.
//!
//! A placement is anchored by tagging cells: one private-use zero-width character per image
//! row, in the image's first column. The tag lives in the grid, so it scrolls into history,
//! reflows on resize, is dropped when its line leaves history, is erased by clear and lives on
//! the alternate screen only while that screen does. Text written over a tag erases it; the
//! image stays while any of its rows keeps one.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Cursor;
use std::sync::Arc;

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use base64::Engine;
use base64::alphabet::STANDARD as ALPHABET;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use tether_core::graphics::{
    Action, Assembled, Budget, DeleteTarget, Dim, Fit, FitRequest, Format, ItermFile, KittyCommand,
    KittyError, MAX_DIMENSION, MAX_IMAGE_ROWS, MAX_PAYLOAD, MAX_PIXELS, Medium, Segment, fit,
    kitty_reply,
};

use crate::terminal::{TabTerminal, TermEvent};

pub const MAX_IMAGE_BYTES: usize = 128 << 20;
pub const MAX_IMAGES: usize = 128;

const PLANES: [(u32, u32); 2] = [(0xF0000, 0xFFFFD), (0x100000, 0x10FFFD)];
const PLANE_LEN: u32 = 0xFFFE;
const ROW_SLOTS: u32 = MAX_IMAGE_ROWS;
const INDEXES: u32 = PLANE_LEN * 2 / ROW_SLOTS;

fn tag_char(index: u32, row: u32) -> char {
    let n = index * ROW_SLOTS + row;
    let (plane, offset) = if n < PLANE_LEN {
        (PLANES[0].0, n)
    } else {
        (PLANES[1].0, n - PLANE_LEN)
    };
    char::from_u32(plane + offset).expect("tag within a private-use plane")
}

fn decode_tag(c: char) -> Option<(u32, u32)> {
    let c = c as u32;
    let n = if (PLANES[0].0..=PLANES[0].1).contains(&c) {
        c - PLANES[0].0
    } else if (PLANES[1].0..=PLANES[1].1).contains(&c) {
        c - PLANES[1].0 + PLANE_LEN
    } else {
        return None;
    };
    let index = n / ROW_SLOTS;
    (index < INDEXES).then_some((index, n % ROW_SLOTS))
}

pub fn is_tag(c: char) -> bool {
    decode_tag(c).is_some()
}

/// Selected text with the image anchors taken out.
pub fn strip_tags(text: &str) -> String {
    text.chars().filter(|c| !is_tag(*c)).collect()
}

pub struct ImageData {
    pub id: u64,
    pub width: u32,
    pub height: u32,
    /// Straight (not premultiplied) RGBA.
    pub rgba: Vec<u8>,
}

impl std::fmt::Debug for ImageData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ImageData#{}({}x{})", self.id, self.width, self.height)
    }
}

#[derive(Debug, Clone)]
pub struct ImageView {
    pub image: Arc<ImageData>,
    pub src: (u32, u32, u32, u32),
    /// Viewport row of the image's top edge; negative once the top has scrolled off.
    pub row: i32,
    pub col: usize,
    pub cols: u32,
    pub rows: u32,
    pub fill_w: f32,
    pub fill_h: f32,
    pub offset: (u32, u32),
    pub z: i32,
}

struct Placement {
    seq: u64,
    image: Arc<ImageData>,
    kitty_place: u32,
    src: (u32, u32, u32, u32),
    cols: u32,
    rows: u32,
    fill_w: f32,
    fill_h: f32,
    offset: (u32, u32),
    z: i32,
}

pub(crate) struct ImageStore {
    next_data: u64,
    next_seq: u64,
    next_index: u32,
    wrapped: bool,
    data: HashMap<u64, Arc<ImageData>>,
    by_id: HashMap<u32, u64>,
    by_number: HashMap<u32, u64>,
    budget: Budget,
    placements: BTreeMap<u32, Placement>,
}

impl ImageStore {
    pub(crate) fn new() -> Self {
        Self::with_limits(MAX_IMAGE_BYTES, MAX_IMAGES)
    }

    pub(crate) fn with_limits(bytes: usize, count: usize) -> Self {
        ImageStore {
            next_data: 1,
            next_seq: 1,
            next_index: 0,
            wrapped: false,
            data: HashMap::new(),
            by_id: HashMap::new(),
            by_number: HashMap::new(),
            budget: Budget::new(bytes, count),
            placements: BTreeMap::new(),
        }
    }

    pub(crate) fn image_count(&self) -> usize {
        self.data.len()
    }

    pub(crate) fn image_bytes(&self) -> usize {
        self.budget.total()
    }

    pub(crate) fn placement_count(&self) -> usize {
        self.placements.len()
    }

    fn drop_data(&mut self, id: u64) {
        self.data.remove(&id);
        self.budget.remove(id);
        self.by_id.retain(|_, v| *v != id);
        self.by_number.retain(|_, v| *v != id);
        self.placements.retain(|_, p| p.image.id != id);
    }

    fn insert(
        &mut self,
        kitty_id: u32,
        number: u32,
        width: u32,
        height: u32,
        rgba: Vec<u8>,
    ) -> Option<Arc<ImageData>> {
        let mut replaced = Vec::new();
        if kitty_id != 0 {
            replaced.extend(self.by_id.get(&kitty_id).copied());
        }
        if number != 0 {
            replaced.extend(self.by_number.get(&number).copied());
        }
        for old in replaced {
            self.drop_data(old);
        }
        let id = self.next_data;
        self.next_data += 1;
        let evicted = self.budget.admit(id, rgba.len())?;
        for old in evicted {
            self.drop_data(old);
        }
        let image = Arc::new(ImageData {
            id,
            width,
            height,
            rgba,
        });
        self.data.insert(id, image.clone());
        if kitty_id != 0 {
            self.by_id.insert(kitty_id, id);
        }
        if number != 0 {
            self.by_number.insert(number, id);
        }
        Some(image)
    }

    fn lookup(&self, id: u32, number: u32) -> Option<Arc<ImageData>> {
        let data = if id != 0 {
            self.by_id.get(&id)
        } else {
            self.by_number.get(&number)
        }?;
        self.data.get(data).cloned()
    }

    fn needs_gc(&self) -> bool {
        self.budget.over_half() || self.placements.len() * 2 > INDEXES as usize
    }

    /// Frees placements no tag points to any more, and the pictures only they used.
    fn collect(&mut self, live: &HashSet<u32>, keep: u64) {
        self.placements.retain(|index, _| live.contains(index));
        let used: HashSet<u64> = self.placements.values().map(|p| p.image.id).collect();
        let addressed: HashSet<u64> = self
            .by_id
            .values()
            .chain(self.by_number.values())
            .copied()
            .collect();
        let dead: Vec<u64> = self
            .data
            .keys()
            .filter(|id| **id != keep && !used.contains(id) && !addressed.contains(id))
            .copied()
            .collect();
        for id in dead {
            self.drop_data(id);
        }
    }

    fn next_free_index(&mut self) -> (u32, bool) {
        let index = self.next_index;
        self.next_index = (index + 1) % INDEXES;
        if self.next_index == 0 {
            self.wrapped = true;
        }
        (index, self.wrapped)
    }
}

#[derive(Debug, Clone, Copy)]
struct Hit {
    index: u32,
    row: u32,
    line: i32,
    col: usize,
}

type Failure = (KittyError, &'static str);

fn base64_engine() -> GeneralPurpose {
    GeneralPurpose::new(
        &ALPHABET,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    )
}

fn decode_base64(payload: &[u8]) -> Option<Vec<u8>> {
    if payload.len() > MAX_PAYLOAD {
        return None;
    }
    let clean: Vec<u8> = payload
        .iter()
        .copied()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    base64_engine().decode(clean).ok()
}

struct Pixels {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

fn decode_picture(bytes: &[u8]) -> Option<Pixels> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_PIXELS * 8);
    reader.limits(limits);
    let rgba = reader.decode().ok()?.into_rgba8();
    let (width, height) = rgba.dimensions();
    (width > 0 && height > 0 && u64::from(width) * u64::from(height) <= MAX_PIXELS).then(|| {
        Pixels {
            width,
            height,
            rgba: rgba.into_raw(),
        }
    })
}

fn decode_kitty(cmd: &KittyCommand) -> Result<Pixels, Failure> {
    if cmd.medium != Medium::Direct {
        return Err((KittyError::Unsupported, "only direct transmission"));
    }
    if cmd.virtual_placement {
        return Err((KittyError::Unsupported, "unicode placeholders"));
    }
    let Some(mut raw) = decode_base64(&cmd.payload).filter(|d| !d.is_empty()) else {
        return Err((KittyError::Decode, "bad base64 data"));
    };
    let bytes_per_pixel = match cmd.format {
        Format::Rgb => 3,
        Format::Rgba => 4,
        Format::Png => 0,
        Format::Other(_) => return Err((KittyError::Unsupported, "unknown pixel format")),
    };
    let limit = if bytes_per_pixel == 0 {
        MAX_PIXELS as usize * 4
    } else {
        MAX_PIXELS as usize * bytes_per_pixel
    };
    if cmd.zlib {
        raw = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(&raw, limit)
            .map_err(|_| (KittyError::Decode, "bad zlib data"))?;
    }
    if bytes_per_pixel == 0 {
        return decode_picture(&raw).ok_or((KittyError::Decode, "bad PNG data"));
    }
    let (w, h) = (cmd.width, cmd.height);
    if w == 0 || h == 0 || w > MAX_DIMENSION || h > MAX_DIMENSION {
        return Err((KittyError::Invalid, "bad image size"));
    }
    if u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err((KittyError::TooLarge, "image too large"));
    }
    if raw.len() != (w * h) as usize * bytes_per_pixel {
        return Err((KittyError::Invalid, "data does not match size"));
    }
    let rgba = if bytes_per_pixel == 4 {
        raw
    } else {
        raw.as_chunks::<3>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect()
    };
    Ok(Pixels {
        width: w,
        height: h,
        rgba,
    })
}

struct Layout {
    src: (u32, u32, u32, u32),
    want_cols: Option<u32>,
    want_rows: Option<u32>,
    stretch: bool,
    no_move: bool,
    offset: (u32, u32),
    z: i32,
    kitty_place: u32,
}

impl TabTerminal {
    pub(crate) fn run_segment(&mut self, segment: Segment, out: &mut Vec<TermEvent>) {
        match segment {
            Segment::Bytes(_) => {}
            Segment::Kitty(body) => {
                if let Some(cmd) = KittyCommand::parse(&body) {
                    match self.assembler.push(cmd) {
                        Assembled::Wait => {}
                        Assembled::Ready(cmd) => self.run_kitty(cmd, out),
                        Assembled::TooLarge(cmd) => {
                            let reply = kitty_reply(
                                &cmd,
                                Err(KittyError::TooLarge.text("image data too large")),
                            );
                            out.extend(reply.map(TermEvent::Reply));
                        }
                    }
                }
            }
            Segment::Iterm(body) => {
                if let Some(file) = ItermFile::parse(&body) {
                    self.run_iterm(file);
                }
            }
        }
    }

    fn run_kitty(&mut self, cmd: KittyCommand, out: &mut Vec<TermEvent>) {
        let result = match cmd.action {
            Action::Query => decode_kitty(&cmd).map(|_| ()),
            Action::Transmit | Action::TransmitDisplay => self.kitty_transmit(&cmd),
            Action::Display => self.kitty_display(&cmd),
            Action::Delete => {
                self.kitty_delete(&cmd);
                return;
            }
            Action::Unsupported(_) => Err((KittyError::Unsupported, "unsupported action")),
        };
        let reply = kitty_reply(&cmd, result.map_err(|(kind, detail)| kind.text(detail)));
        out.extend(reply.map(TermEvent::Reply));
    }

    fn kitty_transmit(&mut self, cmd: &KittyCommand) -> Result<(), Failure> {
        let pixels = decode_kitty(cmd)?;
        let image = self
            .images
            .insert(cmd.id, cmd.number, pixels.width, pixels.height, pixels.rgba)
            .ok_or((KittyError::TooLarge, "image too large"))?;
        if cmd.action == Action::TransmitDisplay {
            self.place(image, kitty_layout(cmd))?;
        }
        Ok(())
    }

    fn kitty_display(&mut self, cmd: &KittyCommand) -> Result<(), Failure> {
        let image = self
            .images
            .lookup(cmd.id, cmd.number)
            .ok_or((KittyError::NoEntry, "no such image"))?;
        self.place(image, kitty_layout(cmd))
    }

    fn run_iterm(&mut self, file: ItermFile) {
        if !file.inline {
            return;
        }
        let Some(bytes) = decode_base64(&file.payload) else {
            return;
        };
        let Some(pixels) = decode_picture(&bytes) else {
            return;
        };
        let (cell_w, cell_h) = self.cell_px();
        let want_cols = file
            .width
            .to_cells(cell_w, u32::from(self.size.cols.max(1)));
        let want_rows = file
            .height
            .to_cells(cell_h, u32::from(self.size.rows.max(1)));
        let Some(image) = self
            .images
            .insert(0, 0, pixels.width, pixels.height, pixels.rgba)
        else {
            return;
        };
        let layout = Layout {
            src: (0, 0, image.width, image.height),
            want_cols,
            want_rows,
            stretch: !file.preserve_aspect && (file.width != Dim::Auto && file.height != Dim::Auto),
            no_move: false,
            offset: (0, 0),
            z: 0,
            kitty_place: 0,
        };
        let _ = self.place(image, layout);
    }

    fn cell_px(&self) -> (u32, u32) {
        let w = self.size.width_px / u32::from(self.size.cols.max(1));
        let h = self.size.height_px / u32::from(self.size.rows.max(1));
        (if w == 0 { 8 } else { w }, if h == 0 { 16 } else { h })
    }

    fn place(&mut self, image: Arc<ImageData>, layout: Layout) -> Result<(), Failure> {
        let (x, y) = (layout.src.0, layout.src.1);
        if x >= image.width || y >= image.height {
            return Err((KittyError::Invalid, "source rectangle outside the image"));
        }
        let w = match layout.src.2 {
            0 => image.width - x,
            w => w.min(image.width - x),
        };
        let h = match layout.src.3 {
            0 => image.height - y,
            h => h.min(image.height - y),
        };

        // Leave the synchronized-update buffer: the cursor has to be real to place anything.
        self.parser.stop_sync(&mut self.term);

        let (cell_w, cell_h) = self.cell_px();
        let cursor = self.term.grid().cursor.point;
        let columns = self.term.grid().columns();
        let screen = self.term.grid().screen_lines();
        let col = cursor.column.0;
        let line_room = if layout.no_move {
            screen.saturating_sub(cursor.line.0.max(0) as usize)
        } else {
            screen
        };
        let Fit {
            cols,
            rows,
            fill_w,
            fill_h,
        } = fit(FitRequest {
            image_w: w,
            image_h: h,
            cell_w,
            cell_h,
            want_cols: layout.want_cols,
            want_rows: layout.want_rows,
            max_cols: (columns - col).max(1) as u32,
            max_rows: line_room.max(1) as u32,
            stretch: layout.stretch,
        });

        if layout.kitty_place != 0 {
            let stale: Vec<u32> = self
                .images
                .placements
                .iter()
                .filter(|(_, p)| p.image.id == image.id && p.kitty_place == layout.kitty_place)
                .map(|(i, _)| *i)
                .collect();
            for index in stale {
                self.images.placements.remove(&index);
            }
        }
        if self.images.needs_gc() {
            let live = self.live_indexes();
            self.images.collect(&live, image.id);
        }
        let (index, scrub) = self.images.next_free_index();
        self.images.placements.remove(&index);
        if scrub {
            self.scrub_index(index);
        }
        let seq = self.images.next_seq;
        self.images.next_seq += 1;
        self.images.placements.insert(
            index,
            Placement {
                seq,
                image,
                kitty_place: layout.kitty_place,
                src: (x, y, w, h),
                cols,
                rows,
                fill_w,
                fill_h,
                offset: layout.offset,
                z: layout.z,
            },
        );

        let start = cursor.line.0;
        for r in 0..rows {
            let line = if layout.no_move {
                Line(start + r as i32)
            } else {
                self.term.grid().cursor.point.line
            };
            if line.0 >= screen as i32 {
                break;
            }
            if col < columns {
                self.term.grid_mut()[line][Column(col)].push_zerowidth(tag_char(index, r));
            }
            if !layout.no_move && r + 1 < rows {
                self.parser.advance(&mut self.term, b"\n");
            }
        }
        if !layout.no_move {
            let next = format!("\x1b[{}G", col as u32 + cols + 1);
            self.parser.advance(&mut self.term, next.as_bytes());
        }
        Ok(())
    }

    fn scan(&self, lines: std::ops::Range<i32>) -> Vec<Hit> {
        let grid = self.term.grid();
        let columns = grid.columns();
        let mut hits = Vec::new();
        for line in lines {
            let row = &grid[Line(line)];
            for c in 0..columns {
                let Some(zero) = row[Column(c)].zerowidth() else {
                    continue;
                };
                for &ch in zero {
                    if let Some((index, r)) = decode_tag(ch) {
                        hits.push(Hit {
                            index,
                            row: r,
                            line,
                            col: c,
                        });
                    }
                }
            }
        }
        hits
    }

    fn whole_range(&self) -> std::ops::Range<i32> {
        let grid = self.term.grid();
        -(grid.history_size() as i32)..grid.screen_lines() as i32
    }

    fn live_indexes(&self) -> HashSet<u32> {
        self.scan(self.whole_range())
            .into_iter()
            .map(|h| h.index)
            .collect()
    }

    /// Removes leftover tags of a recycled index so an old image's rows cannot adopt a new one.
    fn scrub_index(&mut self, index: u32) {
        let range = self.whole_range();
        let columns = self.term.grid().columns();
        for line in range {
            for c in 0..columns {
                let cell = &mut self.term.grid_mut()[Line(line)][Column(c)];
                let Some(zero) = cell.zerowidth() else {
                    continue;
                };
                if !zero
                    .iter()
                    .any(|&ch| decode_tag(ch).is_some_and(|(i, _)| i == index))
                {
                    continue;
                }
                let keep: Vec<char> = zero
                    .iter()
                    .copied()
                    .filter(|&ch| decode_tag(ch).is_none_or(|(i, _)| i != index))
                    .collect();
                let link = cell.hyperlink();
                let underline = cell.underline_color();
                cell.extra = None;
                for ch in keep {
                    cell.push_zerowidth(ch);
                }
                if link.is_some() {
                    cell.set_hyperlink(link);
                }
                if underline.is_some() {
                    cell.set_underline_color(underline);
                }
            }
        }
    }

    /// Placements whose tags are on the live screen, with the box each covers there.
    fn screen_boxes(&self) -> Vec<(u32, i32, usize)> {
        let screen = self.term.grid().screen_lines() as i32;
        let mut seen: BTreeMap<u32, (i32, usize)> = BTreeMap::new();
        for hit in self.scan(0..screen) {
            seen.entry(hit.index)
                .or_insert((hit.line - hit.row as i32, hit.col));
        }
        seen.into_iter()
            .filter(|(i, _)| self.images.placements.contains_key(i))
            .map(|(i, (top, col))| (i, top, col))
            .collect()
    }

    fn kitty_delete(&mut self, cmd: &KittyCommand) {
        let cursor = self.term.grid().cursor.point;
        let (cx, cy) = (cursor.column.0 as i32, cursor.line.0);
        let boxes = self.screen_boxes();
        let covers = |index: u32, top: i32, col: usize, x: i32, y: i32| {
            self.images.placements.get(&index).is_some_and(|p| {
                (col as i32..col as i32 + p.cols as i32).contains(&x)
                    && (top..top + p.rows as i32).contains(&y)
            })
        };
        let mut victims: Vec<u32> = Vec::new();
        match cmd.delete {
            DeleteTarget::All => victims.extend(boxes.iter().map(|b| b.0)),
            DeleteTarget::Id | DeleteTarget::Number => {
                let wanted = self.images.lookup(
                    if cmd.delete == DeleteTarget::Id {
                        cmd.id
                    } else {
                        0
                    },
                    if cmd.delete == DeleteTarget::Number {
                        cmd.number
                    } else {
                        0
                    },
                );
                if let Some(image) = wanted {
                    victims.extend(
                        self.images
                            .placements
                            .iter()
                            .filter(|(_, p)| {
                                p.image.id == image.id
                                    && (cmd.placement == 0 || p.kitty_place == cmd.placement)
                            })
                            .map(|(i, _)| *i),
                    );
                    if cmd.free && cmd.placement == 0 {
                        self.images.drop_data(image.id);
                    }
                }
            }
            DeleteTarget::Cursor => victims.extend(
                boxes
                    .iter()
                    .filter(|(i, top, col)| covers(*i, *top, *col, cx, cy))
                    .map(|b| b.0),
            ),
            DeleteTarget::Cell => victims.extend(
                boxes
                    .iter()
                    .filter(|(i, top, col)| {
                        covers(*i, *top, *col, cmd.delete_x - 1, cmd.delete_y - 1)
                    })
                    .map(|b| b.0),
            ),
            DeleteTarget::Column => victims.extend(
                boxes
                    .iter()
                    .filter(|(i, _, col)| {
                        self.images.placements.get(i).is_some_and(|p| {
                            (*col as i32..*col as i32 + p.cols as i32).contains(&(cmd.delete_x - 1))
                        })
                    })
                    .map(|b| b.0),
            ),
            DeleteTarget::Row => victims.extend(
                boxes
                    .iter()
                    .filter(|(i, top, _)| {
                        self.images.placements.get(i).is_some_and(|p| {
                            (*top..*top + p.rows as i32).contains(&(cmd.delete_y - 1))
                        })
                    })
                    .map(|b| b.0),
            ),
            DeleteTarget::ZIndex => victims.extend(
                boxes
                    .iter()
                    .filter(|(i, ..)| self.images.placements.get(i).is_some_and(|p| p.z == cmd.z))
                    .map(|b| b.0),
            ),
            DeleteTarget::Unsupported(_) => {}
        }
        let mut freed = HashSet::new();
        for index in victims {
            if let Some(p) = self.images.placements.remove(&index) {
                freed.insert(p.image.id);
            }
        }
        if cmd.free {
            for id in freed {
                if !self.images.placements.values().any(|p| p.image.id == id) {
                    self.images.drop_data(id);
                }
            }
        }
    }

    /// The pictures whose rows are on screen, oldest first.
    pub(crate) fn image_views(&self) -> Vec<ImageView> {
        if self.images.placements.is_empty() {
            return Vec::new();
        }
        let grid = self.term.grid();
        let offset = grid.display_offset() as i32;
        let rows = grid.screen_lines() as i32;
        let mut tops: BTreeMap<u32, (i32, usize)> = BTreeMap::new();
        for hit in self.scan(-offset..rows - offset) {
            tops.entry(hit.index)
                .or_insert((hit.line - hit.row as i32 + offset, hit.col));
        }
        let mut views: Vec<(u64, ImageView)> = tops
            .into_iter()
            .filter_map(|(index, (row, col))| {
                let p = self.images.placements.get(&index)?;
                Some((
                    p.seq,
                    ImageView {
                        image: p.image.clone(),
                        src: p.src,
                        row,
                        col,
                        cols: p.cols,
                        rows: p.rows,
                        fill_w: p.fill_w,
                        fill_h: p.fill_h,
                        offset: p.offset,
                        z: p.z,
                    },
                ))
            })
            .collect();
        views.sort_by_key(|(seq, _)| *seq);
        views.into_iter().map(|(_, v)| v).collect()
    }

    pub fn image_stats(&self) -> ImageStats {
        ImageStats {
            images: self.images.image_count(),
            bytes: self.images.image_bytes(),
            placements: self.images.placement_count(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageStats {
    pub images: usize,
    pub bytes: usize,
    pub placements: usize,
}

fn kitty_layout(cmd: &KittyCommand) -> Layout {
    Layout {
        src: cmd.src,
        want_cols: (cmd.cols > 0).then_some(cmd.cols),
        want_rows: (cmd.rows > 0).then_some(cmd.rows),
        stretch: true,
        no_move: cmd.no_move,
        offset: cmd.offset,
        z: cmd.z,
        kitty_place: cmd.placement,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::tests::{replies, size, term};
    use crate::terminal::{Cell, SCROLLBACK, SelectKind};
    use tether_core::theme::theme_named;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn png(w: u32, h: u32, rgba: [u8; 4]) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(w, h, image::Rgba(rgba));
        let mut out = Vec::new();
        img.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    fn kitty_png(control: &str, w: u32, h: u32) -> Vec<u8> {
        format!(
            "\x1b_G{control},f=100;{}\x1b\\",
            b64(&png(w, h, [255, 0, 0, 255]))
        )
        .into_bytes()
    }

    fn iterm(args: &str, w: u32, h: u32) -> Vec<u8> {
        format!(
            "\x1b]1337;File={args}:{}\x07",
            b64(&png(w, h, [0, 255, 0, 255]))
        )
        .into_bytes()
    }

    fn texts(t: &TabTerminal) -> Vec<String> {
        t.snapshot().row_texts
    }

    fn cursor(t: &TabTerminal) -> Option<Cell> {
        t.snapshot().cursor
    }

    #[test]
    fn tags_round_trip_and_stay_private_use() {
        for (index, row) in [(0, 0), (0, 63), (1, 0), (1023, 31), (INDEXES - 1, 63)] {
            let c = tag_char(index, row);
            assert_eq!(decode_tag(c), Some((index, row)), "{index} {row}");
            assert!(!c.is_alphanumeric());
        }
        assert_eq!(decode_tag('a'), None);
        assert_eq!(strip_tags(&format!("a{}b", tag_char(3, 4))), "ab");
    }

    #[test]
    fn a_kitty_png_lands_at_the_cursor_and_moves_it_past_the_image() {
        let mut t = term();
        t.feed(b"ab");
        t.feed(&kitty_png("a=T", 90, 36));
        let s = t.snapshot();
        assert_eq!(s.images.len(), 1);
        let v = &s.images[0];
        assert_eq!((v.row, v.col, v.cols, v.rows), (0, 2, 10, 2));
        assert_eq!((v.fill_w, v.fill_h), (1.0, 1.0));
        assert_eq!(s.cursor, Some(Cell { row: 1, col: 12 }));
        assert!(s.row_texts[0].starts_with("ab"));
        t.feed(b"X");
        assert!(texts(&t)[1].contains('X'));
    }

    #[test]
    fn raw_rgb_and_rgba_decode_and_chunks_join() {
        let mut t = term();
        let rgb = [10u8, 20, 30].repeat(4);
        t.feed(format!("\x1b_Ga=T,f=24,s=2,v=2;{}\x1b\\", b64(&rgb)).as_bytes());
        let v = t.snapshot().images.pop().unwrap();
        assert_eq!((v.image.width, v.image.height), (2, 2));
        assert_eq!(&v.image.rgba[..4], &[10, 20, 30, 255]);

        let rgba = [1u8, 2, 3, 4].repeat(16);
        let full = b64(&rgba);
        let (a, b) = full.split_at(24);
        t.feed(format!("\x1b_Ga=T,f=32,s=4,v=4,i=5,m=1;{a}\x1b\\").as_bytes());
        assert_eq!(t.snapshot().images.len(), 1, "waits for the last chunk");
        let answer = replies(&t.feed(format!("\x1b_Gm=0;{b}\x1b\\").as_bytes()));
        assert_eq!(answer, ["\x1b_Gi=5;OK\x1b\\"]);
        assert_eq!(t.snapshot().images.len(), 2);
    }

    #[test]
    fn zlib_compressed_raw_data_is_inflated() {
        let mut t = term();
        let raw = [9u8, 8, 7, 255].repeat(4);
        let packed = miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6);
        t.feed(format!("\x1b_Ga=T,f=32,s=2,v=2,o=z;{}\x1b\\", b64(&packed)).as_bytes());
        assert_eq!(t.snapshot().images[0].image.rgba, raw);
    }

    #[test]
    fn queries_are_answered_honestly() {
        let mut t = term();
        let ok = replies(&t.feed(b"\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\"));
        assert_eq!(ok, ["\x1b_Gi=31;OK\x1b\\"]);
        assert!(t.snapshot().images.is_empty(), "a query never displays");
        let file = replies(&t.feed(b"\x1b_Gi=32,s=1,v=1,a=q,t=f,f=24;AAAA\x1b\\"));
        assert!(file[0].starts_with("\x1b_Gi=32;ENOTSUP:"), "{file:?}");
        let bad = replies(&t.feed(b"\x1b_Gi=33,s=2,v=2,a=q,f=24;AAAA\x1b\\"));
        assert!(bad[0].starts_with("\x1b_Gi=33;EINVAL:"), "{bad:?}");
        assert!(replies(&t.feed(b"\x1b_Ga=q,s=1,v=1,f=24;AAAA\x1b\\")).is_empty());
        let quiet = replies(&t.feed(b"\x1b_Gi=34,q=1,s=1,v=1,a=q,f=24;AAAA\x1b\\"));
        assert!(quiet.is_empty());
    }

    #[test]
    fn transmit_then_place_by_id_and_number() {
        let mut t = term();
        t.feed(&kitty_png("a=t,i=7", 18, 18));
        assert!(t.snapshot().images.is_empty());
        let out = replies(&t.feed(b"\x1b_Ga=p,i=7,c=4,r=2\x1b\\"));
        assert_eq!(out, ["\x1b_Gi=7;OK\x1b\\"]);
        let v = t.snapshot().images.pop().unwrap();
        assert_eq!((v.cols, v.rows), (4, 2));
        let missing = replies(&t.feed(b"\x1b_Ga=p,i=99\x1b\\"));
        assert!(missing[0].starts_with("\x1b_Gi=99;ENOENT"), "{missing:?}");
        t.feed(&kitty_png("a=t,I=3", 9, 18));
        t.feed(b"\x1b_Ga=p,I=3\x1b\\");
        assert_eq!(t.snapshot().images.len(), 2);
    }

    #[test]
    fn source_rectangles_and_offsets_are_kept() {
        let mut t = term();
        t.feed(&kitty_png("a=T,x=10,y=4,w=30,h=20,X=2,Y=3", 90, 36));
        let v = t.snapshot().images.pop().unwrap();
        assert_eq!(v.src, (10, 4, 30, 20));
        assert_eq!(v.offset, (2, 3));
        t.feed(&kitty_png("a=T,x=900", 90, 36));
        assert_eq!(
            t.snapshot().images.len(),
            1,
            "a rectangle off the image is refused"
        );
    }

    #[test]
    fn no_cursor_movement_leaves_the_cursor_and_tags_the_rows_below() {
        let mut t = term();
        t.feed(b"\x1b[3;3H");
        t.feed(&kitty_png("a=T,C=1", 18, 54));
        let s = t.snapshot();
        assert_eq!(s.cursor, Some(Cell { row: 2, col: 2 }));
        assert_eq!((s.images[0].row, s.images[0].rows), (2, 3));
    }

    #[test]
    fn oversized_images_scale_to_the_line_and_never_corrupt_the_grid() {
        let mut t = term();
        t.feed(b"\x1b[1;70H");
        t.feed(&kitty_png("a=T", 2000, 200));
        let v = t.snapshot().images.pop().unwrap();
        assert!(v.col + v.cols as usize <= 80, "{v:?}");
        assert!(v.rows >= 1);
    }

    #[test]
    fn images_scroll_into_history_with_their_lines() {
        let mut t = term();
        t.feed(&kitty_png("a=T", 90, 36));
        t.feed(b"\r\n");
        t.feed("x\r\n".repeat(30).as_bytes());
        assert!(t.snapshot().images.is_empty(), "off the viewport");
        t.scroll(40);
        let v = t.snapshot().images.pop().unwrap();
        assert!(v.row < 24 && v.row + v.rows as i32 > 0, "{v:?}");
    }

    #[test]
    fn a_partly_scrolled_image_keeps_its_visible_rows() {
        let mut t = term();
        t.feed(&kitty_png("a=T", 36, 360));
        t.feed("\r\n".repeat(10).as_bytes());
        let v = t.snapshot().images.pop().unwrap();
        assert!(v.row < 0 && v.row + v.rows as i32 > 0, "{v:?}");
    }

    #[test]
    fn images_leave_with_the_lines_that_fall_out_of_history() {
        let mut t = term();
        t.feed(&kitty_png("a=T", 9, 18));
        t.feed("x\r\n".repeat(SCROLLBACK + 100).as_bytes());
        t.scroll(i32::MAX / 2);
        assert!(t.snapshot().images.is_empty());
    }

    #[test]
    fn clear_screen_and_the_alternate_screen_drop_images() {
        let mut t = term();
        t.feed(&kitty_png("a=T", 9, 18));
        t.feed(b"\x1b[2J");
        assert!(t.snapshot().images.is_empty());

        t.feed(b"\x1b[H");
        t.feed(&kitty_png("a=T", 9, 18));
        assert_eq!(t.snapshot().images.len(), 1);
        t.feed(b"\x1b[?1049h");
        assert!(
            t.snapshot().images.is_empty(),
            "the alternate grid is blank"
        );
        t.feed(&kitty_png("a=T", 9, 18));
        assert_eq!(t.snapshot().images.len(), 1);
        t.feed(b"\x1b[?1049l");
        assert_eq!(
            t.snapshot().images.len(),
            1,
            "the main screen's image is back"
        );
    }

    #[test]
    fn text_over_one_row_keeps_the_image_until_every_row_is_overwritten() {
        let mut t = term();
        t.feed(&kitty_png("a=T", 18, 54));
        t.feed(b"\x1b[1;1Hover");
        assert_eq!(t.snapshot().images.len(), 1);
        t.feed(b"\x1b[2;1Hover\x1b[3;1Hover");
        assert!(t.snapshot().images.is_empty());
    }

    #[test]
    fn resize_clips_or_drops_without_touching_the_text() {
        let mut t = term();
        t.feed(b"hello\r\n");
        t.feed(&kitty_png("a=T", 90, 36));
        t.feed(b"\r\ntail");
        t.resize(size(80, 30));
        assert_eq!(t.snapshot().images.len(), 1);
        t.resize(size(5, 8));
        let s = t.snapshot();
        assert!(s.images.iter().all(|v| v.col < 5));
        t.resize(size(120, 40));
        assert!(texts(&t).iter().any(|l| l.starts_with("hello")));
        assert!(texts(&t).iter().any(|l| l.starts_with("tail")));
    }

    #[test]
    fn deletes_target_what_they_name() {
        let mut t = term();
        t.feed(&kitty_png("a=T,i=1", 9, 18));
        t.feed(b"\r\n");
        t.feed(&kitty_png("a=T,i=2,p=9", 9, 18));
        t.feed(b"\r\n");
        t.feed(&kitty_png("a=T,i=3,z=5", 9, 18));
        assert_eq!(t.snapshot().images.len(), 3);
        t.feed(b"\x1b_Ga=d,d=i,i=1\x1b\\");
        assert_eq!(t.snapshot().images.len(), 2);
        t.feed(b"\x1b_Ga=d,d=z,z=5\x1b\\");
        assert_eq!(t.snapshot().images.len(), 1);
        t.feed(b"\x1b_Ga=d,d=I,i=2,p=1\x1b\\");
        assert_eq!(t.snapshot().images.len(), 1, "wrong placement id");
        t.feed(b"\x1b_Ga=d,d=I,i=2\x1b\\");
        assert!(t.snapshot().images.is_empty());
        assert!(t.image_stats().images <= 2, "{:?}", t.image_stats());
    }

    #[test]
    fn delete_by_cell_row_column_and_cursor() {
        let mut t = term();
        t.feed(&kitty_png("a=T,C=1", 90, 36));
        t.feed(b"\x1b_Ga=d,d=p,x=50,y=1\x1b\\");
        assert_eq!(t.snapshot().images.len(), 1);
        t.feed(b"\x1b_Ga=d,d=p,x=3,y=2\x1b\\");
        assert!(t.snapshot().images.is_empty());
        t.feed(&kitty_png("a=T,C=1", 90, 36));
        t.feed(b"\x1b_Ga=d,d=x,x=5\x1b\\");
        assert!(t.snapshot().images.is_empty());
        t.feed(&kitty_png("a=T,C=1", 90, 36));
        t.feed(b"\x1b_Ga=d,d=y,y=2\x1b\\");
        assert!(t.snapshot().images.is_empty());
        t.feed(&kitty_png("a=T,C=1", 90, 36));
        t.feed(b"\x1b_Ga=d,d=c\x1b\\");
        assert!(t.snapshot().images.is_empty());
        t.feed(&kitty_png("a=T,C=1", 90, 36));
        t.feed(b"\x1b_Ga=d\x1b\\");
        assert!(t.snapshot().images.is_empty());
    }

    #[test]
    fn replacing_a_placement_id_does_not_stack_images() {
        let mut t = term();
        t.feed(&kitty_png("a=t,i=4", 9, 18));
        for _ in 0..3 {
            t.feed(b"\x1b[H\x1b_Ga=p,i=4,p=1\x1b\\");
        }
        assert_eq!(t.snapshot().images.len(), 1);
        assert_eq!(t.image_stats().placements, 1);
    }

    #[test]
    fn iterm_inline_images_place_and_size() {
        let mut t = term();
        t.feed(&iterm("inline=1;width=20;preserveAspectRatio=1", 90, 36));
        let v = t.snapshot().images.pop().unwrap();
        assert_eq!((v.cols, v.rows), (20, 4));
        t.feed(b"\r\n");
        t.feed(&iterm("inline=1;height=3px", 90, 36));
        assert_eq!(t.snapshot().images.len(), 2);
        let before = t.image_stats();
        t.feed(&iterm("inline=0", 90, 36));
        assert_eq!(t.image_stats(), before, "downloads are not displayed");
        t.feed(b"\x1b]1337;File=inline=1:not-an-image\x07");
        assert_eq!(t.image_stats(), before);
    }

    #[test]
    fn selections_and_snapshots_never_expose_the_anchors() {
        let mut t = term();
        t.feed(b"ab");
        t.feed(&kitty_png("a=T,C=1", 9, 18));
        t.selection_start(Cell { row: 0, col: 0 }, SelectKind::Line);
        let text = t.selection_text().unwrap();
        assert!(text.chars().all(|c| !is_tag(c)), "{text:?}");
        let s = t.snapshot();
        assert!(s.cells.iter().all(|c| c.zerowidth.is_empty()));
    }

    #[test]
    fn the_store_is_bounded_in_count_and_bytes() {
        let mut t = term();
        t.images = ImageStore::with_limits(4 * 4 * 4 * 3, 100);
        for _ in 0..10 {
            t.feed(&kitty_png("a=T,C=1", 4, 4));
            t.feed(b"\r\n");
        }
        let stats = t.image_stats();
        assert!(
            stats.bytes <= 4 * 4 * 4 * 3 && stats.images <= 3,
            "{stats:?}"
        );
        assert!(
            t.snapshot().images.len() <= 3,
            "evicted pictures lose their placements"
        );

        let mut t = term();
        t.images = ImageStore::with_limits(1 << 30, 2);
        for _ in 0..5 {
            t.feed(&kitty_png("a=T,C=1", 4, 4));
            t.feed(b"\r\n");
        }
        assert_eq!(t.image_stats().images, 2);
        let huge = vec![0u8; 8 * 8 * 4];
        t.images = ImageStore::with_limits(100, 10);
        t.feed(format!("\x1b_Ga=T,f=32,s=8,v=8,i=1;{}\x1b\\", b64(&huge)).as_bytes());
        assert_eq!(t.image_stats().images, 0);
    }

    #[test]
    fn oversized_declared_sizes_are_refused() {
        let mut t = term();
        let out = replies(&t.feed(b"\x1b_Ga=T,f=32,s=20000,v=20000,i=1;AAAA\x1b\\"));
        assert!(out[0].starts_with("\x1b_Gi=1;EINVAL"), "{out:?}");
        let out = replies(&t.feed(b"\x1b_Ga=T,f=32,s=8000,v=8000,i=2;AAAA\x1b\\"));
        assert!(out[0].starts_with("\x1b_Gi=2;EFBIG"), "{out:?}");
        assert!(t.snapshot().images.is_empty());
    }

    #[test]
    fn recycled_tag_indexes_are_scrubbed_from_old_lines() {
        let mut t = TabTerminal::new(size(80, 24), theme_named("tether"));
        t.feed(&kitty_png("a=T", 9, 18));
        for _ in 0..INDEXES {
            t.feed(b"\r\n");
            t.feed(&kitty_png("a=T,C=1", 9, 18));
        }
        let mut seen = HashSet::new();
        for hit in t.scan(t.whole_range()) {
            assert!(seen.insert((hit.index, hit.row)), "duplicate tag {hit:?}");
        }
        assert!(t.image_stats().placements <= INDEXES as usize);
    }

    #[test]
    fn a_synchronized_update_does_not_misplace_an_image() {
        let mut t = term();
        t.feed(b"\x1b[?2026hab");
        t.feed(&kitty_png("a=T", 9, 18));
        let v = t.snapshot().images.pop().unwrap();
        assert_eq!((v.row, v.col), (0, 2));
    }

    #[test]
    fn malformed_sequences_leave_the_grid_as_plain_text_would() {
        let junk: [&[u8]; 14] = [
            b"\x1b_G\x1b\\",
            b"\x1b_Ga=T,f=100;!!!!\x1b\\",
            b"\x1b_Ga=T,f=24,s=2,v=2;AAAA\x1b\\",
            b"\x1b_Ga=T,s=abc;AAAA\x1b\\",
            b"\x1b_Ga=z,i=1\x1b\\",
            b"\x1b_Ga=p,i=77\x1b\\",
            b"\x1b_Ga=T,f=100;AAAA\x1b\\",
            b"\x1b_Ga=T,f=99,s=1,v=1;AAAA\x1b\\",
            b"\x1b_Ga=T,U=1,f=24,s=1,v=1;AAAA\x1b\\",
            b"\x1b_Gm=1;AAAA\x1b\\\x1b_Ga=q,i=1,s=1,v=1,f=24;AAAA\x1b\\",
            b"\x1b]1337;File=:\x07",
            b"\x1b]1337;File=inline=1:!!!\x07",
            b"\x1b]1337;File=inline=1:AAAA\x1b\\",
            b"\x1b_Ga=d,d=?\x1b\\",
        ];
        for (n, bad) in junk.iter().enumerate() {
            let mut with = term();
            let mut plain = term();
            let mut input = b"abc\r\n".to_vec();
            input.extend_from_slice(bad);
            input.extend_from_slice(b"def\r\nghi");
            with.feed(&input);
            plain.feed(b"abc\r\ndef\r\nghi");
            assert_eq!(texts(&with), texts(&plain), "case {n}");
            assert_eq!(cursor(&with), cursor(&plain), "case {n}");
            assert!(with.snapshot().images.is_empty(), "case {n}");
        }
    }

    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.0 >> 33
        }

        fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
            &items[(self.next() % items.len() as u64) as usize]
        }
    }

    fn fuzz_stream(rng: &mut Lcg) -> Vec<u8> {
        let good_png = kitty_png("a=T", 18, 36);
        let good_iterm = iterm("inline=1", 18, 36);
        let pieces: Vec<&[u8]> = vec![
            b"text ",
            b"\r\n",
            b"\x1b",
            b"\x1b_",
            b"\x1b_G",
            b"\x1b\\",
            b"\x07",
            b"\x1b]",
            b"\x1b]1337;File=",
            b"\x1b]1337;",
            b"a=T,f=100,i=3",
            b"a=T,f=24,s=2,v=2",
            b"a=d,d=a",
            b"a=d,d=I,i=3",
            b"a=q,i=9",
            b"a=p,i=3,c=999999,r=999999",
            b"m=1,",
            b";AAAA",
            b";!!!",
            b"inline=1:",
            b"width=99999;height=-3",
            b"\x1b[2J",
            b"\x1b[?1049h",
            b"\x1b[?1049l",
            b"\x1b[?2026h",
            b"\x1b[?2026l",
            b"\x1b[5;5H",
            b"\x1bc",
            b"\xe7\x95",
            &good_png,
            &good_iterm,
        ];
        let mut out = Vec::new();
        for _ in 0..(rng.next() % 40 + 1) {
            if rng.next().is_multiple_of(9) {
                out.push((rng.next() % 256) as u8);
            } else {
                out.extend_from_slice(rng.pick(&pieces));
            }
        }
        out
    }

    #[test]
    fn fuzzed_streams_never_panic_and_split_reads_match_whole_reads() {
        let mut rng = Lcg(0x5eed);
        for round in 0..400 {
            let stream = fuzz_stream(&mut rng);
            let mut whole = term();
            let a = whole.feed(&stream);
            let cut = (rng.next() as usize) % (stream.len() + 1);
            let mut split = term();
            let mut b = split.feed(&stream[..cut]);
            b.extend(split.feed(&stream[cut..]));
            let mut bytewise = term();
            let mut c = Vec::new();
            for byte in &stream {
                c.extend(bytewise.feed(std::slice::from_ref(byte)));
            }
            assert_eq!(replies(&a), replies(&b), "round {round} cut {cut}");
            assert_eq!(replies(&a), replies(&c), "round {round} bytewise");
            assert_eq!(texts(&whole), texts(&split), "round {round} cut {cut}");
            assert_eq!(texts(&whole), texts(&bytewise), "round {round} bytewise");
            assert_eq!(cursor(&whole), cursor(&bytewise), "round {round}");
            assert_eq!(
                whole.snapshot().images.len(),
                bytewise.snapshot().images.len(),
                "round {round}"
            );
            whole.resize(size(7, 5));
            whole.snapshot();
            whole.resize(size(90, 30));
            whole.snapshot();
            whole.scroll(100);
            whole.snapshot();
            let stats = whole.image_stats();
            assert!(stats.bytes <= MAX_IMAGE_BYTES && stats.images <= MAX_IMAGES);
        }
    }
}
