#if canImport(UIKit)
import CoreGraphics
import UIKit
import XCTest

@testable import TetherKit

/// Session switch yields `nil` then a new session's first grid. Both sessions
/// start at generation 1. Without `reset()`, the worker treats that frame as a
/// duplicate and the surface stays on the previous session — or blank.
final class TerminalRenderWorkerSwitchTests: XCTestCase {
  func testWithoutResetANewSessionWithTheSameGenerationIsDropped() {
    let worker = TerminalRenderWorker()
    let m = metrics(cols: 4, rows: 2)
    let first = worker.render(bytes: grid("AAAA", cols: 4, rows: 2, generation: 1), metrics: m)
    XCTAssertEqual(first?.rowTexts.first, "AAAA")

    let second = worker.render(bytes: grid("BBBB", cols: 4, rows: 2, generation: 1), metrics: m)
    XCTAssertNil(
      second,
      "a generation collision must not paint the new session over the old one without reset"
    )
  }

  func testAfterResetTheNewSessionsFirstFramePaints() {
    let worker = TerminalRenderWorker()
    let m = metrics(cols: 4, rows: 2)
    _ = worker.render(bytes: grid("AAAA", cols: 4, rows: 2, generation: 1), metrics: m)
    worker.reset()
    let second = worker.render(bytes: grid("BBBB", cols: 4, rows: 2, generation: 1), metrics: m)
    XCTAssertEqual(
      second?.rowTexts.first,
      "BBBB",
      "clearSnapshot's reset is what lets the next session's generation-1 frame show"
    )
  }

  /// Switching sessions must not `clearSnapshot` (that is the blank flash).
  /// Forgetting only the generation lets the cached grid of the next session
  /// paint even when both sessions start at generation 1.
  func testAfterForgettingGenerationTheNewSessionsFirstFramePaints() {
    let worker = TerminalRenderWorker()
    let m = metrics(cols: 4, rows: 2)
    _ = worker.render(bytes: grid("AAAA", cols: 4, rows: 2, generation: 1), metrics: m)
    worker.forgetGeneration()
    let second = worker.render(bytes: grid("BBBB", cols: 4, rows: 2, generation: 1), metrics: m)
    XCTAssertEqual(
      second?.rowTexts.first,
      "BBBB",
      "a session change without clearSnapshot still has to accept generation 1"
    )
  }

  // MARK: - Helpers

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
      background: UIColor.black.cgColor
    )
  }

  private func grid(_ text: String, cols: Int, rows: Int, generation: UInt64) -> Data {
    var cells = [GridSnapshot.Cell](
      repeating: GridSnapshot.Cell(
        codepoint: 0x20,
        foreground: 0xFFFF_FFFF,
        background: 0xFF00_0000,
        attrs: 0
      ),
      count: cols * rows
    )
    for (index, scalar) in text.unicodeScalars.enumerated() where index < cells.count {
      cells[index].codepoint = scalar.value
    }
    return encode(
      cols: UInt16(cols),
      rows: UInt16(rows),
      generation: generation,
      cells: cells
    )
  }

  private func encode(
    cols: UInt16,
    rows: UInt16,
    generation: UInt64,
    cells: [GridSnapshot.Cell]
  ) -> Data {
    var data = Data()
    func put<T: FixedWidthInteger>(_ value: T) {
      var little = value.littleEndian
      withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
    }
    put(GridSnapshot.magic)
    put(GridSnapshot.version)
    put(cols)
    put(rows)
    put(UInt16(0))
    put(UInt16(0))
    put(generation)
    put(GridSnapshot.flagCursorVisible)
    for cell in cells {
      put(cell.codepoint)
      put(cell.foreground)
      put(cell.background)
      put(cell.attrs)
    }
    return data
  }
}
#endif
