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
    return SSHTerminalController(
      title: "test", config: config, hostKeyStore: store, attach: "work",
      dial: { try await script.dial($0, $1) },
      control: ControlConnection(config: config, store: store) { ops })
      .creating("work", "b", "c", "d")
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

  /// Killing the last session leaves the bare login shell under the empty state: typing must
  /// not reach it. Its reports are still kept — the pipeline only sends changes, so one
  /// dropped here would be missing once the next session attaches.
  func test_killing_the_only_session_gates_input_but_keeps_reports() async {
    let stream = ScriptedByteStream()
    let ops = FakeOps()
    ops.execResult = { _ in "" }
    let controller = makeController(DialScript([stream]), ops)
    await controller.connect()

    await controller.killSession("work")
    stream.push(Data("\u{1B}]2;login shell\u{07}".utf8))
    let reported = await eventually { controller.terminalReport.title == "login shell" }
    controller.sendInput("typed")
    controller.sendPaste("pasted")
    try? await Task.sleep(nanoseconds: 300_000_000)

    XCTAssertFalse(controller.hasSession)
    XCTAssertTrue(reported)
    XCTAssertFalse(stream.writtenText.contains("typed"), stream.writtenText)
    XCTAssertFalse(stream.writtenText.contains("pasted"), stream.writtenText)
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

@MainActor
final class SSHTerminalControllerSessionSwitchTests: XCTestCase {
  private let config = SSHConnectionConfig(
    host: "example.internal", port: 22, username: "sam", credentials: [.password("pw")])

  func test_a_launch_attaches_nothing_and_picking_a_session_is_a_switch() async {
    let store = InMemoryHostKeyStore()
    let ops = FakeOps()
    ops.execResult = { command in
      command.hasSuffix(" ls")
        ? "name=servers\tpid=1\tclients=0\tcreated=1789875110\tcwd=file://h/home/sam\n"
          + "name=work\tpid=2\tclients=0\tcreated=1789875100\tcwd=file://h/home/sam\n"
        : ""
    }
    let stream = ScriptedByteStream()
    let controller = SSHTerminalController(
      title: "test", config: config, hostKeyStore: store,
      dial: { _, _ in stream },
      control: ControlConnection(config: config, store: store) { ops })
    await controller.connect()
    let listed = await eventually { controller.sessions.count == 2 }
    XCTAssertTrue(listed, "the empty screen lists the sessions to pick from")
    XCTAssertFalse(stream.writtenText.contains("zmx attach"), stream.writtenText)
    XCTAssertFalse(controller.hasSession)
    XCTAssertEqual(controller.sessionSwitches, 0)

    await controller.switchSession(to: "work")
    XCTAssertEqual(controller.attach, "work")
    XCTAssertEqual(controller.sessionSwitches, 1)
    await controller.leave()
  }

  func test_a_chosen_session_the_host_could_not_list_is_attached_by_the_next_listing_that_shows_it() async {
    let stream = ScriptedByteStream()
    let ops = FakeOps()
    let lock = NSLock()
    var lsCalls = 0
    ops.execResult = { command in
      guard command.contains("zmx ls") else { return "" }
      lock.lock(); lsCalls += 1; let n = lsCalls; lock.unlock()
      if n <= 3 { throw SSHConnectError.commandTimedOut }
      return "name=work\tpid=1\tclients=0\tcreated=5\tcwd=x\n"
    }
    let store = InMemoryHostKeyStore()
    let controller = SSHTerminalController(
      title: "test", config: config, hostKeyStore: store, attach: "work", picked: true,
      dial: { _, _ in stream },
      control: ControlConnection(config: config, store: store) { ops })

    await controller.connect()
    let attached = await eventually(timeout: 5) { stream.writtenText.contains("attach 'work'") }

    XCTAssertTrue(attached, stream.writtenText)
    XCTAssertEqual(stream.writtenText.components(separatedBy: "zmx attach").count, 2, stream.writtenText)
    await controller.leave()
  }

  func test_an_empty_host_creates_nothing() async {
    let stream = ScriptedByteStream()
    let ops = FakeOps()
    ops.execResult = { command in command.contains("zmx ls") ? "no sessions found in /tmp/zmx-1000\n" : "" }
    let store = InMemoryHostKeyStore()
    let controller = SSHTerminalController(
      title: "test", config: config, hostKeyStore: store,
      dial: { _, _ in stream },
      control: ControlConnection(config: config, store: store) { ops })

    await controller.connect()
    try? await Task.sleep(nanoseconds: 300_000_000)

    XCTAssertFalse(stream.writtenText.contains("zmx attach"), stream.writtenText)
    XCTAssertFalse(controller.hasSession)
    await controller.leave()
  }

  private func linkedController(
    to name: String, listing: String, stream: ScriptedByteStream
  ) -> SSHTerminalController {
    let ops = FakeOps()
    ops.execResult = { command in command.contains("zmx ls") ? listing : "" }
    let store = InMemoryHostKeyStore()
    return SSHTerminalController(
      title: "test", config: config, hostKeyStore: store, attach: name, picked: true,
      dial: { _, _ in stream },
      control: ControlConnection(config: config, store: store) { ops })
  }

  func test_a_link_to_a_session_on_an_empty_host_creates_nothing() async {
    let stream = ScriptedByteStream()
    let controller = linkedController(to: "default", listing: "no sessions found in /tmp/zmx-1000\n", stream: stream)

    await controller.connect()
    try? await Task.sleep(nanoseconds: 300_000_000)

    XCTAssertFalse(stream.writtenText.contains("zmx attach"), stream.writtenText)
    XCTAssertFalse(controller.hasSession)
    await controller.leave()
  }

  func test_a_link_attaches_its_session_when_listed_else_nothing() async {
    let listing = "name=work\tpid=1\tclients=0\tcreated=5\tcwd=x\nname=api\tpid=2\tclients=0\tcreated=9\tcwd=x\n"
    let linked = linkedController(to: "work", listing: listing, stream: ScriptedByteStream())
    await linked.connect()
    XCTAssertEqual(linked.attach, "work")
    await linked.leave()

    let goneStream = ScriptedByteStream()
    let gone = linkedController(to: "killed", listing: listing, stream: goneStream)
    await gone.connect()
    try? await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertFalse(goneStream.writtenText.contains("zmx attach"), goneStream.writtenText)
    XCTAssertFalse(gone.hasSession)
    await gone.leave()
  }

  func test_a_link_tapped_while_connected_never_creates_its_session() async {
    let stream = ScriptedByteStream()
    let controller = linkedController(to: "work", listing: "no sessions found in /tmp/zmx-1000\n", stream: stream)
    await controller.connect()

    await controller.switchSession(to: "default")

    XCTAssertFalse(stream.writtenText.contains("zmx attach"), stream.writtenText)
    XCTAssertFalse(controller.hasSession)
    await controller.leave()
  }

  func test_a_redial_after_the_session_ended_does_not_recreate_it() async {
    let first = ScriptedByteStream()
    let second = ScriptedByteStream()
    let ops = FakeOps()
    let lock = NSLock()
    var listing = "name=work\tpid=1\tclients=0\tcreated=5\tcwd=x\n"
    ops.execResult = { command in
      lock.lock(); defer { lock.unlock() }
      return command.contains("zmx ls") ? listing : ""
    }
    let store = InMemoryHostKeyStore()
    let script = DialScript([first, second])
    let controller = SSHTerminalController(
      title: "test", config: config, hostKeyStore: store, attach: "work", picked: true,
      dial: { try await script.dial($0, $1) },
      control: ControlConnection(config: config, store: store) { ops })
    await controller.connect()
    let attached = await eventually { first.writtenText.contains("attach 'work'") }
    XCTAssertTrue(attached, first.writtenText)

    lock.lock(); listing = "no sessions found in /tmp/zmx-1000\n"; lock.unlock()
    await controller.connect(trigger: .manual)
    try? await Task.sleep(nanoseconds: 300_000_000)

    XCTAssertFalse(second.writtenText.contains("zmx attach"), second.writtenText)
    XCTAssertFalse(controller.hasSession)
    await controller.leave()
  }

  func test_a_tap_on_a_session_that_ended_since_the_last_listing_does_not_recreate_it() async {
    let stream = ScriptedByteStream()
    let ops = FakeOps()
    let lock = NSLock()
    var listing = "name=work\tpid=1\tclients=0\tcreated=5\tcwd=x\nname=api\tpid=2\tclients=0\tcreated=9\tcwd=x\n"
    ops.execResult = { command in
      lock.lock(); defer { lock.unlock() }
      return command.contains("zmx ls") ? listing : ""
    }
    let store = InMemoryHostKeyStore()
    let controller = SSHTerminalController(
      title: "test", config: config, hostKeyStore: store, attach: "work", picked: true,
      dial: { _, _ in stream },
      control: ControlConnection(config: config, store: store) { ops })
    await controller.connect()
    let listed = await eventually { controller.sessions.contains { $0.name == "api" } }
    XCTAssertTrue(listed)

    lock.lock(); listing = "name=work\tpid=1\tclients=0\tcreated=5\tcwd=x\n"; lock.unlock()
    await controller.switchSession(to: "api")

    XCTAssertFalse(stream.writtenText.contains("attach 'api'"), stream.writtenText)
    XCTAssertEqual(controller.attach, "work")
    await controller.leave()
  }

  func test_new_session_is_the_only_way_to_create_one() async {
    let stream = ScriptedByteStream()
    let controller = SSHTerminalController(
      title: "test", config: config, hostKeyStore: InMemoryHostKeyStore(),
      dial: { _, _ in stream },
      control: ControlConnection(config: config, store: InMemoryHostKeyStore()) { FakeOps() })
    await controller.connect()

    await controller.switchSession(to: "notes")
    XCTAssertFalse(stream.writtenText.contains("zmx attach"), stream.writtenText)

    await controller.createSession("notes")
    let created = await eventually { stream.writtenText.contains("attach 'notes'") }
    XCTAssertTrue(created, stream.writtenText)
    XCTAssertTrue(controller.hasSession)
    await controller.leave()
  }
}
