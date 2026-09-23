import XCTest

/// Shared harness for the Tether iOS E2E suite: preseed injection, a launched
/// foreground app, and screenshot attachments, kept here instead of in each test.
class TetherUITestCase: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  /// An app carrying whatever preseed / deep-link fixtures the runner forwarded.
  func makeApp() -> XCUIApplication {
    let app = XCUIApplication()
    let env = ProcessInfo.processInfo.environment
    for key in ["TETHER_UITEST_PRESEED", "TETHER_UITEST_PRESEED2", "TETHER_UITEST_DEEPLINK"] {
      if let value = env[key] { app.launchEnvironment[key] = value }
    }
    return app
  }

  /// Launch (making a fresh app if none is given) and wait for the foreground.
  @discardableResult
  func launchApp(_ app: XCUIApplication? = nil) -> XCUIApplication {
    let a = app ?? makeApp()
    a.launch()
    XCTAssertTrue(
      a.wait(for: .runningForeground, timeout: 15),
      "app never reached foreground (state=\(a.state.rawValue))")
    return a
  }

  func shot(_ app: XCUIApplication, _ name: String) {
    let a = XCTAttachment(screenshot: app.screenshot())
    a.name = name
    a.lifetime = .keepAlways
    add(a)
  }
}
