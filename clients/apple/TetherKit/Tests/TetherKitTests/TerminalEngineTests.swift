import XCTest
@testable import TetherKit

func rowText(_ frame: TerminalFrame, _ row: Int) -> String {
  let cols = Int(frame.header.cols)
  let scalars = frame.cells[row * cols..<(row + 1) * cols].compactMap { Unicode.Scalar($0.codepoint) }
  var text = String(String.UnicodeScalarView(scalars))
  while text.last == " " { text.removeLast() }
  return text
}

extension TerminalEngine {
  func feed(_ text: String) { feed(Data(text.utf8)) }
}

final class TerminalEngineTests: XCTestCase {
  func test_plain_text_lands_on_row_zero() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.feed("hello")
    XCTAssertEqual(rowText(engine.frame(), 0), "hello")
  }

  func test_truecolor_sgr_sets_foreground() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.feed("\u{1B}[38;2;255;0;0mR\u{1B}[0m")
    let cell = engine.frame().cells[0]
    XCTAssertEqual(cell.codepoint, UInt32(UInt8(ascii: "R")))
    XCTAssertEqual(cell.foreground, 0xFFFF_0000)
  }

  func test_blank_cells_use_the_theme() {
    let engine = TerminalEngine(cols: 4, rows: 2)
    XCTAssertEqual(engine.frame().cells[0], TerminalPalette.blankCell)
  }

  func test_bold_and_wide_char_occupy_two_columns() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.feed("\u{1B}[1mAB\u{1B}[0m\u{4F60}")
    let cells = engine.frame().cells
    XCTAssertEqual(cells[0].codepoint, 0x41)
    XCTAssertEqual(cells[0].attrs & GridSnapshot.attrBold, GridSnapshot.attrBold)
    XCTAssertEqual(cells[1].codepoint, 0x42)
    XCTAssertEqual(cells[2].codepoint, 0x4F60)
    XCTAssertEqual(cells[3].codepoint, 0x20)
  }

  func test_combining_mark_nfc_composes_into_one_codepoint() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.feed("e\u{0301}")
    let frame = engine.frame()
    XCTAssertEqual(frame.cells[0].codepoint, 0xE9)
    XCTAssertEqual(frame.cells[1].codepoint, 0x20)
    XCTAssertEqual(rowText(frame, 0), "é")
  }

  func test_utf8_split_across_feeds_lands_in_one_cell() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    let bytes = Array("\u{4F60}".utf8)
    engine.feed(Data(bytes[0..<1]))
    engine.feed(Data(bytes[1...]))
    XCTAssertEqual(engine.frame().cells[0].codepoint, 0x4F60)
  }

  func test_zwj_emoji_reduces_to_first_scalar() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.feed("\u{1F468}\u{200D}\u{1F469}x")
    let cells = engine.frame().cells
    XCTAssertEqual(cells[0].codepoint, 0x1F468)
    XCTAssertTrue(rowText(engine.frame(), 0).hasSuffix("x"))
  }

  func test_style_bits_map_to_grid_attrs() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.feed("\u{1B}[3;4;7;2;9mS")
    let attrs = engine.frame().cells[0].attrs
    for bit in [GridSnapshot.attrItalic, GridSnapshot.attrUnderline, GridSnapshot.attrInverse,
                GridSnapshot.attrDim, GridSnapshot.attrStrikethrough] {
      XCTAssertEqual(attrs & bit, bit)
    }
  }

  func test_bracketed_paste_tracks_decset_2004() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    XCTAssertFalse(engine.bracketedPaste)
    engine.feed("\u{1B}[?2004h")
    XCTAssertTrue(engine.bracketedPaste)
    engine.feed("\u{1B}[?2004l")
    XCTAssertFalse(engine.bracketedPaste)
  }

  func test_paste_payload_follows_the_programs_mode() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    XCTAssertEqual(engine.pastePayload("hi"), "hi")
    engine.feed("\u{1B}[?2004h")
    XCTAssertEqual(engine.pastePayload("hi"), "\u{1B}[200~hi\u{1B}[201~")
  }

  func test_paste_payload_strips_embedded_markers() {
    let hostile = "echo safe\u{1B}[201~\nrm -rf /\n"
    XCTAssertEqual(PastePayload.make(hostile, bracketed: true), "\u{1B}[200~echo safe\nrm -rf /\n\u{1B}[201~")
    XCTAssertEqual(PastePayload.make(hostile, bracketed: false), "echo safe\nrm -rf /\n")
  }

  func test_mouse_mode_tracks_decset_1000_family() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    XCTAssertEqual(engine.mouseMode, .off)
    XCTAssertFalse(engine.mouseSgr)
    engine.feed("\u{1B}[?1000h")
    XCTAssertEqual(engine.mouseMode, .normal)
    engine.feed("\u{1B}[?1002h")
    XCTAssertEqual(engine.mouseMode, .button)
    engine.feed("\u{1B}[?1003h")
    XCTAssertEqual(engine.mouseMode, .any)
    engine.feed("\u{1B}[?1006h")
    XCTAssertTrue(engine.mouseSgr)
    engine.feed("\u{1B}[?1000l\u{1B}[?1002l\u{1B}[?1003l\u{1B}[?1006l")
    XCTAssertEqual(engine.mouseMode, .off)
    XCTAssertFalse(engine.mouseSgr)
  }

  func test_generation_increments_when_visible_grid_changes() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    XCTAssertEqual(engine.generation, 0)
    engine.feed("x")
    XCTAssertEqual(engine.generation, 1)
    engine.feed("y")
    XCTAssertEqual(engine.generation, 2)
  }

  func test_generation_does_not_increment_on_no_op_feed() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.feed("hi")
    XCTAssertEqual(engine.generation, 1)
    engine.feed("\u{07}")
    XCTAssertEqual(engine.generation, 1)
    engine.feed("\u{1B}[?25h")
    XCTAssertEqual(engine.generation, 1)
    engine.feed(Data())
    XCTAssertEqual(engine.generation, 1)
  }

  func test_cursor_visibility_change_bumps_generation() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.feed("hi\u{1B}[?25l")
    let hidden = engine.generation
    XCTAssertGreaterThanOrEqual(hidden, 1)
    XCTAssertFalse(engine.frame().header.cursorVisible)
    engine.feed("\u{1B}[?25h")
    XCTAssertEqual(engine.generation, hidden + 1)
    XCTAssertTrue(engine.frame().header.cursorVisible)
  }

  func test_frame_header_carries_generation_and_cursor() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.feed("abc")
    let header = engine.frame().header
    XCTAssertEqual(header.generation, engine.generation)
    XCTAssertEqual(header.cursorCol, 3)
    XCTAssertEqual(header.cursorRow, 0)
    XCTAssertEqual(header.cols, 20)
    XCTAssertEqual(header.rows, 5)
  }
}
