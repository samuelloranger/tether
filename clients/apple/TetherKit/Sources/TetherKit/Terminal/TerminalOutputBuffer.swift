import Foundation
import TetherFFIBindings

/// Bytes fed into the current emulator, so a later size change can rebuild the
/// grid from scratch instead of `resize()`-ing a clamped alt-screen paint.
final class TerminalOutputBuffer {
  private(set) var data = Data()
  var byteBudget: Int

  init(byteBudget: Int = 2_000_000) {
    self.byteBudget = byteBudget
  }

  func append(_ bytes: Data) {
    guard !bytes.isEmpty else { return }
    data.append(bytes)
    if data.count > byteBudget {
      data = Data(data.suffix(byteBudget))
    }
  }

  func reset() {
    data.removeAll(keepingCapacity: true)
  }

  func replay(cols: UInt16, rows: UInt16) -> FfiTerminalEmulator {
    let emulator = FfiTerminalEmulator(cols: cols, rows: rows)
    if !data.isEmpty {
      emulator.feed(bytes: data)
    }
    return emulator
  }
}
