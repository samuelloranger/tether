import CoreGraphics
import UIKit
import XCTest

@testable import TetherKit

/// The terminal does less work per byte without showing anything different.
final class TerminalRenderPacingTests: XCTestCase {
  // MARK: Engine: only marked rows are re-read

  /// After every step the grid built row by row must equal one built whole from the same bytes.
  func test_a_grid_rebuilt_from_marked_rows_matches_a_full_rebuild() {
    let steps = [
      "line one\r\nline two\r\nline three",
      "\u{1B}[2;1Hsecond row rewritten",
      "\u{1B}[1;3r\u{1B}[3;1H\r\nscrolled inside a region\u{1B}[r",
      "\u{1B}[5;1H\u{1B}[2L\u{1B}[1;31mred\u{1B}[0m",
      (0..<30).map { "flood \($0)" }.joined(separator: "\r\n"),
      "\u{1B}[H\u{1B}[2J",
      "\u{1B}[?1049htui\u{1B}[3;4Hx\u{1B}[?1049l",
      "\u{1B}]8;;https://example.test\u{1B}\\link\u{1B}]8;;\u{1B}\\ plain",
    ]
    let engine = TerminalEngine(cols: 30, rows: 8)
    var fed = Data()
    for step in steps {
      let bytes = Data(step.utf8)
      fed.append(bytes)
      engine.feed(bytes)
      let incremental = engine.frame()
      let whole = TerminalOutputBuffer(byteBudget: 1 << 20)
      whole.append(fed)
      let reference = whole.replay(cols: 30, rows: 8).frame()
      XCTAssertEqual(incremental.cells, reference.cells, "after: \(step.debugDescription)")
      XCTAssertEqual(incremental.hyperlinks.flatMap { $0 }, reference.hyperlinks.flatMap { $0 })
    }
  }

  func test_only_an_apc_can_carry_kitty_graphics() {
    XCTAssertTrue(TerminalEngine.mayCarryGraphics(Data("x\u{1B}_Ga=T;\u{1B}\\".utf8), afterEscape: false))
    XCTAssertTrue(TerminalEngine.mayCarryGraphics(Data("_Ga=T".utf8), afterEscape: true))
    XCTAssertFalse(TerminalEngine.mayCarryGraphics(Data("snake_case \u{1B}[1m".utf8), afterEscape: false))
  }

  // MARK: Pipeline: one grid per frame interval

  func test_a_burst_of_output_publishes_far_fewer_grids_and_ends_on_the_last_one() async throws {
    let pipeline = TerminalPipeline()
    await pipeline.attachForTest(cols: 40, rows: 5)
    for index in 0..<50 { await pipeline.feedPacedForTest(Data("chunk \(index)\r\n".utf8)) }
    try await Task.sleep(for: .milliseconds(60))
    let publishes = await pipeline.publishesForTest
    XCTAssertLessThan(publishes, 25, "one grid per chunk")
    let published = await pipeline.publishedGenerationForTest
    let latest = await pipeline.frameForTest()?.header.generation
    XCTAssertEqual(published, latest, "the trailing publish must carry the last chunk")
  }

  // MARK: Pipeline: the buffer replay waits for the settled size

  func test_a_keyboard_animation_rebuilds_once_when_it_settles() async {
    let pipeline = TerminalPipeline()
    await pipeline.attachForTest(cols: 40, rows: 10)
    await pipeline.feedForTest(Data("\u{1B}[?1049hfull screen".utf8))
    for rows in stride(from: 11, through: 20, by: 1) {
      await pipeline.resizeForTest(cols: 40, rows: UInt16(rows), settled: false)
    }
    let animating = await pipeline.rebuildsForTest
    XCTAssertEqual(animating, 0)
    await pipeline.resizeForTest(cols: 40, rows: 20, settled: true)
    let settled = await pipeline.rebuildsForTest
    XCTAssertEqual(settled, 1)
  }

  /// A keyboard dismiss that bounces back settles on the size it started from; the in-place
  /// resizes on the way still owe the replay.
  func test_a_size_that_goes_and_comes_back_still_rebuilds() async {
    let pipeline = TerminalPipeline()
    await pipeline.attachForTest(cols: 40, rows: 25)
    await pipeline.feedForTest(Data("\u{1B}[?1049hfull screen".utf8))
    await pipeline.resizeForTest(cols: 40, rows: 28, settled: false)
    await pipeline.resizeForTest(cols: 40, rows: 25, settled: false)
    await pipeline.resizeForTest(cols: 40, rows: 25, settled: true)
    let rebuilds = await pipeline.rebuildsForTest
    XCTAssertEqual(rebuilds, 1)
  }

  // MARK: Pipeline: blank rows are slack only until the program repaints

  func test_rows_grown_on_the_alt_screen_are_slack_until_output_after_the_settle() async {
    let pipeline = TerminalPipeline()
    await pipeline.attachForTest(cols: 40, rows: 10)
    await pipeline.feedForTest(Data("\u{1B}[?1049hfull screen".utf8))
    await pipeline.resizeForTest(cols: 40, rows: 14, settled: false)
    var trims = await pipeline.trimsBlankRowsForTest
    XCTAssertTrue(trims)
    await pipeline.feedForTest(Data("tick".utf8))
    trims = await pipeline.trimsBlankRowsForTest
    XCTAssertTrue(trims, "output from before the host saw the new size is not the repaint")
    await pipeline.resizeForTest(cols: 40, rows: 14, settled: true)
    await pipeline.feedForTest(Data("\u{1B}[Hrepainted".utf8))
    trims = await pipeline.trimsBlankRowsForTest
    XCTAssertFalse(trims)
  }

  func test_a_grow_that_settles_back_leaves_nothing_to_trim() async {
    let pipeline = TerminalPipeline()
    await pipeline.attachForTest(cols: 40, rows: 10)
    await pipeline.feedForTest(Data("\u{1B}[?1049hfull screen".utf8))
    await pipeline.resizeForTest(cols: 40, rows: 14, settled: false)
    await pipeline.resizeForTest(cols: 40, rows: 10, settled: false)
    await pipeline.resizeForTest(cols: 40, rows: 10, settled: true)
    let trims = await pipeline.trimsBlankRowsForTest
    XCTAssertFalse(trims)
  }

  // MARK: Renderer: a partial repaint draws what a full one would

  func test_repainting_only_the_changed_row_matches_a_full_repaint() throws {
    let cols = 12
    let rows = 3
    let metrics = metrics(cols: cols, rows: rows)
    let first = cells("first row   second row  third row   ", cols: cols, rows: rows)
    let second = cells("first row   CHANGED!    third row   ", cols: cols, rows: rows)
    let header = GridSnapshot.Header(cols: UInt16(cols), rows: UInt16(rows), cursorCol: 0, cursorRow: 0, generation: 1, cursorVisible: false)

    let reused = TerminalGridRenderer()
    _ = reused.render(header: header, cells: first, metrics: metrics)
    let partial = try XCTUnwrap(reused.render(header: header, cells: second, metrics: metrics))
    XCTAssertEqual(reused.repaintedRows, 1, "the partial path was not taken")
    let full = try XCTUnwrap(TerminalGridRenderer().render(header: header, cells: second, metrics: metrics))
    XCTAssertEqual(pixels(partial), pixels(full))
  }

  private func metrics(cols: Int, rows: Int) -> TerminalRenderMetrics {
    let font = UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)
    let bold = UIFont.monospacedSystemFont(ofSize: 14, weight: .bold)
    let cellWidth = ceil(("M" as NSString).size(withAttributes: [.font: font]).width)
    let cellHeight = ceil(font.lineHeight)
    return TerminalRenderMetrics(
      cellWidth: cellWidth, cellHeight: cellHeight,
      size: CGSize(width: cellWidth * CGFloat(cols), height: cellHeight * CGFloat(rows)),
      scale: 2, font: font, boldFont: bold, background: UIColor.black.cgColor)
  }

  private func cells(_ text: String, cols: Int, rows: Int) -> [GridSnapshot.Cell] {
    var cells = [GridSnapshot.Cell](
      repeating: GridSnapshot.Cell(codepoint: 0x20, foreground: 0xFFFF_FFFF, background: 0xFF00_0000, attrs: 0),
      count: cols * rows)
    for (index, scalar) in text.unicodeScalars.enumerated() where index < cells.count {
      cells[index].codepoint = scalar.value
    }
    return cells
  }

  private func pixels(_ image: CGImage) -> Data {
    let bytesPerRow = image.width * 4
    var data = Data(count: bytesPerRow * image.height)
    data.withUnsafeMutableBytes { buffer in
      let context = CGContext(
        data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
        bytesPerRow: bytesPerRow, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      context?.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    }
    return data
  }
}
