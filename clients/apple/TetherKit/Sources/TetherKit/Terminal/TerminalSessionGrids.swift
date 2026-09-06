import Foundation
import TetherFFIBindings

/// One session's live VT grid and the bytes that built it.
///
/// Noise `start` does not replay logs — only bytes from this subscribe onward.
/// Switching sessions must not throw this away or the next SIGWINCH is a
/// composer CUP into an empty emulator (the void under the input box).
final class TerminalSessionGrid {
  var emulator: FfiTerminalEmulator
  let buffer: TerminalOutputBuffer
  var lastAltScreen = false

  init(cols: UInt16, rows: UInt16) {
    emulator = FfiTerminalEmulator(cols: cols, rows: rows)
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

  func forget(_ key: String) {
    grids.removeValue(forKey: key)
  }
}
