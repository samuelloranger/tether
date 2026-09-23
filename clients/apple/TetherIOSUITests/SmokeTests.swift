import XCTest

/// Validates the real-UI harness: launch to foreground, then background via the home
/// button and reactivate — the lifecycle mechanism every reconnect test relies on.
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

    // The AUT's own `.state` reports a stale foreground once suspended, so observe
    // Springboard coming to the front instead.
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

  /// The edge swipe has to beat the terminal's own pan, which begins the moment a
  /// finger moves; losing that race made the swipe work only from the header.
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

  /// Closing is the other half of the gesture: a leftward swipe, from the panel
  /// or from the dimmed terminal beside it.
  func testSwipeLeftClosesTheDrawer() throws {
    let app = XCUIApplication()
    app.launchEnvironment["TETHER_SSH_DEMO"] = "1"
    app.launchEnvironment["TETHER_UITEST_PRESEED"] = "1"
    app.launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15), "app never reached foreground")

    let surface = app.descendants(matching: .any)["sshTerminalSurface"].firstMatch
    XCTAssertTrue(surface.waitForExistence(timeout: 30), "terminal surface never appeared")
    let drawer = app.descendants(matching: .any)["sshSessionDrawer"].firstMatch

    app.buttons["sshTerminalDrawer"].firstMatch.tap()
    XCTAssertTrue(drawer.waitForExistence(timeout: 5), "drawer never opened from the header button")
    attachShot(app, "20-drawer-open")

    app.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.5))
      .press(forDuration: 0.05,
             thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5)),
             withVelocity: .default, thenHoldForDuration: 0.1)
    XCTAssertTrue(waitForDisappearance(drawer), "swipe left on the panel did not close the drawer")
    attachShot(app, "21-closed-by-panel-swipe")

    // And again from the dimmed terminal on the right of the open drawer.
    app.buttons["sshTerminalDrawer"].firstMatch.tap()
    XCTAssertTrue(drawer.waitForExistence(timeout: 5), "drawer never reopened")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5))
      .press(forDuration: 0.05,
             thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)),
             withVelocity: .default, thenHoldForDuration: 0.1)
    XCTAssertTrue(waitForDisappearance(drawer), "swipe left on the dimmed terminal did not close the drawer")
    attachShot(app, "22-closed-by-scrim-swipe")
  }

  private func waitForDisappearance(_ element: XCUIElement) -> Bool {
    let gone = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == false"), object: element)
    return XCTWaiter().wait(for: [gone], timeout: 5) == .completed
  }

  private func attachShot(_ app: XCUIApplication, _ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }
}
