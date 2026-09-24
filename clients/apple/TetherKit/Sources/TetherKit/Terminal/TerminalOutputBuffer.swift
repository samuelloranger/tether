import Foundation

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
    // Trimming to exactly the budget re-copied the whole buffer on every read
    // once it was full; dropping to two thirds copies once per third of a budget.
    if data.count > byteBudget {
      data = Data(data.suffix(byteBudget * 2 / 3))
    }
  }

  /// The cell pixel size is set before the bytes go in: kitty sizes placements as it parses.
  func replay(
    cols: UInt16, rows: UInt16, theme: TerminalTheme = .tether, cellPixelSize: (width: Int, height: Int)? = nil
  ) -> TerminalEngine {
    let engine = TerminalEngine(cols: cols, rows: rows, theme: theme)
    if let cellPixelSize { engine.setCellPixelSize(width: cellPixelSize.width, height: cellPixelSize.height) }
    if !data.isEmpty {
      engine.feed(data)
      engine.discardReplies()
    }
    return engine
  }
}
