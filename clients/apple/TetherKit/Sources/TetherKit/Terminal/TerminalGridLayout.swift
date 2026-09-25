import CoreGraphics
import Foundation

/// Side padding on each side plus the sub-column leftover split evenly, so both margins match.
public enum TerminalGridInset {
  public static let defaultPadding: CGFloat = 8
  static let paddingRange: ClosedRange<Double> = 0...24

  static func clampedPadding(_ padding: Double) -> Double {
    min(max(padding, paddingRange.lowerBound), paddingRange.upperBound)
  }

  /// Columns that fit `viewWidth` once both paddings are reserved.
  static func columns(viewWidth: CGFloat, cellWidth: CGFloat, padding: CGFloat = defaultPadding) -> Int {
    guard cellWidth > 0 else { return 0 }
    let available = viewWidth - padding * 2
    guard available > 0 else { return 0 }
    return max(1, Int(available / cellWidth))
  }

  static func originX(
    viewWidth: CGFloat, cellWidth: CGFloat, cols: Int, padding: CGFloat = defaultPadding
  ) -> CGFloat {
    let available = viewWidth - padding * 2
    let leftover = max(0, available - CGFloat(cols) * cellWidth)
    return padding + leftover / 2
  }
}

/// Row height from the font's line height and the line-spacing preference.
enum TerminalLineSpacing {
  static let range: ClosedRange<Double> = 1.0...1.6

  static func clamped(_ spacing: Double) -> Double {
    min(max(spacing, range.lowerBound), range.upperBound)
  }

  static func cellHeight(lineHeight: CGFloat, spacing: CGFloat) -> CGFloat {
    ceil(lineHeight * CGFloat(clamped(Double(spacing))))
  }
}

/// How many rows of a snapshot should consume the bottom of the view.
enum TerminalGridLayout {
  /// On the alt-screen, trailing empty rows are an unpainted grow (after a session switch or
  /// keyboard-hide) and must not occupy the bottom; on the primary screen every row counts.
  static func paintedRows(
    cells: [GridSnapshot.Cell],
    cols: Int,
    rows: Int,
    altScreen: Bool,
    images: TerminalImageLayer = .empty
  ) -> Int {
    guard altScreen, cols > 0, rows > 0, cells.count >= cols * rows else { return rows }
    // An image sits over blank cells; its rows are painted too.
    var lastPainted = min(rows, images.placements.map { $0.row + $0.rows }.max() ?? 0) - 1
    for row in 0..<rows {
      let start = row * cols
      let painted = cells[start..<(start + cols)].contains {
        $0.codepoint != 0 && $0.codepoint != 0x20
      }
      if painted { lastPainted = max(lastPainted, row) }
    }
    return lastPainted + 1
  }
}

/// Whether a local PTY/emulator resize should push a new grid to the surface.
enum TerminalResizePublish {
  /// A row grow only adds empty cells under the paint, which shows as a gap at the bottom;
  /// wait for the program to redraw. Shrinks and column reflows must publish or the grid is stale.
  static func shouldPublishAfterResize(
    oldCols: UInt16,
    oldRows: UInt16,
    newCols: UInt16,
    newRows: UInt16
  ) -> Bool {
    if newCols != oldCols { return true }
    return newRows <= oldRows
  }
}

/// Alt-screen resizes clamp CUP rows; a primary-screen row grow can duplicate a row that a
/// cursor-home redraw never clears. Both need re-feeding the buffered bytes at the new size.
enum TerminalResizeStrategy {
  static func shouldRebuildFromBuffer(
    altScreen: Bool,
    oldCols: UInt16,
    oldRows: UInt16,
    newCols: UInt16,
    newRows: UInt16
  ) -> Bool {
    if altScreen { return newCols != oldCols || newRows != oldRows }
    return newRows > oldRows
  }
}
