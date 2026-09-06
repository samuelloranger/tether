import Foundation

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
