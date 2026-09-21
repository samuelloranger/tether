import XCTest
@testable import TetherKit

final class TerminalGridTextTests: XCTestCase {
  private func cell(_ cp: UInt32) -> GridSnapshot.Cell {
    GridSnapshot.Cell(codepoint: cp, foreground: 0, background: 0, attrs: 0)
  }

  private func grid(cols: Int, rows: [[UInt32]]) -> ([GridSnapshot.Cell], GridSnapshot.Header) {
    var cells: [GridSnapshot.Cell] = []
    for r in 0..<rows.count {
      for c in 0..<cols {
        cells.append(cell(c < rows[r].count ? rows[r][c] : 0))
      }
    }
    let header = GridSnapshot.Header(
      cols: UInt16(cols), rows: UInt16(rows.count),
      cursorCol: 0, cursorRow: 0, generation: 0, cursorVisible: true)
    return (cells, header)
  }

  private func scalars(_ s: String) -> [UInt32] { s.unicodeScalars.map(\.value) }

  func test_joins_rows_and_preserves_interior_spaces() {
    let (cells, header) = grid(cols: 5, rows: [scalars("ab c"), scalars("xy")])
    XCTAssertEqual(TerminalGridText.plainText(header: header, cells: cells), "ab c\nxy")
  }

  func test_trims_trailing_spaces_per_row_and_drops_trailing_blank_rows() {
    let (cells, header) = grid(cols: 6, rows: [scalars("hi"), [], scalars("end"), [], []])
    // Trailing blank rows gone; "hi" padded with 0s (skipped) not spaces.
    XCTAssertEqual(TerminalGridText.plainText(header: header, cells: cells), "hi\n\nend")
  }

  func test_skips_wide_glyph_spacer_zero() {
    // 你(0x4F60) + spacer(0) + 好(0x597D) → no gap between the glyphs.
    let (cells, header) = grid(cols: 4, rows: [[0x4F60, 0, 0x597D, 0]])
    XCTAssertEqual(TerminalGridText.plainText(header: header, cells: cells), "你好")
  }

  func test_empty_or_undersized_grid_is_empty_string() {
    let header = GridSnapshot.Header(
      cols: 0, rows: 0, cursorCol: 0, cursorRow: 0, generation: 0, cursorVisible: true)
    XCTAssertEqual(TerminalGridText.plainText(header: header, cells: []), "")
  }
}
