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

final class TerminalEngineScreenTests: XCTestCase {
  private func altScreenBytes(cols: Int, rows: Int) -> String {
    var out = "\u{1B}[?1049h\u{1B}[2J"
    for row in 1...rows {
      let label = "R\(row)"
      out += "\u{1B}[\(row);1H" + label + String(repeating: "x", count: max(0, cols - label.count))
    }
    return out
  }

  func test_soft_wrapped_lines_rejoin_when_columns_grow() {
    let engine = TerminalEngine(cols: 20, rows: 8)
    // Cursor below the wrapped group: SwiftTerm (like xterm.js) leaves the
    // cursor's own line group for the shell to repaint on SIGWINCH.
    engine.feed("abcdefghijKLMNOPQRST")
    engine.feed("uvwxyz0123456789XXXX\r\n")
    XCTAssertEqual(rowText(engine.frame(), 0), "abcdefghijKLMNOPQRST")
    XCTAssertEqual(rowText(engine.frame(), 1), "uvwxyz0123456789XXXX")
    engine.resize(cols: 40, rows: 8)
    XCTAssertEqual(rowText(engine.frame(), 0), "abcdefghijKLMNOPQRSTuvwxyz0123456789XXXX")
    XCTAssertEqual(rowText(engine.frame(), 1), "")
  }

  func test_exact_width_line_plus_lf_does_not_right_shift_on_grow() {
    let engine = TerminalEngine(cols: 20, rows: 10)
    // \r\n as a PTY delivers it (onlcr); a bare LF keeps the column, per VT.
    engine.feed("abcdefghijKLMNOPQRST\r\n")
    engine.feed("uvwxyz0123456789XXXX\r\n")
    engine.resize(cols: 40, rows: 10)
    let frame = engine.frame()
    let cols = Int(frame.header.cols)
    var rows: [String] = []
    for r in 0..<3 {
      let raw = String(String.UnicodeScalarView(
        frame.cells[r * cols..<(r + 1) * cols].compactMap { Unicode.Scalar($0.codepoint) }))
      if raw.trimmingCharacters(in: .whitespaces).isEmpty { continue }
      XCTAssertFalse(raw.hasPrefix(" "), "row \(r) acquired leading spaces on grow: [\(raw)]")
      rows.append(rowText(frame, r))
    }
    XCTAssertTrue(rows.contains("abcdefghijKLMNOPQRST"))
    XCTAssertTrue(rows.contains("uvwxyz0123456789XXXX"))
  }

  func test_alt_screen_full_paint_fills_every_row() {
    let engine = TerminalEngine(cols: 20, rows: 8)
    engine.feed(altScreenBytes(cols: 20, rows: 8))
    XCTAssertEqual(rowText(engine.frame(), 0), "R1xxxxxxxxxxxxxxxxxx")
    XCTAssertEqual(rowText(engine.frame(), 7), "R8xxxxxxxxxxxxxxxxxx")
  }

  func test_alt_screen_sets_the_frame_flag() {
    let engine = TerminalEngine(cols: 20, rows: 8)
    XCTAssertFalse(engine.frame().header.altScreen)
    engine.feed("\u{1B}[?1049h")
    XCTAssertTrue(engine.frame().header.altScreen)
    XCTAssertTrue(engine.altScreen)
    engine.feed("\u{1B}[?1049l")
    XCTAssertFalse(engine.frame().header.altScreen)
  }

  // The pipeline's TerminalResizeStrategy depends on the next five. If one
  // fails, stop and report: the strategy may need to change, not the test.
  func test_alt_screen_resize_up_leaves_trailing_empty_rows() {
    let engine = TerminalEngine(cols: 20, rows: 8)
    engine.feed(altScreenBytes(cols: 20, rows: 8))
    engine.resize(cols: 20, rows: 12)
    let frame = engine.frame()
    XCTAssertEqual(frame.header.rows, 12)
    XCTAssertTrue(frame.header.altScreen)
    XCTAssertEqual(rowText(frame, 0), "R1xxxxxxxxxxxxxxxxxx")
    XCTAssertEqual(rowText(frame, 7), "R8xxxxxxxxxxxxxxxxxx")
    XCTAssertEqual(rowText(frame, 8), "")
    XCTAssertEqual(rowText(frame, 11), "")
  }

  func test_alt_screen_scroll_does_not_move_the_gap() {
    let engine = TerminalEngine(cols: 20, rows: 8)
    engine.feed(altScreenBytes(cols: 20, rows: 8))
    engine.resize(cols: 20, rows: 12)
    let before = engine.frame()
    engine.scrollViewport(lines: 40)
    engine.scrollViewport(lines: -40)
    let after = engine.frame()
    XCTAssertEqual(rowText(after, 0), rowText(before, 0))
    XCTAssertEqual(rowText(after, 11), "")
  }

  func test_alt_screen_repaint_at_new_size_fills_the_gap() {
    let engine = TerminalEngine(cols: 20, rows: 8)
    engine.feed(altScreenBytes(cols: 20, rows: 8))
    engine.resize(cols: 20, rows: 12)
    engine.feed(altScreenBytes(cols: 20, rows: 12))
    XCTAssertEqual(rowText(engine.frame(), 0), "R1xxxxxxxxxxxxxxxxxx")
    XCTAssertEqual(rowText(engine.frame(), 11), "R12xxxxxxxxxxxxxxxxx")
  }

  func test_alt_screen_replay_at_the_same_size_restores_the_last_row() {
    let engine = TerminalEngine(cols: 20, rows: 8)
    engine.feed(altScreenBytes(cols: 20, rows: 8))
    XCTAssertEqual(rowText(engine.frame(), 7), "R8xxxxxxxxxxxxxxxxxx")
  }

  func test_alt_screen_replay_into_a_shorter_grid_then_grow_drops_the_bottom() {
    let engine = TerminalEngine(cols: 20, rows: 8)
    engine.feed(altScreenBytes(cols: 20, rows: 12))
    XCTAssertEqual(rowText(engine.frame(), 0), "R1xxxxxxxxxxxxxxxxxx")
    XCTAssertEqual(rowText(engine.frame(), 7), "R12xxxxxxxxxxxxxxxxx")
    engine.resize(cols: 20, rows: 12)
    XCTAssertEqual(rowText(engine.frame(), 7), "R12xxxxxxxxxxxxxxxxx")
    XCTAssertEqual(rowText(engine.frame(), 11), "")
  }

  func test_zero_size_resize_is_ignored() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.feed("hi")
    engine.resize(cols: 0, rows: 5)
    engine.resize(cols: 20, rows: 0)
    XCTAssertEqual(engine.frame().header.cols, 20)
    XCTAssertEqual(engine.frame().header.rows, 5)
    XCTAssertEqual(rowText(engine.frame(), 0), "hi")
  }

  private func numbered(_ range: ClosedRange<Int>) -> String {
    range.map { "L\($0)" }.joined(separator: "\r\n") + "\r\n"
  }

  func test_scroll_viewport_moves_into_history_and_back() {
    let engine = TerminalEngine(cols: 20, rows: 5, scrollback: 100)
    engine.feed(numbered(1...30))
    XCTAssertEqual(rowText(engine.frame(), 0), "L27")
    engine.scrollViewport(lines: 10)
    XCTAssertEqual(rowText(engine.frame(), 0), "L17")
    engine.scrollViewport(lines: -10)
    XCTAssertEqual(rowText(engine.frame(), 0), "L27")
  }

  func test_scroll_clamps_at_history_top_and_live_bottom() {
    let engine = TerminalEngine(cols: 20, rows: 5, scrollback: 100)
    engine.feed(numbered(1...30))
    engine.scrollViewport(lines: 10_000)
    XCTAssertEqual(rowText(engine.frame(), 0), "L1")
    engine.scrollViewport(lines: -10_000)
    XCTAssertEqual(rowText(engine.frame(), 0), "L27")
  }

  func test_scroll_bumps_generation() {
    let engine = TerminalEngine(cols: 20, rows: 5, scrollback: 100)
    engine.feed(numbered(1...30))
    let before = engine.generation
    engine.scrollViewport(lines: 3)
    XCTAssertEqual(engine.generation, before + 1)
  }

  func test_scrolled_back_view_stays_on_the_same_lines_while_output_arrives() {
    let engine = TerminalEngine(cols: 20, rows: 5, scrollback: 100)
    engine.feed(numbered(1...30))
    engine.scrollViewport(lines: 10)
    XCTAssertEqual(rowText(engine.frame(), 0), "L17")
    engine.feed(numbered(31...33))
    XCTAssertEqual(rowText(engine.frame(), 0), "L17")
    engine.scrollViewport(lines: -10_000)
    XCTAssertEqual(rowText(engine.frame(), 0), "L30")
  }

  func test_pinned_view_survives_scrollback_trimming() {
    let engine = TerminalEngine(cols: 20, rows: 5, scrollback: 10)
    engine.feed(numbered(1...40))
    engine.scrollViewport(lines: 5)
    let pinned = rowText(engine.frame(), 0)
    engine.feed(numbered(41...43))
    XCTAssertEqual(rowText(engine.frame(), 0), pinned)
  }

  func test_resize_returns_the_view_to_live() {
    let engine = TerminalEngine(cols: 20, rows: 5, scrollback: 100)
    engine.feed(numbered(1...30))
    engine.scrollViewport(lines: 10)
    engine.resize(cols: 30, rows: 5)
    XCTAssertEqual(rowText(engine.frame(), 0), "L27")
  }
}

final class TerminalEngineReplyTests: XCTestCase {
  func test_cursor_position_report_is_answered() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.feed("\u{1B}[6n")
    XCTAssertEqual(String(decoding: engine.takeReplies(), as: UTF8.self), "\u{1B}[1;1R")
  }

  func test_primary_device_attributes_are_answered() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.feed("\u{1B}[c")
    XCTAssertTrue(String(decoding: engine.takeReplies(), as: UTF8.self).hasPrefix("\u{1B}[?"))
  }

  func test_take_drains_and_discard_drops() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.feed("\u{1B}[6n")
    XCTAssertFalse(engine.takeReplies().isEmpty)
    XCTAssertTrue(engine.takeReplies().isEmpty)
    engine.feed("\u{1B}[6n")
    engine.discardReplies()
    XCTAssertTrue(engine.takeReplies().isEmpty)
  }

  func test_plain_output_produces_no_replies() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.feed("hello\r\n\u{1B}[1mbold\u{1B}[0m")
    XCTAssertTrue(engine.takeReplies().isEmpty)
  }
}
