import Foundation
import TetherFFIBindings

/// One session's live VT grid and the bytes that built it.
///
/// Switching sessions must not throw this away: the inactive tab has no live
/// Noise socket, so switch-back replays only what `sinceId` missed onto this
/// emulator. A server `{t:reset}` is the one case that wipes it.
final class TerminalSessionGrid {
  var emulator: FfiTerminalEmulator
  let buffer: TerminalOutputBuffer
  var lastAltScreen = false

  init(cols: UInt16, rows: UInt16) {
    emulator = FfiTerminalEmulator(cols: cols, rows: rows)
    buffer = TerminalOutputBuffer()
  }

  func reset(cols: UInt16, rows: UInt16) {
    buffer.reset()
    emulator = FfiTerminalEmulator(cols: cols, rows: rows)
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
