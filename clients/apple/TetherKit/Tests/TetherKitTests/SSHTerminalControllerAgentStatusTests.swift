import XCTest
@testable import TetherKit

@MainActor
final class SSHTerminalControllerAgentStatusTests: XCTestCase {
  private let config = SSHConnectionConfig(
    host: "example.internal", port: 22, username: "sam", credentials: [.password("pw")])

  private func row(_ session: String, _ state: String, since: Int = 100) -> String {
    #"{"session":"\#(session)","agent":"claude","state":"\#(state)","since":\#(since),"updated":\#(since),"message":"m","link":"tether://session/\#(session)?host=devbox"}"#
  }

  /// Answers `zmx ls` at once and `tether-notify` with `status()`, read on every call so a
  /// test can change the host's answer between reads.
  private func makeOps(_ status: @escaping () throws -> String) -> FakeOps {
    let ops = FakeOps()
    let zmxLs = "name=work\tpid=1\tclients=1\tcreated=0\tcwd=x\n"
    ops.execResult = { command in command.contains("tether-notify") ? try status() : zmxLs }
    return ops
  }

  private func makeController(_ ops: FakeOps) -> SSHTerminalController {
    let store = InMemoryHostKeyStore()
    return SSHTerminalController(
      title: "test", config: config, hostKeyStore: store, attach: "work",
      dial: { _, _ in ScriptedByteStream() },
      control: ControlConnection(config: config, store: store) { ops })
  }

  /// connect() refreshes sessions — and so agent status — in the background; let that land
  /// before the test's own reads, or it races them.
  private func connectSettled(_ controller: SSHTerminalController, _ ops: FakeOps) async {
    await controller.connect()
    _ = await eventually { ops.commands.contains { $0.contains("tether-notify") } }
    try? await Task.sleep(nanoseconds: 50_000_000)
  }

  private func statusExecs(_ ops: FakeOps) -> Int {
    ops.commands.filter { $0.contains("tether-notify") }.count
  }

  func test_first_read_fills_statuses_without_an_alert() async {
    let waiting = "[\(row("other", "waiting"))]"
    let ops = makeOps { waiting }
    let controller = makeController(ops)
    await connectSettled(controller, ops)
    await controller.refreshAgentStatus()
    XCTAssertEqual(controller.agentStatuses["other"]?.state, .waiting)
    XCTAssertNil(controller.agentAlert)
    XCTAssertTrue(controller.othersWaiting)
    await controller.leave()
  }

  func test_another_session_starting_to_wait_raises_an_alert_and_the_current_one_does_not() async {
    var reply = "[\(row("other", "working")),\(row("work", "working"))]"
    let ops = makeOps { reply }
    let controller = makeController(ops)
    await connectSettled(controller, ops)
    await controller.refreshAgentStatus()

    reply = "[\(row("other", "working")),\(row("work", "waiting", since: 200))]"
    await controller.refreshAgentStatus()
    XCTAssertNil(controller.agentAlert, "the session on screen never raises a banner")

    reply = "[\(row("other", "waiting", since: 300)),\(row("work", "waiting", since: 200))]"
    await controller.refreshAgentStatus()
    XCTAssertEqual(controller.agentAlert?.session, "other")

    reply = "[\(row("other", "working", since: 400)),\(row("work", "waiting", since: 200))]"
    await controller.refreshAgentStatus()
    XCTAssertNil(controller.agentAlert, "a banner goes once its session moves on")
    await controller.leave()
  }

  func test_a_host_without_tether_notify_shows_nothing_and_stops_asking() async {
    let ops = makeOps { "__tether_notify_missing\n" }
    let controller = makeController(ops)
    await connectSettled(controller, ops)
    await controller.refreshAgentStatus()
    let asked = statusExecs(ops)
    XCTAssertEqual(asked, 1, "only the connect's own read asked")
    await controller.refreshAgentStatus()
    await controller.refreshAgentStatus()
    XCTAssertTrue(controller.agentStatuses.isEmpty)
    XCTAssertEqual(statusExecs(ops), asked, "a missing tool must not be asked again until the next connect")
    await controller.leave()
  }

  func test_a_failed_read_keeps_statuses_until_they_are_stale() async {
    var fail = false
    let working = "[\(row("other", "working"))]"
    let ops = makeOps {
      if fail { throw SSHConnectError.transport("channel closed") }
      return working
    }
    let controller = makeController(ops)
    var now = Date(timeIntervalSince1970: 1_000)
    controller.clock = { now }  // before connect: its background read stamps the clock too
    await connectSettled(controller, ops)
    await controller.refreshAgentStatus()

    fail = true
    now = now.addingTimeInterval(10)
    await controller.refreshAgentStatus()
    XCTAssertEqual(controller.agentStatuses.count, 1, "one failed read keeps the last answer")

    now = now.addingTimeInterval(25)
    await controller.refreshAgentStatus()
    XCTAssertTrue(controller.agentStatuses.isEmpty, "30 s without a read drops rather than shows stale")
    await controller.leave()
  }

  func test_a_push_is_covered_only_when_its_banner_is_showing() async {
    var reply = "[\(row("other", "working"))]"
    let ops = makeOps { reply }
    let controller = makeController(ops)
    let pushed = SessionDeepLink(sessionId: "other", identityName: "devbox")

    let beforeConnect = await controller.coversPush(pushed)
    XCTAssertFalse(beforeConnect)
    await connectSettled(controller, ops)

    reply = "[\(row("other", "done", since: 200))]"
    let covered = await controller.coversPush(pushed)
    XCTAssertTrue(covered, "the push's own refresh raised the in-app banner")
    let otherHost = await controller.coversPush(SessionDeepLink(sessionId: "other", identityName: "elsewhere"))
    XCTAssertFalse(otherHost)
    await controller.leave()
  }

  func test_a_push_with_no_banner_behind_it_still_shows() async {
    let working = "[\(row("other", "working"))]"
    let ops = makeOps { working }
    let controller = makeController(ops)
    await connectSettled(controller, ops)

    // An agent outside zmx pushes without a state file; a session that is still working raises no banner.
    let stateless = await controller.coversPush(SessionDeepLink(sessionId: "lonely", identityName: "devbox"))
    let noBanner = await controller.coversPush(SessionDeepLink(sessionId: "other", identityName: "devbox"))
    XCTAssertFalse(stateless, "hiding it would lose the notification entirely")
    XCTAssertFalse(noBanner)
    await controller.leave()
  }

  func test_an_older_tether_notify_without_status_stops_being_asked() async {
    // An old binary prints usage to stderr (discarded) and nothing on stdout.
    let ops = makeOps { "" }
    let controller = makeController(ops)
    await connectSettled(controller, ops)
    let asked = statusExecs(ops)
    await controller.refreshAgentStatus()
    await controller.refreshAgentStatus()
    XCTAssertEqual(statusExecs(ops), asked, "a host that cannot answer must not be polled every 5 s")
    await controller.leave()
  }

  func test_expire_only_clears_the_banner_it_was_asked_about() async throws {
    var reply = "[\(row("other", "working"))]"
    let ops = makeOps { reply }
    let controller = makeController(ops)
    await connectSettled(controller, ops)
    await controller.refreshAgentStatus()
    reply = "[\(row("other", "done", since: 200))]"
    await controller.refreshAgentStatus()
    let first = try XCTUnwrap(controller.agentAlert)

    reply = "[\(row("other", "done", since: 300))]"
    await controller.refreshAgentStatus()
    controller.expireAgentAlert(first)
    XCTAssertEqual(controller.agentAlert?.since, Date(timeIntervalSince1970: 300), "a newer banner outlives the old timer")
    controller.dismissAgentAlert()
    XCTAssertNil(controller.agentAlert)
    await controller.leave()
  }


  func test_the_controller_answers_to_the_host_label_its_status_reports() async {
    let done = "[\(row("other", "done"))]"
    let ops = makeOps { done }
    let controller = makeController(ops)
    XCTAssertFalse(controller.answers(toHostLabel: "devbox"), "nothing is known before a status read")
    await connectSettled(controller, ops)
    XCTAssertTrue(controller.answers(toHostLabel: "devbox"))
    XCTAssertFalse(controller.answers(toHostLabel: "elsewhere"))
    await controller.leave()
  }
}
