import CoreGraphics
import Foundation

/// Horizontal breathing room around the grid, so text is not flush against the
/// screen edges. The grid used to draw from x=0 with the sub-column leftover
/// dumped entirely on the right, which read as "too much on the left, content
/// jammed against the right". A fixed inset on each side, with the leftover
/// split evenly, keeps the two margins equal.
enum TerminalGridInset {
  static let horizontal: CGFloat = 8

  /// Columns that fit `viewWidth` once both insets are reserved.
  static func columns(viewWidth: CGFloat, cellWidth: CGFloat) -> Int {
    guard cellWidth > 0 else { return 0 }
    let available = viewWidth - horizontal * 2
    guard available > 0 else { return 0 }
    return max(1, Int(available / cellWidth))
  }

  /// Left edge of the grid: the inset plus half the sub-column leftover, so the
  /// margins on the two sides are equal.
  static func originX(viewWidth: CGFloat, cellWidth: CGFloat, cols: Int) -> CGFloat {
    let available = viewWidth - horizontal * 2
    let leftover = max(0, available - CGFloat(cols) * cellWidth)
    return horizontal + leftover / 2
  }
}

/// How many rows of a snapshot should consume the bottom of the view.
enum TerminalGridLayout {
  /// On the primary screen every row is the grid (a new shell's prompt sits at
  /// the top with empty rows beneath). On the alt-screen, trailing empty rows
  /// are an unpainted grow — Claude Code / Codex / Cursor after a session
  /// switch or keyboard-hide — and must not occupy the bottom of the surface.
  static func paintedRows(
    cells: [GridSnapshot.Cell],
    cols: Int,
    rows: Int,
    altScreen: Bool
  ) -> Int {
    guard altScreen, cols > 0, rows > 0, cells.count >= cols * rows else { return rows }
    var lastPainted = -1
    for row in 0..<rows {
      let start = row * cols
      let painted = cells[start..<(start + cols)].contains {
        $0.codepoint != 0 && $0.codepoint != 0x20
      }
      if painted { lastPainted = row }
    }
    return lastPainted + 1
  }
}

/// Whether a local PTY/emulator resize should push a new grid to the surface.
enum TerminalResizePublish {
  /// Growing rows on an alt-screen TUI adds empty cells under the paint. Showing
  /// that snapshot is the "pushed up, gap at the bottom" bug. Wait for the
  /// program to redraw. Shrinking, or a column change that reflows, must publish
  /// or the grid is clipped / stale.
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

/// Growing (or reflowing) an alt-screen TUI with `resize()` leaves CUP-clamped
/// rows missing. Re-feeding the buffered bytes at the new size restores them.
enum TerminalResizeStrategy {
  static func shouldRebuildFromBuffer(
    altScreen: Bool,
    oldCols: UInt16,
    oldRows: UInt16,
    newCols: UInt16,
    newRows: UInt16
  ) -> Bool {
    guard altScreen else { return false }
    return newCols != oldCols || newRows != oldRows
  }
}
