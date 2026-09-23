import Foundation

/// Kept across session switches so switching back shows the session's last grid at once.
final class TerminalSessionGrid {
  var emulator: TerminalEngine
  let buffer: TerminalOutputBuffer
  var lastAltScreen = false

  init(cols: UInt16, rows: UInt16) {
    emulator = TerminalEngine(cols: cols, rows: rows)
    buffer = TerminalOutputBuffer()
  }
}

final class TerminalSessionGrids {
  private var grids: [String: TerminalSessionGrid] = [:]

  func attach(key: String, cols: UInt16, rows: UInt16) -> (grid: TerminalSessionGrid, reused: Bool) {
    if let existing = grids[key] {
      return (existing, true)
    }
    let grid = TerminalSessionGrid(cols: cols, rows: rows)
    grids[key] = grid
    return (grid, false)
  }
}
