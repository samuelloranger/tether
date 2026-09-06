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

  private func attachShot(_ app: XCUIApplication, _ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }
}
