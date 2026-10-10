import CoreGraphics
import Foundation
import UIKit

struct TerminalRenderOutput {
  var header: GridSnapshot.Header
  var cells: [GridSnapshot.Cell]
  var hyperlinks: [[LinkSpan]]
  var images: TerminalImageLayer
  var image: CGImage?
  /// Rows the bitmap anchors to the bottom of the view.
  var drawRows: Int

  /// Plain text per row. Computed on demand: only selection and link taps read it.
  var rowTexts: [String] {
    TerminalRunBuilder.rowTexts(cells: cells, cols: Int(header.cols), rows: Int(header.rows))
  }
}

/// Rasterization for one surface, off the main thread.
/// Touch only from the surface's serial render queue.
final class TerminalRenderWorker {
  private let renderer = TerminalGridRenderer()
  private var lastGeneration: UInt64?
  private var lastMetrics: TerminalRenderMetrics?
  private var lastHeader: GridSnapshot.Header?
  private var lastCells: [GridSnapshot.Cell] = []
  private var lastHyperlinks: [[LinkSpan]] = []
  private var lastImages = TerminalImageLayer.empty

  func reset() {
    renderer.invalidate()
    lastGeneration = nil
    lastMetrics = nil
    lastHeader = nil
    lastCells = []
    lastHyperlinks = []
    lastImages = .empty
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
    lastHyperlinks = frame.hyperlinks
    lastImages = frame.images
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
    let image = renderer.render(header: header, cells: lastCells, images: lastImages, metrics: metrics)
    return TerminalRenderOutput(
      header: header,
      cells: lastCells,
      hyperlinks: lastHyperlinks,
      images: lastImages,
      image: image,
      drawRows: renderer.drawRows
    )
  }
}
