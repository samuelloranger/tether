import XCTest
@testable import TetherKit

/// Leaving and redialing must never leave a connection behind, and must never
/// wait behind a command stuck on the path that just died.
@MainActor
final class SSHTerminalControllerLifecycleTests: XCTestCase {
  private let config = SSHConnectionConfig(
    host: "example.internal", port: 22, username: "sam", credentials: [.password("pw")])

  private func makeController(_ script: DialScript, _ ops: FakeOps) -> SSHTerminalController {
    let store = InMemoryHostKeyStore()
    // A named attach skips the first-connect `zmx ls`, keeping the dial the only work.
    return SSHTerminalController(
      title: "test", config: config, hostKeyStore: store, attach: "work",
      dial: { try await script.dial($0, $1) },
      control: ControlConnection(config: config, store: store) { ops })
  }

  func test_a_dial_that_finishes_after_leaving_closes_its_stream() async {
    let stream = ScriptedByteStream()
    let script = DialScript([stream], held: true)
    let controller = makeController(script, FakeOps())
    let connecting = Task { await controller.connect() }
    let entered = await eventually { script.hasEntered }
    XCTAssertTrue(entered)

    await controller.leave()
    script.open()
    await connecting.value

    XCTAssertTrue(stream.closed, "a stream dialed for a screen that is gone must be closed")
    XCTAssertNotEqual(controller.status, .connected)
  }

  func test_a_redial_after_a_drop_resets_the_control_connection() async {
    let first = ScriptedByteStream()
    let second = ScriptedByteStream()
    let script = DialScript([first, second])
    let ops = FakeOps()
    let controller = makeController(script, ops)
    await controller.connect()
    _ = await controller.historyText()

    await first.close()

    let redialed = await eventually { script.dials == 2 && controller.status == .connected }
    XCTAssertTrue(redialed)
    XCTAssertGreaterThanOrEqual(ops.interrupts, 1, "the control session rode the dead path and must be cut")
    await controller.leave()
  }

  func test_leaving_disconnects_the_terminal_even_with_a_command_stuck() async {
    let stream = ScriptedByteStream()
    let script = DialScript([stream])
    let ops = FakeOps()
    ops.execResult = { [unowned ops] command in
      command.contains("history") ? try ops.hang(command) : ""
    }
    let controller = makeController(script, ops)
    await controller.connect()
    let history = Task { await controller.historyText() }
    let hanging = await eventually { ops.isHanging }
    XCTAssertTrue(hanging)

    let leaving = Task { await controller.leave() }
    let closed = await eventually(timeout: 1) { stream.closed }

    XCTAssertTrue(closed, "the terminal must not outlive the screen behind a stuck command")
    // Unsticks a regressed build so it fails here instead of hanging the suite.
    ops.interrupt()
    await leaving.value
    _ = await history.value
  }

  func test_switching_off_the_interface_in_use_redials_at_once() async {
    let first = ScriptedByteStream()
    let second = ScriptedByteStream()
    let script = DialScript([first, second])
    let controller = makeController(script, FakeOps())
    await controller.connect()
    controller.pathChanged(NetworkReachability(availability: .usable, interfaces: [.wifi]))

    controller.pathChanged(NetworkReachability(availability: .usable, interfaces: [.cellular]))

    let redialed = await eventually { script.dials == 2 && controller.status == .connected }
    XCTAssertTrue(redialed, "the old socket is bound to an address that no longer routes")
    let oldClosed = await eventually { first.closed }
    XCTAssertTrue(oldClosed)
    await controller.leave()
  }

  func test_going_offline_says_so_at_once_and_redials_when_the_path_returns() async {
    let first = ScriptedByteStream()
    let second = ScriptedByteStream()
    let script = DialScript([first, second])
    let controller = makeController(script, FakeOps())
    await controller.connect()
    let wifi = NetworkReachability(availability: .usable, interfaces: [.wifi])
    controller.pathChanged(wifi)

    controller.pathChanged(NetworkReachability(availability: .offline))

    XCTAssertEqual(controller.status, .disconnected, "no more 'live' on a dead path")
    XCTAssertEqual(
      SSHTerminalController.connectionCopy(status: controller.status, reachability: controller.reachability)?.message,
      "Waiting for a network connection")
    try? await Task.sleep(nanoseconds: 100_000_000)
    XCTAssertEqual(script.dials, 1, "no dial into an offline path")

    controller.pathChanged(wifi)

    let back = await eventually { script.dials == 2 && controller.status == .connected }
    XCTAssertTrue(back)
    await controller.leave()
  }
}
