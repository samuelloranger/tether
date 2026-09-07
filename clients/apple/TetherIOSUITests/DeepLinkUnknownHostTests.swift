import XCTest

/// Test #18 — a `tether://` payload naming an UNKNOWN host must not crash the
/// app. The URL is server-influenced (it rides in a push), so a host matching no
/// profile has to fail soft: stay running, stay usable.
final class DeepLinkUnknownHostTests: TetherUITestCase {
  func testUnknownHostDeepLinkDoesNotCrash() throws {
    let app = makeApp()
    app.launchEnvironment["TETHER_UITEST_DEEPLINK"] = "tether://session/term-1?host=NO_SUCH_HOST"
    launchApp(app)

    // App must stay usable: open a session after the bad link.
    tapNewTerminal(app)
    XCTAssertTrue(
      app.descendants(matching: .any)["terminalSurface"].firstMatch.waitForExistence(timeout: 15),
      "could not open a session after the bad deep link")
    shot(app, "survived-unknown-host")
  }
}
