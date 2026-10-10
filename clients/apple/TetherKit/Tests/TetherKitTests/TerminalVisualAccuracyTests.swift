import CoreGraphics
import UIKit
import XCTest

@testable import TetherKit

/// What a real terminal shows, cell for cell.
final class TerminalVisualAccuracyTests: XCTestCase {
  private func frame(_ bytes: String, cols: UInt16 = 20, rows: UInt16 = 4) -> TerminalFrame {
    let engine = TerminalEngine(cols: cols, rows: rows)
    engine.feed(Data(bytes.utf8))
    return engine.frame()
  }

  private func text(_ frame: TerminalFrame, row: Int = 0) -> String {
    TerminalRunBuilder.rowTexts(
      cells: frame.cells, cols: Int(frame.header.cols), rows: Int(frame.header.rows), clusters: frame.clusters)[row]
  }

  // MARK: Graphemes and wide glyphs

  func test_a_zwj_emoji_keeps_every_scalar() {
    let family = "👨‍👩‍👧"
    let shown = frame(family)
    XCTAssertEqual(shown.clusters[0], family)
    XCTAssertEqual(TerminalSelection(startRow: 0, startCol: 0, endRow: 0, endCol: 5).text(from: [text(shown)]), family)
  }

  func test_a_flag_is_one_cluster_not_one_letter() {
    let flag = "🇨🇦"
    XCTAssertEqual(frame(flag).clusters[0], flag)
  }

  func test_copied_cjk_has_no_space_after_each_character() {
    let shown = frame("你好")
    XCTAssertNotEqual(shown.cells[0].attrs & GridSnapshot.attrWide, 0)
    XCTAssertNotEqual(shown.cells[1].attrs & GridSnapshot.attrWideTail, 0)
    XCTAssertEqual(TerminalSelection(startRow: 0, startCol: 0, endRow: 0, endCol: 3).text(from: [text(shown)]), "你好")
    XCTAssertEqual(TerminalGridText.plainText(header: shown.header, cells: shown.cells, clusters: shown.clusters), "你好")
  }

  func test_the_cursor_on_a_wide_glyph_covers_both_cells() {
    let shown = frame("你\u{1B}[2D")
    XCTAssertTrue(shown.header.cursorWide)
  }

  // MARK: SGR

  func test_concealed_text_draws_no_glyph() {
    let cell = frame("\u{1B}[8mx").cells[0]
    XCTAssertNotEqual(cell.attrs & GridSnapshot.attrHidden, 0)
    XCTAssertTrue(TerminalRunBuilder.isBlank(cell))
  }

  func test_underline_style_and_colour_are_kept() {
    let cell = frame("\u{1B}[4:3m\u{1B}[58:2::255:0:0mx").cells[0]
    XCTAssertEqual(GridSnapshot.underlineStyle(cell.attrs), .curly)
    XCTAssertEqual(cell.underlineColor, 0xFFFF_0000)
  }

  func test_a_plain_underline_is_single() {
    XCTAssertEqual(GridSnapshot.underlineStyle(frame("\u{1B}[4mx").cells[0].attrs), .single)
  }

  func test_an_underline_carries_across_spaces() {
    let shown = frame("\u{1B}[4ma b\u{1B}[0m")
    let spans = TerminalRunBuilder.decorations(cells: shown.cells, rowStart: 0, cols: 20)
    XCTAssertEqual(spans.count, 1)
    XCTAssertEqual(spans.first?.length, 3)
  }

  // MARK: OSC 10/11/12

  func test_a_program_can_set_and_restore_the_default_background() {
    let engine = TerminalEngine(cols: 10, rows: 2)
    engine.feed(Data("\u{1B}]11;rgb:ff/00/00\u{1B}\\".utf8))
    XCTAssertEqual(engine.frame().defaultBackground, 0xFFFF_0000)
    XCTAssertEqual(engine.frame().cells[5].background, 0xFFFF_0000)
    engine.feed(Data("\u{1B}]111\u{1B}\\".utf8))
    XCTAssertEqual(engine.frame().defaultBackground, TerminalTheme.tether.background)
  }

  func test_a_program_can_set_the_cursor_colour() {
    let engine = TerminalEngine(cols: 10, rows: 2)
    engine.feed(Data("\u{1B}]12;rgb:00/ff/00\u{1B}\\".utf8))
    XCTAssertEqual(engine.frame().header.cursorColor, 0xFF00_FF00)
  }

  // MARK: Geometry

  func test_the_grid_starts_on_a_device_pixel() {
    let origin = TerminalGridInset.originX(viewWidth: 393, cellWidth: 8.4, cols: 44, padding: 8, scale: 3)
    XCTAssertEqual(origin * 3, (origin * 3).rounded(), accuracy: 1e-9)
  }

  func test_cell_sizes_are_whole_device_pixels() {
    XCTAssertEqual(TerminalLineSpacing.cellWidth(advance: 8.43, scale: 3) * 3, 26, accuracy: 1e-9)
    XCTAssertEqual(TerminalLineSpacing.cellHeight(lineHeight: 16.7, spacing: 1, scale: 3) * 3, 51, accuracy: 1e-9)
  }

  func test_a_selection_follows_its_text_up_the_screen() {
    let selection = TerminalSelection(startRow: 5, startCol: 0, endRow: 6, endCol: 3)
    XCTAssertEqual(selection.shifted(up: 2), TerminalSelection(startRow: 3, startCol: 0, endRow: 4, endCol: 3))
  }

  // MARK: Box drawing

  /// Two horizontal lines side by side must meet: from the font they left a gap per cell.
  func test_box_drawing_lines_join_across_cells() throws {
    let cols = 4
    let font = UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)
    let cellWidth: CGFloat = 9
    let cellHeight: CGFloat = 17
    let metrics = TerminalRenderMetrics(
      cellWidth: cellWidth, cellHeight: cellHeight,
      size: CGSize(width: cellWidth * CGFloat(cols), height: cellHeight),
      scale: 2, font: font, boldFont: font, background: UIColor.black.cgColor)
    var cells = [GridSnapshot.Cell](
      repeating: GridSnapshot.Cell(codepoint: 0x2500, foreground: 0xFFFF_FFFF, background: 0xFF00_0000, attrs: 0),
      count: cols)
    cells[3].codepoint = 0x20
    let header = GridSnapshot.Header(cols: UInt16(cols), rows: 1, cursorCol: 0, cursorRow: 0, generation: 1, cursorVisible: false)
    let image = try XCTUnwrap(TerminalGridRenderer().render(header: header, cells: cells, metrics: metrics))
    let inkedColumns = inkedColumnsThroughTheMiddleRow(image)
    // Three cells of line, unbroken: every device pixel column of them is inked somewhere mid-row.
    XCTAssertEqual(inkedColumns.prefix(Int(cellWidth * 3 * 2)).filter { !$0 }.count, 0)
    XCTAssertTrue(inkedColumns.suffix(Int(cellWidth * 2) - 2).allSatisfy { !$0 }, "the blank cell stays blank")
  }

  private func inkedColumnsThroughTheMiddleRow(_ image: CGImage) -> [Bool] {
    let width = image.width
    let height = image.height
    var data = [UInt8](repeating: 0, count: width * height * 4)
    data.withUnsafeMutableBytes { buffer in
      let context = CGContext(
        data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      context?.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    }
    return (0..<width).map { x in
      (height / 2 - 2...height / 2 + 2).contains { y in data[(y * width + x) * 4] > 128 }
    }
  }
}
