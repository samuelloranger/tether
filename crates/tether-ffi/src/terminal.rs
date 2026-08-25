//! UniFFI wrapper over the core terminal parser.

use std::sync::{Arc, Mutex};

use tether_core::terminal::{AlacrittyParser, TerminalParser, TerminalSnapshot};

use crate::grid_snapshot::{encode_grid_snapshot, GridCell, GridSnapshotHeader};

#[derive(uniffi::Object)]
pub struct FfiTerminalEmulator {
    inner: Mutex<AlacrittyParser>,
}

#[uniffi::export]
impl FfiTerminalEmulator {
    #[uniffi::constructor]
    pub fn new(cols: u16, rows: u16) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(AlacrittyParser::new(cols, rows)),
        })
    }

    pub fn feed(&self, bytes: Vec<u8>) {
        self.inner.lock().expect("terminal lock").feed(&bytes);
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        self.inner.lock().expect("terminal lock").resize(cols, rows);
    }

    pub fn scroll_viewport(&self, lines: i32) {
        self.inner
            .lock()
            .expect("terminal lock")
            .scroll_viewport(lines);
    }

    pub fn generation(&self) -> u64 {
        self.inner.lock().expect("terminal lock").generation()
    }

    /// Packed TGRD bytes for the current visible grid.
    pub fn snapshot(&self) -> Vec<u8> {
        let parser = self.inner.lock().expect("terminal lock");
        encode_snapshot(&parser.snapshot())
    }
}

fn encode_snapshot(snapshot: &TerminalSnapshot) -> Vec<u8> {
    let header = GridSnapshotHeader {
        cols: snapshot.cols,
        rows: snapshot.rows,
        cursor_col: snapshot.cursor_col,
        cursor_row: snapshot.cursor_row,
        generation: snapshot.generation,
        cursor_visible: snapshot.cursor_visible,
    };
    let cells = snapshot
        .cells
        .iter()
        .map(|cell| GridCell {
            codepoint: cell.codepoint,
            fg: cell.fg,
            bg: cell.bg,
            attrs: cell.attrs,
        })
        .collect::<Vec<_>>();
    encode_grid_snapshot(header, &cells)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid_snapshot::{decode_grid_snapshot, GRID_ATTR_BOLD};

    #[test]
    fn snapshot_round_trips_through_tgrd() {
        let emulator = FfiTerminalEmulator::new(20, 5);
        emulator.feed(b"\x1b[1mHi\x1b[0m".to_vec());
        let packed = emulator.snapshot();
        let (header, cells) = decode_grid_snapshot(&packed).expect("decode TGRD");
        assert_eq!(header.generation, emulator.generation());
        assert_eq!(cells[0].codepoint, b'H' as u32);
        assert_eq!(cells[0].attrs & GRID_ATTR_BOLD, GRID_ATTR_BOLD);
        assert_eq!(cells[1].codepoint, b'i' as u32);
    }

    #[test]
    fn wide_char_round_trips_in_tgrd() {
        let emulator = FfiTerminalEmulator::new(20, 5);
        emulator.feed("\u{4f60}".as_bytes().to_vec());
        let (_header, cells) = decode_grid_snapshot(&emulator.snapshot()).expect("decode");
        assert_eq!(cells[0].codepoint, '\u{4f60}' as u32);
        assert_eq!(cells[1].codepoint, b' ' as u32);
    }
}
