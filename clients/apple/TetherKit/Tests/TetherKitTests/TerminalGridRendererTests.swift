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

  private func metrics(cols: Int, rows: Int) -> TerminalRenderMetrics {
    let font = UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)
    let bold = UIFont.monospacedSystemFont(ofSize: 14, weight: .bold)
    let cellWidth = ceil(("M" as NSString).size(withAttributes: [.font: font]).width)
    let cellHeight = ceil(font.lineHeight)
    return TerminalRenderMetrics(
      cellWidth: cellWidth,
      cellHeight: cellHeight,
      size: CGSize(width: cellWidth * CGFloat(cols), height: cellHeight * CGFloat(rows)),
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

  private func header(cols: Int, rows: Int, generation: UInt64) -> GridSnapshot.Header {
    GridSnapshot.Header(
      cols: UInt16(cols),
      rows: UInt16(rows),
      cursorCol: 0,
      cursorRow: 0,
      generation: generation,
      cursorVisible: false
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
}
#endif
