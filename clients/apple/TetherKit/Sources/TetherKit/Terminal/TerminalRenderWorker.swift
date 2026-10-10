import CoreGraphics
import Foundation
import UIKit

struct TerminalRenderOutput {
  var header: GridSnapshot.Header
  var cells: [GridSnapshot.Cell]
  var hyperlinks: [[LinkSpan]]
  var images: TerminalImageLayer
  var clusters: [Int: String] = [:]
  var defaultBackground: UInt32?
  var image: CGImage?
  /// Rows the bitmap anchors to the bottom of the view.
  var drawRows: Int
  /// The cell under the cursor drawn as a solid block, for a block cursor.
  var cursorImage: CGImage?

  /// Plain text per row. Computed on demand: only selection and link taps read it.
  var rowTexts: [String] {
    TerminalRunBuilder.rowTexts(cells: cells, cols: Int(header.cols), rows: Int(header.rows), clusters: clusters)
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
  private var lastClusters: [Int: String] = [:]
  private var lastDefaultBackground: UInt32?

  func reset() {
    renderer.invalidate()
    lastGeneration = nil
    lastMetrics = nil
    lastHeader = nil
    lastCells = []
    lastHyperlinks = []
    lastImages = .empty
    lastClusters = [:]
    lastDefaultBackground = nil
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
    if header.generation == lastGeneration, header.trimsBlankRows == lastHeader?.trimsBlankRows, metrics == lastMetrics {
      return nil
    }
    lastGeneration = header.generation
    lastHeader = header
    lastCells = frame.cells
    lastHyperlinks = frame.hyperlinks
    lastImages = frame.images
    lastClusters = frame.clusters
    lastDefaultBackground = frame.defaultBackground
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
    let image = renderer.render(
      header: header, cells: lastCells, images: lastImages, clusters: lastClusters,
      defaultBackground: lastDefaultBackground, metrics: metrics)
    return TerminalRenderOutput(
      header: header,
      cells: lastCells,
      hyperlinks: lastHyperlinks,
      images: lastImages,
      clusters: lastClusters,
      defaultBackground: lastDefaultBackground,
      image: image,
      drawRows: renderer.drawRows,
      cursorImage: header.cursorVisible
        ? renderer.cursorImage(header: header, cells: lastCells, clusters: lastClusters, metrics: metrics) : nil
    )
  }
}
