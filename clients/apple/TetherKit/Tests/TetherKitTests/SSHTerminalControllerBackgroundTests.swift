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

  func test_the_grace_detach_flushes_the_missed_push_after_closing_the_session() async {
    let stream = ScriptedByteStream()
    let ops = FakeOps()
    let store = InMemoryHostKeyStore()
    let controller = SSHTerminalController(
      title: "test", config: config, hostKeyStore: store, attach: "work",
      dial: { try await DialScript([stream]).dial($0, $1) },
      control: ControlConnection(config: config, store: store) { ops })
    await controller.connect()
    await controller.detachAfterGrace(0.05)
    XCTAssertTrue(stream.closed)
    XCTAssertTrue(ops.commands.contains { $0.contains("tether-notify flush --session 'work'") })
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

  func test_a_suspend_during_a_dial_still_lets_go() async {
    let stream = ScriptedByteStream()
    let script = DialScript([stream], held: true)
    let controller = makeController(script)
    let connecting = Task { await controller.connect() }
    let entered = await eventually { script.hasEntered }
    XCTAssertTrue(entered)

    await controller.suspendNow()
    script.open()
    await connecting.value

    XCTAssertTrue(stream.closed, "a dial that lands after the suspend must not stay attached")
    XCTAssertTrue(controller.isSuspended)
    XCTAssertNotEqual(controller.status, .connected)
    await controller.leave()
  }

  // Answer… brings the app forward while a question is held in this very session: the
  // foreground redial would attach it and hand the question back to the terminal.
  func test_answering_a_question_in_the_open_session_keeps_it_detached_until_done() async {
    let first = ScriptedByteStream()
    let script = DialScript([first, ScriptedByteStream()])
    let controller = makeController(script)
    await controller.connect()
    await controller.beginAnsweringQuestion(in: "work")
    XCTAssertTrue(first.closed)
    await controller.enterForeground()
    XCTAssertEqual(script.dials, 1, "the sheet's session must not be re-attached")
    XCTAssertTrue(controller.isSuspended)
    await controller.finishAnsweringQuestion()
    XCTAssertEqual(script.dials, 2)
    XCTAssertEqual(controller.status, .connected)
    await controller.leave()
  }

  func test_a_question_in_another_session_leaves_the_terminal_alone() async {
    let stream = ScriptedByteStream()
    let script = DialScript([stream])
    let controller = makeController(script)
    await controller.connect()
    await controller.beginAnsweringQuestion(in: "elsewhere")
    await controller.enterForeground()
    XCTAssertFalse(stream.closed)
    XCTAssertEqual(script.dials, 1)
    XCTAssertEqual(controller.status, .connected)
    await controller.finishAnsweringQuestion()
    XCTAssertEqual(script.dials, 1)
    await controller.leave()
  }

  func test_answer_tapped_during_the_foreground_redial_stops_the_attach() async {
    let stream = ScriptedByteStream()
    let script = DialScript([ScriptedByteStream(), stream])
    let controller = makeController(script)
    await controller.connect()
    await controller.suspendNow()
    script.close()
    let redial = Task { await controller.enterForeground() }
    let entered = await eventually { script.hasEntered }
    XCTAssertTrue(entered)
    await controller.beginAnsweringQuestion(in: "work")
    script.open()
    await redial.value
    XCTAssertTrue(stream.closed, "a redial that lands after Answer… must not stay attached")
    XCTAssertNotEqual(controller.status, .connected)
    await controller.leave()
  }
}

final class FlushPushCommandTests: XCTestCase {
  func test_the_command_quotes_the_session_and_tolerates_a_missing_tool() {
    let command = SSHTerminalController.flushPushCommand(session: "it's work")
    XCTAssertTrue(command.contains("flush --session 'it'\\''s work'"))
    XCTAssertTrue(command.contains("command -v ~/.local/bin/tether-notify >/dev/null &&"))
    XCTAssertTrue(command.hasSuffix("|| true"))
  }
}
