/// When to push a new grid size to the emulator/PTY immediately vs waiting out
/// a layout animation.
///
/// Keyboard show/hide jumps many rows at once. Debouncing those (the path that
/// coalesces sub-cell window resizes) used to wait 0.3s and then skip the send
/// if an in-between layout had already applied the size locally — cursor-agent
/// stayed painted at the short size with blank rows underneath.
enum GridReport {
  static let largeJump = 2

  static func shouldCommitImmediately(
    previous: (cols: UInt16, rows: UInt16)?,
    next: (cols: UInt16, rows: UInt16)
  ) -> Bool {
    guard let previous else { return true }
    return abs(Int(next.rows) - Int(previous.rows)) >= largeJump
      || abs(Int(next.cols) - Int(previous.cols)) >= largeJump
  }
}
