import XCTest

/// Test #19 — hammering "new terminal" must spawn one session per tap without
/// crashing, double-spawning, or wedging the drawer. Exact count is asserted
/// server-side (noise_start wasLive:false == 5); a SwiftUI a11y id on a row
/// double-counts in XCUITest, so we only prove the drawer opened and the app
/// stayed alive here.
final class RapidSessionSpamTests: TetherUITestCase {
  func testRapidNewTerminalSpawnsOnePerTap() throws {
    let app = launchApp()
    let newBtn = app.buttons["newTerminalButton"].firstMatch
    XCTAssertTrue(newBtn.waitForExistence(timeout: 15), "no New terminal button")

    for _ in 0..<5 {
      newBtn.tap()
      usleep(250_000)
    }
    sleep(4)

    XCTAssertTrue(
      app.descendants(matching: .any)["terminalSurface"].firstMatch.waitForExistence(timeout: 15),
      "app is not showing a terminal after rapid spawns (possible crash/wedge)")

    openDrawer(app)
    let rows = app.descendants(matching: .any).matching(identifier: "sessionRow")
    XCTAssertTrue(rows.element(boundBy: 0).waitForExistence(timeout: 10), "drawer shows no sessions")
    shot(app, "five-sessions")
  }
}
