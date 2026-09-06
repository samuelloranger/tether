import XCTest

/// Proves the preseed path: with a fixture in TETHER_UITEST_PRESEED the app must
/// launch already paired and reach the server over Noise. This test only DRIVES
/// the app (launch + settle); the protocol assertion — that the server logged a
/// `noise_auth ok` — is made by the orchestration shell against the server's
/// TETHER_TEST_LOG, since that file lives on the host, not the simulator.
final class PreseedConnectTests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  private func makeApp() -> XCUIApplication {
    let app = XCUIApplication()
    // Forward the fixture from the runner's env (passed as TEST_RUNNER_… by
    // xcodebuild) into the app process so bootstrap() can preseed.
    if let seed = ProcessInfo.processInfo.environment["TETHER_UITEST_PRESEED"] {
      app.launchEnvironment["TETHER_UITEST_PRESEED"] = seed
    }
    return app
  }

  func testLaunchesPairedAndConnects() throws {
    let app = makeApp()
    app.launch()
    XCTAssertTrue(
      app.wait(for: .runningForeground, timeout: 15),
      "app never reached foreground (state=\(app.state.rawValue))")

    // Give bootstrap() time to preseed the host and open the Noise session that
    // the orchestration shell will look for in the server log.
    let settle = expectation(description: "settle")
    _ = XCTWaiter.wait(for: [settle], timeout: 8)

    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "preseed-connected"
    shot.lifetime = .keepAlways
    add(shot)
  }
}
