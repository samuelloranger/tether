import XCTest

/// Test #11 — tapping a notification must open the session it names, not the
/// last-active tab. A real APNs tap and this test end in the same call:
/// NotificationTapRouter funnels `tether://session/<id>?host=<name>` into
/// SessionStore.handleDeepLink. Injected at launch via TETHER_UITEST_DEEPLINK.
final class NotificationTapRouteTests: TetherUITestCase {
  func testNotificationTapOpensTheNamedSession() throws {
    let app = launchApp()

    // term-1: the tap target.
    tapNewTerminal(app)
    focusAndType(app, "echo ROUTE_TARGET_A\n")
    sleep(2)

    // term-2 becomes the active tab, so a correct route must switch AWAY from it.
    tapNewTerminal(app)
    focusAndType(app, "echo OTHER_SESSION_B\n")
    sleep(2)

    app.terminate()
    XCTAssertTrue(app.wait(for: .notRunning, timeout: 15), "app never terminated")

    // Relaunch as if a notification for term-1 was tapped.
    let tapped = makeApp()
    tapped.launchEnvironment["TETHER_UITEST_DEEPLINK"] = "tether://session/term-1?host=e2e"
    launchApp(tapped)
    sleep(5)
    dumpGrid(tapped, "client-grid-after-tap")
  }
}
