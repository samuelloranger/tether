#if canImport(UIKit)
import CoreGraphics
import Foundation
import UIKit

/// Everything the main thread needs after a frame is rendered.
struct TerminalRenderOutput {
  var header: GridSnapshot.Header
  var cells: [GridSnapshot.Cell]
  var rowTexts: [String]
  var linkSpans: [[LinkSpan]]
  var image: CGImage?
}

/// Owns link detection and rasterization for one surface.
///
/// Both used to run on the main actor inside the render path: a regex sweep
/// over every row and the CoreText draw. Only the finished image needs to reach
/// the main thread, so all of it lives here and is touched exclusively from the
/// surface's serial render queue.
final class TerminalRenderWorker {
  private let renderer = TerminalGridRenderer()
  private var lastGeneration: UInt64?
  private var lastMetrics: TerminalRenderMetrics?
  private var lastHeader: GridSnapshot.Header?
  private var lastCells: [GridSnapshot.Cell] = []
  private var lastRowTexts: [String] = []
  private var lastLinkSpans: [[LinkSpan]] = []

  func reset() {
    renderer.invalidate()
    lastGeneration = nil
    lastMetrics = nil
    lastHeader = nil
    lastCells = []
    lastRowTexts = []
    lastLinkSpans = []
  }

  /// Drop the generation gate without clearing the last image. A session switch
  /// that shows a cached grid must not `clearSnapshot` (that is the blank flash)
  /// but two sessions both starting at generation 1 would otherwise collide.
  /// Also forces the renderer's next frame to fully repaint: its dirty-row
  /// diff is otherwise still comparing against the PREVIOUS session's cells.
  func forgetGeneration() {
    lastGeneration = nil
    renderer.forceFullRepaintOnNextFrame()
  }

  /// `nil` when the frame carries nothing new to show.
  func render(frame: TerminalFrame, metrics: TerminalRenderMetrics) -> TerminalRenderOutput? {
    let header = frame.header
    // A metrics change has to repaint even when the grid contents are identical,
    // so the generation shortcut only applies while the geometry holds still.
    if header.generation == lastGeneration, metrics == lastMetrics {
      return nil
    }
    lastGeneration = header.generation
    lastHeader = header
    lastCells = frame.cells
    let cols = Int(header.cols)
    let rows = Int(header.rows)
    lastRowTexts = TerminalRunBuilder.rowTexts(cells: lastCells, cols: cols, rows: rows)
    // Frames carry no soft-wrap flags yet — the hard-wrap heuristic in
    // LinkSpans still runs.
    lastLinkSpans = LinkSpans.compute(
      texts: lastRowTexts,
      wrapped: Array(repeating: false, count: lastRowTexts.count)
    )
    return rasterize(metrics: metrics)
  }

  /// Re-rasterizes the frame already held — for a font, bounds or scale change
  /// arriving with no new output behind it.
  func rerender(metrics: TerminalRenderMetrics) -> TerminalRenderOutput? {
    guard lastHeader != nil else { return nil }
    return rasterize(metrics: metrics)
  }

  private func rasterize(metrics: TerminalRenderMetrics) -> TerminalRenderOutput? {
    guard let header = lastHeader else { return nil }
    lastMetrics = metrics
    let image = renderer.render(header: header, cells: lastCells, metrics: metrics)
    return TerminalRenderOutput(
      header: header,
      cells: lastCells,
      rowTexts: lastRowTexts,
      linkSpans: lastLinkSpans,
      image: image
    )
  }
}
#endif
