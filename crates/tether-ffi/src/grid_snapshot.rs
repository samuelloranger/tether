//! Packed terminal grid buffer crossing the UniFFI boundary.
//!
//! Layout (little-endian):
//! ```text
//! [24-byte header][cols * rows * 16-byte cells]
//!
//! Header:
//!   magic:          u32  0x5447_5244 ("TGRD")
//!   version:        u16  1
//!   cols:           u16
//!   rows:           u16
//!   cursor_col:     u16
//!   cursor_row:     u16
//!   generation:     u64  monotonic; shell skips redraw when unchanged
//!   flags:          u16  bit 0 = cursor visible; remainder reserved
//!
//! Cell (16 bytes):
//!   codepoint: u32  Unicode scalar value (space for empty)
//!   fg:        u32  0xAARRGGBB
//!   bg:        u32  0xAARRGGBB
//!   attrs:     u32  bit flags — see GRID_ATTR_*
//! ```

use thiserror::Error;

pub const GRID_SNAPSHOT_MAGIC: u32 = 0x5447_5244; // "TGRD"
pub const GRID_SNAPSHOT_VERSION: u16 = 1;
pub const GRID_HEADER_SIZE: usize = 24;
pub const GRID_CELL_STRIDE: usize = 16;

pub const GRID_FLAG_CURSOR_VISIBLE: u16 = 1 << 0;
pub const GRID_ATTR_BOLD: u32 = 1 << 0;
pub const GRID_ATTR_ITALIC: u32 = 1 << 1;
pub const GRID_ATTR_UNDERLINE: u32 = 1 << 2;
pub const GRID_ATTR_INVERSE: u32 = 1 << 3;
pub const GRID_ATTR_DIM: u32 = 1 << 4;
pub const GRID_ATTR_STRIKETHROUGH: u32 = 1 << 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct GridSnapshotHeader {
    pub cols: u16,
    pub rows: u16,
    pub cursor_col: u16,
    pub cursor_row: u16,
    pub generation: u64,
    pub cursor_visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct GridCell {
    pub codepoint: u32,
    pub fg: u32,
    pub bg: u32,
    pub attrs: u32,
}

#[derive(Debug, Error, uniffi::Error)]
pub enum GridSnapshotError {
    #[error("buffer too short for header")]
    TooShort,
    #[error("invalid magic")]
    BadMagic,
    #[error("unsupported version {version}")]
    BadVersion { version: u16 },
    #[error("buffer length {len} does not match {cols}x{rows} grid")]
    SizeMismatch { len: u64, cols: u16, rows: u16 },
}

#[uniffi::export]
pub fn terminal_grid_buffer_size(cols: u16, rows: u16) -> u64 {
    grid_snapshot_buffer_size(cols, rows)
}

#[uniffi::export]
pub fn encode_terminal_grid_snapshot(header: GridSnapshotHeader, cells: Vec<GridCell>) -> Vec<u8> {
    encode_grid_snapshot(header, &cells)
}

#[uniffi::export]
pub fn decode_terminal_grid_snapshot(
    bytes: Vec<u8>,
) -> Result<GridSnapshotHeader, GridSnapshotError> {
    decode_grid_snapshot(&bytes).map(|(header, _cells)| header)
}

#[uniffi::export]
pub fn decode_terminal_grid_cells(bytes: Vec<u8>) -> Result<Vec<GridCell>, GridSnapshotError> {
    decode_grid_snapshot(&bytes).map(|(_header, cells)| cells)
}

pub fn grid_snapshot_buffer_size(cols: u16, rows: u16) -> u64 {
    GRID_HEADER_SIZE as u64 + u64::from(cols) * u64::from(rows) * GRID_CELL_STRIDE as u64
}

pub fn encode_grid_snapshot(header: GridSnapshotHeader, cells: &[GridCell]) -> Vec<u8> {
    let expected = usize::try_from(grid_snapshot_buffer_size(header.cols, header.rows))
        .expect("grid dimensions fit in host address space");
    let cell_bytes = expected - GRID_HEADER_SIZE;
    let mut out = Vec::with_capacity(expected);
    out.extend_from_slice(&GRID_SNAPSHOT_MAGIC.to_le_bytes());
    out.extend_from_slice(&GRID_SNAPSHOT_VERSION.to_le_bytes());
    out.extend_from_slice(&header.cols.to_le_bytes());
    out.extend_from_slice(&header.rows.to_le_bytes());
    out.extend_from_slice(&header.cursor_col.to_le_bytes());
    out.extend_from_slice(&header.cursor_row.to_le_bytes());
    out.extend_from_slice(&header.generation.to_le_bytes());
    let flags = u16::from(header.cursor_visible) & GRID_FLAG_CURSOR_VISIBLE;
    out.extend_from_slice(&flags.to_le_bytes());

    let mut cell_out = vec![0_u8; cell_bytes];
    for (index, cell) in cells.iter().enumerate() {
        let offset = index * GRID_CELL_STRIDE;
        if offset + GRID_CELL_STRIDE > cell_out.len() {
            break;
        }
        cell_out[offset..offset + 4].copy_from_slice(&cell.codepoint.to_le_bytes());
        cell_out[offset + 4..offset + 8].copy_from_slice(&cell.fg.to_le_bytes());
        cell_out[offset + 8..offset + 12].copy_from_slice(&cell.bg.to_le_bytes());
        cell_out[offset + 12..offset + 16].copy_from_slice(&cell.attrs.to_le_bytes());
    }
    out.extend(cell_out);
    out
}

pub fn decode_grid_snapshot(
    bytes: &[u8],
) -> Result<(GridSnapshotHeader, Vec<GridCell>), GridSnapshotError> {
    if bytes.len() < GRID_HEADER_SIZE {
        return Err(GridSnapshotError::TooShort);
    }
    let magic = u32::from_le_bytes(bytes[0..4].try_into().expect("four bytes"));
    if magic != GRID_SNAPSHOT_MAGIC {
        return Err(GridSnapshotError::BadMagic);
    }
    let version = u16::from_le_bytes(bytes[4..6].try_into().expect("two bytes"));
    if version != GRID_SNAPSHOT_VERSION {
        return Err(GridSnapshotError::BadVersion { version });
    }
    let cols = u16::from_le_bytes(bytes[6..8].try_into().expect("two bytes"));
    let rows = u16::from_le_bytes(bytes[8..10].try_into().expect("two bytes"));
    let cursor_col = u16::from_le_bytes(bytes[10..12].try_into().expect("two bytes"));
    let cursor_row = u16::from_le_bytes(bytes[12..14].try_into().expect("two bytes"));
    let generation = u64::from_le_bytes(bytes[14..22].try_into().expect("eight bytes"));
    let flags = u16::from_le_bytes(bytes[22..24].try_into().expect("two bytes"));
    let cursor_visible = flags & GRID_FLAG_CURSOR_VISIBLE != 0;

    let expected = grid_snapshot_buffer_size(cols, rows) as usize;
    if bytes.len() != expected {
        return Err(GridSnapshotError::SizeMismatch {
            len: bytes.len() as u64,
            cols,
            rows,
        });
    }

    let header = GridSnapshotHeader {
        cols,
        rows,
        cursor_col,
        cursor_row,
        generation,
        cursor_visible,
    };

    let cell_count = usize::from(cols) * usize::from(rows);
    let mut cells = Vec::with_capacity(cell_count);
    for index in 0..cell_count {
        let offset = GRID_HEADER_SIZE + index * GRID_CELL_STRIDE;
        cells.push(GridCell {
            codepoint: u32::from_le_bytes(
                bytes[offset..offset + 4].try_into().expect("four bytes"),
            ),
            fg: u32::from_le_bytes(
                bytes[offset + 4..offset + 8]
                    .try_into()
                    .expect("four bytes"),
            ),
            bg: u32::from_le_bytes(
                bytes[offset + 8..offset + 12]
                    .try_into()
                    .expect("four bytes"),
            ),
            attrs: u32::from_le_bytes(
                bytes[offset + 12..offset + 16]
                    .try_into()
                    .expect("four bytes"),
            ),
        });
    }
    Ok((header, cells))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_200_by_60_viewport_in_the_expected_size() {
        let cols = 200;
        let rows = 60;
        let cells = vec![
            GridCell {
                codepoint: b'A' as u32,
                fg: 0xff_cc_cc_cc,
                bg: 0xff_1e_1e_2e,
                attrs: GRID_ATTR_BOLD,
            };
            cols as usize * rows as usize
        ];
        let header = GridSnapshotHeader {
            cols,
            rows,
            cursor_col: 4,
            cursor_row: 2,
            generation: 99,
            cursor_visible: true,
        };
        let encoded = encode_grid_snapshot(header, &cells);
        assert_eq!(
            encoded.len(),
            grid_snapshot_buffer_size(cols, rows) as usize
        );
        let (decoded_header, decoded_cells) = decode_grid_snapshot(&encoded).unwrap();
        assert_eq!(decoded_header, header);
        assert_eq!(decoded_cells.len(), 12_000);
        assert_eq!(decoded_cells[0].codepoint, b'A' as u32);
        assert_eq!(decoded_cells[0].attrs, GRID_ATTR_BOLD);
    }

    #[test]
    fn round_trips_an_empty_grid() {
        let header = GridSnapshotHeader {
            cols: 80,
            rows: 24,
            cursor_col: 0,
            cursor_row: 0,
            generation: 1,
            cursor_visible: false,
        };
        let cells = vec![
            GridCell {
                codepoint: b' ' as u32,
                fg: 0xff_00_00_00,
                bg: 0xff_ff_ff_ff,
                attrs: 0,
            };
            80 * 24
        ];
        let encoded = encode_grid_snapshot(header, &cells);
        let (decoded_header, decoded_cells) = decode_grid_snapshot(&encoded).unwrap();
        assert_eq!(decoded_header, header);
        assert_eq!(decoded_cells.len(), 80 * 24);
    }

    #[test]
    fn rejects_truncated_and_mismatched_buffers() {
        let err = decode_grid_snapshot(&[0_u8; 8]).unwrap_err();
        assert!(matches!(err, GridSnapshotError::TooShort));
        let mut bad_magic = vec![0_u8; GRID_HEADER_SIZE];
        bad_magic[0..4].copy_from_slice(&0xdead_beef_u32.to_le_bytes());
        assert!(matches!(
            decode_grid_snapshot(&bad_magic).unwrap_err(),
            GridSnapshotError::BadMagic
        ));
    }
}
