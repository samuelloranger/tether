import CoreGraphics
import UIKit
import XCTest

@testable import TetherKit

/// Both sessions start at generation 1, so without `reset()` the new session's first frame
/// looks like a duplicate and the surface stays on the previous session.
final class TerminalRenderWorkerSwitchTests: XCTestCase {
  func testWithoutResetANewSessionWithTheSameGenerationIsDropped() {
    let worker = TerminalRenderWorker()
    let m = metrics(cols: 4, rows: 2)
    let first = worker.render(frame: grid("AAAA", cols: 4, rows: 2, generation: 1), metrics: m)
    XCTAssertEqual(first?.rowTexts.first, "AAAA")

    let second = worker.render(frame: grid("BBBB", cols: 4, rows: 2, generation: 1), metrics: m)
    XCTAssertNil(
      second,
      "a generation collision must not paint the new session over the old one without reset"
    )
  }

  func testAfterResetTheNewSessionsFirstFramePaints() {
    let worker = TerminalRenderWorker()
    let m = metrics(cols: 4, rows: 2)
    _ = worker.render(frame: grid("AAAA", cols: 4, rows: 2, generation: 1), metrics: m)
    worker.reset()
    let second = worker.render(frame: grid("BBBB", cols: 4, rows: 2, generation: 1), metrics: m)
    XCTAssertEqual(
      second?.rowTexts.first,
      "BBBB",
      "clearSnapshot's reset is what lets the next session's generation-1 frame show"
    )
  }

  func testAfterForgettingGenerationTheNewSessionsFirstFramePaints() {
    let worker = TerminalRenderWorker()
    let m = metrics(cols: 4, rows: 2)
    _ = worker.render(frame: grid("AAAA", cols: 4, rows: 2, generation: 1), metrics: m)
    worker.forgetGeneration()
    let second = worker.render(frame: grid("BBBB", cols: 4, rows: 2, generation: 1), metrics: m)
    XCTAssertEqual(
      second?.rowTexts.first,
      "BBBB",
      "a session change without clearSnapshot still has to accept generation 1"
    )
  }

  /// If the `metrics == lastMetrics` guard regresses, a pinch-zoom with no new output freezes.
  func testMetricsChangeAtSameGenerationStillRepaints() {
    let worker = TerminalRenderWorker()
    let first = worker.render(
      frame: grid("AAAA", cols: 4, rows: 2, generation: 1), metrics: metrics(cols: 4, rows: 2)
    )
    XCTAssertNotNil(first)
    let second = worker.render(
      frame: grid("AAAA", cols: 4, rows: 2, generation: 1),
      metrics: metrics(cols: 4, rows: 2, fontSize: 20)
    )
    XCTAssertNotNil(
      second, "a metrics change must repaint even when the generation is unchanged"
    )
  }

  func testRerenderWithoutAPriorFrameReturnsNil() {
    let worker = TerminalRenderWorker()
    XCTAssertNil(worker.rerender(metrics: metrics(cols: 4, rows: 2)))
  }

  func testRerenderReusesLastGridAfterMetricsChange() {
    let worker = TerminalRenderWorker()
    _ = worker.render(
      frame: grid("AAAA", cols: 4, rows: 2, generation: 1), metrics: metrics(cols: 4, rows: 2)
    )
    let re = worker.rerender(metrics: metrics(cols: 4, rows: 2, fontSize: 20))
    XCTAssertEqual(
      re?.rowTexts.first, "AAAA",
      "rerender must re-rasterize the held grid for a font/bounds change"
    )
  }

  // MARK: - Links across a soft wrap

  /// A URL the terminal wrapped at the edge is one link on both rows, even when the second
  /// row carries nothing that looks like a URL on its own.
  func testASoftWrappedURLIsOneLinkOnBothRows() throws {
    let engine = TerminalEngine(cols: 20, rows: 4)
    let url = "https://example.com/abcdefghijklmno"
    engine.feed(Data(url.utf8))
    let output = try XCTUnwrap(TerminalRenderWorker().render(frame: engine.frame(), metrics: metrics(cols: 20, rows: 4)))
    XCTAssertEqual(output.wrapped, [true, false, false, false])
    XCTAssertEqual(output.rowTexts[1], "abcdefghijklmno")
    XCTAssertEqual(LinkSpans.target(atColumn: 0, row: 0, spans: output.linkSpans), .external(url: url))
    XCTAssertEqual(LinkSpans.target(atColumn: 3, row: 1, spans: output.linkSpans), .external(url: url))
  }

  func testASoftWrappedPathIsOneLinkOnBothRows() throws {
    let engine = TerminalEngine(cols: 20, rows: 4)
    engine.feed(Data("see Sources/App/Terminal/Engine.swift:42 now".utf8))
    let output = try XCTUnwrap(TerminalRenderWorker().render(frame: engine.frame(), metrics: metrics(cols: 20, rows: 4)))
    let target = LinkTarget.file(path: "Sources/App/Terminal/Engine.swift", line: 42, column: nil)
    XCTAssertEqual(LinkSpans.target(atColumn: 5, row: 0, spans: output.linkSpans), target)
    XCTAssertEqual(LinkSpans.target(atColumn: 2, row: 1, spans: output.linkSpans), target)
  }

  // MARK: - Helpers

  private func metrics(cols: Int, rows: Int, fontSize: CGFloat = 14) -> TerminalRenderMetrics {
    let font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    let bold = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .bold)
    let cellWidth = ceil(("M" as NSString).size(withAttributes: [.font: font]).width)
    let cellHeight = ceil(font.lineHeight)
    return TerminalRenderMetrics(
      cellWidth: cellWidth,
      cellHeight: cellHeight,
      size: CGSize(width: cellWidth * CGFloat(cols), height: cellHeight * CGFloat(rows)),
      scale: 2,
      font: font,
      boldFont: bold,
      background: UIColor.black.cgColor
    )
  }

  private func grid(_ text: String, cols: Int, rows: Int, generation: UInt64) -> TerminalFrame {
    var cells = [GridSnapshot.Cell](
      repeating: GridSnapshot.Cell(codepoint: 0x20, foreground: 0xFFFF_FFFF, background: 0xFF00_0000, attrs: 0),
      count: cols * rows)
    for (index, scalar) in text.unicodeScalars.enumerated() where index < cells.count {
      cells[index].codepoint = scalar.value
    }
    return TerminalFrame(
      header: GridSnapshot.Header(
        cols: UInt16(cols), rows: UInt16(rows), cursorCol: 0, cursorRow: 0,
        generation: generation, cursorVisible: true),
      cells: cells)
  }
}
