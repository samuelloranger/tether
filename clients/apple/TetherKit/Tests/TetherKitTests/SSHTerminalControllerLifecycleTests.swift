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

  func test_a_fresh_pty_gets_the_settled_size_not_a_keyboard_animation_frame() async {
    let stream = ScriptedByteStream()
    let controller = makeController(DialScript([stream]), FakeOps())
    controller.updateGridServer(cols: 100, rows: 30)
    controller.updateGrid(cols: 100, rows: 47)
    await controller.connect()
    let resized = await eventually { !stream.resizes.isEmpty }
    XCTAssertTrue(resized)
    // Anything after the first resize would land here too: the PTY only hears real changes.
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(stream.resizes.first, [100, 30])
    XCTAssertFalse(stream.resizes.contains([100, 47]), "\(stream.resizes)")
    await controller.leave()
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
  /// Taps faster than a switch takes: each switch types in full before the next starts, and
  /// one a later tap replaced while it waited is never typed.
  func test_overlapping_switches_type_one_at_a_time_and_skip_replaced_ones() async {
    let stream = ScriptedByteStream()
    let ops = FakeOps()
    ops.execResult = { _ in "" }
    let controller = makeController(DialScript([stream]), ops)
    await controller.connect()
    // Past the first attach's settle time, so b starts at once.
    try? await Task.sleep(nanoseconds: 300_000_000)
    var taps: [Task<Void, Never>] = []
    for name in ["b", "c", "d"] {
      taps.append(Task { await controller.switchSession(to: name) })
      try? await Task.sleep(nanoseconds: 20_000_000)
    }
    for tap in taps { await tap.value }

    let typed = await eventually { stream.writtenText.contains("attach 'd'") }
    XCTAssertTrue(typed)
    let events = stream.writtenText.compactMap { character -> String? in
      character == "\u{1C}" ? "detach" : nil
    }
    XCTAssertEqual(events.count, 2)
    let attaches = stream.writtenText.components(separatedBy: "attach '").dropFirst().map { $0.prefix(1) }
    XCTAssertEqual(attaches, ["w", "b", "d"])
    // Every attach after the first follows its own detach.
    let order = stream.writtenText.filter { $0 == "\u{1C}" || $0 == "\n" }
    XCTAssertEqual(String(order), "\n\u{1C}\n\u{1C}\n")
    XCTAssertEqual(controller.attach, "d")
    await controller.leave()
  }

  /// A tap just after the previous switch finished: its detach key still waits until the
  /// previous attach has had time to start, or it reaches the shell and its attach lands
  /// inside the session just opened.
  func test_a_switch_right_after_another_waits_for_its_attach_to_settle() async throws {
    let stream = ScriptedByteStream()
    let ops = FakeOps()
    ops.execResult = { _ in "" }
    let controller = makeController(DialScript([stream]), ops)
    await controller.connect()
    let first = Task { await controller.switchSession(to: "b") }
    // The next tap lands as soon as b's attach is typed, while the switch still refreshes.
    let attached = await eventually { stream.writtenText.contains("attach 'b'") }
    XCTAssertTrue(attached)
    let second = Task { await controller.switchSession(to: "c") }
    await first.value
    await second.value

    let typed = await eventually { stream.writtenText.contains("attach 'c'") }
    XCTAssertTrue(typed)
    let writes = stream.timedWrites
    let attachB = try XCTUnwrap(writes.firstIndex { $0.text.contains("attach 'b'") })
    let detachC = try XCTUnwrap(writes[(attachB + 1)...].firstIndex { $0.text.contains("\u{1C}") })
    let gap = writes[detachC].at - writes[attachB].at
    // The settle time is 250 ms from when the attach was queued; without the wait the gap is
    // a few ms. The margin absorbs queueing delay on a loaded simulator.
    XCTAssertGreaterThanOrEqual(gap, .milliseconds(150))
    XCTAssertEqual(controller.attach, "c")
    await controller.leave()
  }

  /// A connect types an attach too: a switch tapped right after it waits the same way.
  func test_a_switch_right_after_connecting_waits_for_the_first_attach_to_settle() async throws {
    let stream = ScriptedByteStream()
    let ops = FakeOps()
    ops.execResult = { _ in "" }
    let controller = makeController(DialScript([stream]), ops)
    await controller.connect()
    let attached = await eventually { stream.writtenText.contains("attach '") }
    XCTAssertTrue(attached)
    await controller.switchSession(to: "b")

    let writes = stream.timedWrites
    let first = try XCTUnwrap(writes.firstIndex { $0.text.contains("attach '") })
    let detach = try XCTUnwrap(writes[(first + 1)...].firstIndex { $0.text.contains("\u{1C}") })
    XCTAssertGreaterThanOrEqual(writes[detach].at - writes[first].at, .milliseconds(150))
    await controller.leave()
  }
}
