import XCTest

/// Drives the SSH screen end to end against a live sshd+zmx host, preseeded via the
/// TETHER_SSH_* launch env. Screenshots each step.
final class SSHV5FlowTests: TetherUITestCase {
  private func liveApp(sendFile: String? = nil) -> XCUIApplication {
    let app = XCUIApplication()
    let env = ProcessInfo.processInfo.environment
    for (k, v) in env where k.hasPrefix("TETHER_SSH_") { app.launchEnvironment[k] = v }
    app.launchEnvironment["TETHER_SSH_LIVE"] = env["TETHER_SSH_LIVE"] ?? "1"
    if let sendFile { app.launchEnvironment["TETHER_SSH_SENDFILE"] = sendFile }
    return app
  }

  private func waitForSurface(_ app: XCUIApplication) {
    let surface = app.descendants(matching: .any)["sshTerminalSurface"].firstMatch
    XCTAssertTrue(surface.waitForExistence(timeout: 30), "SSH surface never appeared")
    usleep(1_500_000)
  }

  func testConnectSwitchKill() {
    let app = launchApp(liveApp())
    waitForSurface(app)
    shot(app, "01-connected")

    app.buttons["sshTerminalDrawer"].firstMatch.tap()
    let field = app.textFields["sshNewSessionField"].firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 5), "no new-session field")
    shot(app, "02-drawer")

    field.tap()
    field.typeText("session-2")
    app.buttons["sshNewSessionAdd"].firstMatch.tap()
    usleep(2_000_000)
    shot(app, "03-live-switch-to-session-2")

    app.buttons["sshTerminalDrawer"].firstMatch.tap()
    let defaultRow = app.buttons["zmxSession_default"].firstMatch
    XCTAssertTrue(defaultRow.waitForExistence(timeout: 5), "no default session row")
    defaultRow.tap()
    usleep(2_000_000)
    shot(app, "04-live-switch-back")

    app.buttons["sshTerminalDrawer"].firstMatch.tap()
    let kill = app.buttons["zmxKill_session-2"].firstMatch
    XCTAssertTrue(kill.waitForExistence(timeout: 5), "no kill button for session-2")
    kill.tap()
    usleep(2_000_000)
    shot(app, "05-after-kill")
  }

  func testSendFile() {
    let app = launchApp(liveApp(sendFile: "tether-upload-test.txt"))
    waitForSurface(app)
    usleep(1_500_000)
    shot(app, "06-send-file-pill")
  }
}
