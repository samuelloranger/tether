import CoreGraphics
import Foundation
import UIKit

struct TerminalRenderOutput {
  var header: GridSnapshot.Header
  var cells: [GridSnapshot.Cell]
  var rowTexts: [String]
  var linkSpans: [[LinkSpan]]
  var image: CGImage?
}

/// Link detection and rasterization for one surface, off the main thread.
/// Touch only from the surface's serial render queue.
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

  /// Keeps the last image but lets a new session's generation 1 through.
  func forgetGeneration() {
    lastGeneration = nil
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
    lastLinkSpans = LinkSpans.merging(
      explicit: frame.hyperlinks,
      detected: LinkSpans.compute(texts: lastRowTexts, wrapped: Array(repeating: false, count: lastRowTexts.count))
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
