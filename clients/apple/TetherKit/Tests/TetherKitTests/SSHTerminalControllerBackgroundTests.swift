import XCTest
@testable import TetherKit

@MainActor
final class SSHTerminalControllerBackgroundTests: XCTestCase {
  private let config = SSHConnectionConfig(
    host: "example.internal", port: 22, username: "sam", credentials: [.password("pw")])

  private func makeController(_ script: DialScript) -> SSHTerminalController {
    let store = InMemoryHostKeyStore()
    return SSHTerminalController(
      title: "test", config: config, hostKeyStore: store, attach: "work",
      dial: { try await script.dial($0, $1) },
      control: ControlConnection(config: config, store: store) { FakeOps() })
  }

  func test_after_the_grace_period_the_session_is_closed() async {
    let stream = ScriptedByteStream()
    let controller = makeController(DialScript([stream]))
    await controller.connect()
    await controller.detachAfterGrace(0.05)
    XCTAssertTrue(stream.closed, "zmx must stop counting a backgrounded phone as a viewer")
    XCTAssertTrue(controller.isSuspended)
    XCTAssertEqual(controller.status, .disconnected)
    await controller.leave()
  }

  func test_returning_within_the_grace_period_keeps_the_connection() async {
    let stream = ScriptedByteStream()
    let script = DialScript([stream])
    let controller = makeController(script)
    await controller.connect()
    let detach = Task { await controller.detachAfterGrace(0.5) }
    detach.cancel()
    await detach.value
    await controller.enterForeground()
    XCTAssertFalse(stream.closed)
    XCTAssertEqual(script.dials, 1, "a short app switch must not redial")
    XCTAssertEqual(controller.status, .connected)
    await controller.leave()
  }

  func test_while_suspended_the_network_observer_does_not_redial() async {
    let script = DialScript([ScriptedByteStream(), ScriptedByteStream()])
    let controller = makeController(script)
    await controller.connect()
    await controller.suspendNow()
    await controller.connect(trigger: .networkPath)
    await controller.connect(trigger: .foreground)
    XCTAssertEqual(script.dials, 1)
    await controller.leave()
  }

  func test_coming_back_after_a_suspend_redials_once() async {
    let script = DialScript([ScriptedByteStream(), ScriptedByteStream()])
    let controller = makeController(script)
    await controller.connect()
    await controller.suspendNow()
    await controller.enterForeground()
    XCTAssertEqual(script.dials, 2)
    XCTAssertFalse(controller.isSuspended)
    XCTAssertEqual(controller.status, .connected)
    await controller.leave()
  }
}
