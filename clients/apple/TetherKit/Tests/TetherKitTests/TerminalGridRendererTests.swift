#if canImport(UIKit)
import CoreGraphics
import UIKit
import XCTest

@testable import TetherKit

/// Pixel-level checks on the rasterizer.
///
/// These exist because v3.2.1 shipped a terminal that drew nothing at all. Every
/// unit test passed: the run splitting was right, the diff was right, the glyph
/// ids were right. What was wrong was the coordinate space handed to
/// `CTFontDrawGlyphs` — positions are TEXT space, mapped through the text
/// matrix, so under a flipped matrix every glyph was drawn above the top of the
/// canvas. Nothing short of looking at the output catches that, so these tests
/// look at the output.
final class TerminalGridRendererTests: XCTestCase {
  private let background = UIColor.black.cgColor
  private let backgroundARGB: UInt32 = 0xFF00_0000
  private let foregroundARGB: UInt32 = 0xFFFF_FFFF

  private func metrics(cols: Int, rows: Int, viewRows: Int? = nil) -> TerminalRenderMetrics {
    let font = UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)
    let bold = UIFont.monospacedSystemFont(ofSize: 14, weight: .bold)
    let cellWidth = ceil(("M" as NSString).size(withAttributes: [.font: font]).width)
    let cellHeight = ceil(font.lineHeight)
    return TerminalRenderMetrics(
      cellWidth: cellWidth,
      cellHeight: cellHeight,
      size: CGSize(
        width: cellWidth * CGFloat(cols),
        height: cellHeight * CGFloat(viewRows ?? rows)
      ),
      scale: 2,
      font: font,
      boldFont: bold,
      background: background
    )
  }

  private func grid(_ text: String, cols: Int, rows: Int) -> [GridSnapshot.Cell] {
    var cells = [GridSnapshot.Cell](
      repeating: GridSnapshot.Cell(
        codepoint: 0x20,
        foreground: foregroundARGB,
        background: backgroundARGB,
        attrs: 0
      ),
      count: cols * rows
    )
    for (index, scalar) in text.unicodeScalars.enumerated() where index < cells.count {
      cells[index].codepoint = scalar.value
    }
    return cells
  }

  private func header(cols: Int, rows: Int, generation: UInt64, altScreen: Bool = false)
    -> GridSnapshot.Header
  {
    GridSnapshot.Header(
      cols: UInt16(cols),
      rows: UInt16(rows),
      cursorCol: 0,
      cursorRow: 0,
      generation: generation,
      cursorVisible: false,
      altScreen: altScreen
    )
  }

  /// Pixels that are not the background colour.
  private func inkedPixels(_ image: CGImage) -> Int {
    let width = image.width
    let height = image.height
    var raw = [UInt8](repeating: 0, count: width * height * 4)
    guard
      let context = CGContext(
        data: &raw,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      )
    else { return 0 }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

    var inked = 0
    for pixel in stride(from: 0, to: raw.count, by: 4) {
      // Anything lighter than pure black is glyph coverage.
      if raw[pixel] > 24 || raw[pixel + 1] > 24 || raw[pixel + 2] > 24 { inked += 1 }
    }
    return inked
  }

  func testGlyphsActuallyReachTheBitmap() {
    let renderer = TerminalGridRenderer()
    let cols = 8
    let rows = 2
    let image = renderer.render(
      header: header(cols: cols, rows: rows, generation: 1),
      cells: grid("HELLO", cols: cols, rows: rows),
      metrics: metrics(cols: cols, rows: rows)
    )
    let rendered = try? XCTUnwrap(image)
    XCTAssertNotNil(rendered)
    guard let rendered else { return }
    XCTAssertGreaterThan(
      inkedPixels(rendered), 0,
      "the grid rasterized to nothing but background — glyphs are being drawn off-surface"
    )
  }

  /// The blank grid is the control: without it, a test that "sees ink" could be
  /// passing on a bug that fills the surface with something else entirely.
  func testAnEmptyGridDrawsNoInk() {
    let renderer = TerminalGridRenderer()
    let cols = 8
    let rows = 2
    let image = renderer.render(
      header: header(cols: cols, rows: rows, generation: 1),
      cells: grid("", cols: cols, rows: rows),
      metrics: metrics(cols: cols, rows: rows)
    )
    guard let image else { return XCTFail("no image") }
    XCTAssertEqual(inkedPixels(image), 0)
  }

  /// Glyphs must land inside the row they belong to. An off-by-a-baseline bug
  /// can still put ink on the surface, just in the wrong row.
  func testGlyphsLandInTheirOwnRow() {
    let renderer = TerminalGridRenderer()
    let cols = 4
    let rows = 2
    let m = metrics(cols: cols, rows: rows)
    // Second row only.
    var cells = grid("", cols: cols, rows: rows)
    cells[cols].codepoint = 0x48  // 'H'
    guard
      let image = renderer.render(
        header: header(cols: cols, rows: rows, generation: 1), cells: cells, metrics: m
      )
    else { return XCTFail("no image") }

    let rowHeightPx = Int((m.cellHeight * m.scale).rounded())
    let width = image.width
    guard let top = image.cropping(to: CGRect(x: 0, y: 0, width: width, height: rowHeightPx)),
      let bottom = image.cropping(
        to: CGRect(x: 0, y: rowHeightPx, width: width, height: image.height - rowHeightPx)
      )
    else { return XCTFail("crop failed") }

    XCTAssertEqual(inkedPixels(top), 0, "ink bled into the empty first row")
    XCTAssertGreaterThan(inkedPixels(bottom), 0, "the second row's glyph never landed")
  }

  /// On the primary screen, empty rows under a prompt are the grid. They must
  /// stay at the bottom — pulling them up would move a new shell's prompt.
  func testEmptyTrailingRowsOnThePrimaryScreenStayAtTheBottom() {
    let renderer = TerminalGridRenderer()
    let cols = 8
    let rows = 8
    let filled = 5
    let m = metrics(cols: cols, rows: rows)
    var cells = grid("", cols: cols, rows: rows)
    for row in 0..<filled {
      cells[row * cols].codepoint = 0x48  // 'H'
    }
    guard
      let image = renderer.render(
        header: header(cols: cols, rows: rows, generation: 1), cells: cells, metrics: m
      )
    else { return XCTFail("no image") }

    let rowHeightPx = Int((m.cellHeight * m.scale).rounded())
    let gapTop = rowHeightPx * filled
    guard
      let gap = image.cropping(
        to: CGRect(x: 0, y: gapTop, width: image.width, height: image.height - gapTop)
      )
    else { return XCTFail("crop failed") }
    XCTAssertEqual(inkedPixels(gap), 0)
  }

  /// Alt-screen TUI after a grow: trailing empty rows are unpainted, not
  /// content. They must sit as slack against the title bar so the painted TUI
  /// stays on the key bar — otherwise the whole screen looks pushed up.
  func testAltScreenTrailingEmptyRowsSitAsSlackAtTheTop() {
    let renderer = TerminalGridRenderer()
    let cols = 8
    let rows = 8
    let filled = 5
    let m = metrics(cols: cols, rows: rows)
    var cells = grid("", cols: cols, rows: rows)
    for row in 0..<filled {
      cells[row * cols].codepoint = 0x48  // 'H'
    }
    guard
      let image = renderer.render(
        header: header(cols: cols, rows: rows, generation: 1, altScreen: true),
        cells: cells,
        metrics: m
      )
    else { return XCTFail("no image") }

    let rowHeightPx = Int((m.cellHeight * m.scale).rounded())
    let slack = rowHeightPx * (rows - filled)
    guard
      let top = image.cropping(to: CGRect(x: 0, y: 0, width: image.width, height: slack)),
      let content = image.cropping(
        to: CGRect(x: 0, y: slack, width: image.width, height: image.height - slack)
      )
    else { return XCTFail("crop failed") }
    XCTAssertEqual(inkedPixels(top), 0, "unpainted alt-screen rows must not occupy the bottom")
    XCTAssertGreaterThan(inkedPixels(content), 0, "the painted TUI never landed")
  }

  /// When the snapshot has fewer rows than the view, slack belongs at the TOP
  /// (against the title bar), not under the last line. A regression here is
  /// the other way to get a gap at the bottom: content top-aligned in a tall view.
  func testAShortGridInATallViewPutsSlackAtTheTop() {
    let renderer = TerminalGridRenderer()
    let cols = 8
    let gridRows = 5
    let viewRows = 8
    let m = metrics(cols: cols, rows: gridRows, viewRows: viewRows)
    var cells = grid("", cols: cols, rows: gridRows)
    cells[0].codepoint = 0x48  // 'H' on the first grid row
    guard
      let image = renderer.render(
        header: header(cols: cols, rows: gridRows, generation: 1), cells: cells, metrics: m
      )
    else { return XCTFail("no image") }

    let rowHeightPx = Int((m.cellHeight * m.scale).rounded())
    let slack = rowHeightPx * (viewRows - gridRows)
    guard
      let top = image.cropping(to: CGRect(x: 0, y: 0, width: image.width, height: slack)),
      let content = image.cropping(
        to: CGRect(x: 0, y: slack, width: image.width, height: image.height - slack)
      )
    else { return XCTFail("crop failed") }
    XCTAssertEqual(inkedPixels(top), 0, "slack must sit above the grid, not below it")
    XCTAssertGreaterThan(inkedPixels(content), 0, "the short grid's glyph never landed")
  }
}
#endif
