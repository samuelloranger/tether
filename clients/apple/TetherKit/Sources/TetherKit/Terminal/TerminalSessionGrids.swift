import Foundation

/// One session's live VT grid and the bytes that built it.
///
/// Switching sessions must not throw this away: each drawer session keeps its
/// own emulator and byte buffer, so switching back shows its last grid at once.
final class TerminalSessionGrid {
  var emulator: TerminalEngine
  let buffer: TerminalOutputBuffer
  var lastAltScreen = false

  init(cols: UInt16, rows: UInt16) {
    emulator = TerminalEngine(cols: cols, rows: rows)
    buffer = TerminalOutputBuffer()
  }

  func reset(cols: UInt16, rows: UInt16) {
    buffer.reset()
    emulator = TerminalEngine(cols: cols, rows: rows)
    lastAltScreen = false
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

  func forget(_ key: String) {
    grids.removeValue(forKey: key)
  }
}
