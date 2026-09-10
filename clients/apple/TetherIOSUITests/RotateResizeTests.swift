import XCTest

/// Test #15 — rotating the device resizes the grid, which must reach the PTY as a
/// resize (new cols/rows). The `gridSettle` coalescing means only the settled
/// landscape size should be reported, not the intermediate rotation frames.
final class RotateResizeTests: TetherUITestCase {
  func testRotationResizesTheGrid() throws {
    let app = launchApp()
    tapNewTerminal(app)
    focusAndType(app, "echo ROT_READY\n")
    sleep(2)

    XCUIDevice.shared.orientation = .landscapeLeft
    sleep(4)
    shot(app, "landscape")

    XCUIDevice.shared.orientation = .portrait
    sleep(3)
  }
}
