import XCTest

/// Proves the real-UI harness works end to end:
/// 1. the app launches into the foreground on the simulator,
/// 2. real iOS lifecycle can be driven — background via the home button and
///    reactivate — which is the exact mechanism every reconnect test needs.
/// No app-specific hooks yet; this only validates the driving harness.
final class SmokeTests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  func testLaunchThenBackgroundThenForeground() throws {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(
      app.wait(for: .runningForeground, timeout: 15),
      "app never reached foreground (state=\(app.state.rawValue))")

    attachShot(app, "01-launched")

    // Real lifecycle: send to background with the home button. The AUT's own
    // `.state` reports a stale foreground once suspended, so observe Springboard
    // coming to the front instead — the reliable signal the press landed.
    XCUIDevice.shared.press(.home)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    XCTAssertTrue(
      springboard.wait(for: .runningForeground, timeout: 15),
      "home press never backgrounded the app (springboard state=\(springboard.state.rawValue))")

    // Bring it back — this is the reopen the reconnect tests hang on.
    app.activate()
    XCTAssertTrue(
      app.wait(for: .runningForeground, timeout: 15),
      "app never returned to foreground (state=\(app.state.rawValue))")

    attachShot(app, "02-reopened")
  }

  /// The drawer's edge swipe has to win over the terminal surface's own pan,
  /// which begins the moment a finger moves. When it lost that race the swipe
  /// did nothing over the grid — it only worked starting on the header, where
  /// the terminal has no recognizer.
  func testEdgeSwipeOverTheTerminalGridOpensTheDrawer() throws {
    let app = XCUIApplication()
    app.launchEnvironment["TETHER_SSH_DEMO"] = "1"
    // Skips the notification prompt, which would sit over the whole screen.
    app.launchEnvironment["TETHER_UITEST_PRESEED"] = "1"
    app.launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15), "app never reached foreground")

    let surface = app.descendants(matching: .any)["sshTerminalSurface"].firstMatch
    XCTAssertTrue(surface.waitForExistence(timeout: 30), "terminal surface never appeared")
    let drawer = app.descendants(matching: .any)["sshSessionDrawer"].firstMatch
    XCTAssertFalse(drawer.exists, "drawer was already open before the swipe")
    attachShot(app, "10-terminal-before-edge-swipe")

    // Deep in the grid's vertical middle: squarely inside the terminal's pan.
    let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.003, dy: 0.6))
    let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.6))
    start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .default, thenHoldForDuration: 0.1)

    XCTAssertTrue(
      drawer.waitForExistence(timeout: 5),
      "edge swipe starting over the terminal grid did not open the drawer")
    attachShot(app, "11-drawer-after-edge-swipe")
  }

  private func attachShot(_ app: XCUIApplication, _ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }
}
