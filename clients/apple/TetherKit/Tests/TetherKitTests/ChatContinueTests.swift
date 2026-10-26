import XCTest
@testable import TetherKit

final class ChatContinueTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 1_800_000_000)

  private func line(_ id: String, _ title: String, _ updatedAt: String) -> String {
    #"{"sessionId":"\#(id)","title":"\#(title)","updatedAt":"\#(updatedAt)","cwd":"/srv/api"}"#
  }

  func test_saved_sessions_parse_with_and_without_fractional_seconds() {
    let output = [line("s-1", "Add retry", "2027-01-15T08:00:00.123Z"), line("s-2", "", "2027-01-14T08:00:00Z")]
      .joined(separator: "\n")
    let result = ACPSavedSessionListing.parse(output)
    XCTAssertNil(result.failure)
    XCTAssertEqual(result.sessions.map(\.sessionId), ["s-1", "s-2"])
    XCTAssertEqual(result.sessions[0].displayTitle, "Add retry")
    XCTAssertEqual(result.sessions[1].displayTitle, "Untitled conversation")
    XCTAssertNotNil(result.sessions[0].updatedAt)
    XCTAssertEqual(
      result.sessions[0].updatedAt!.timeIntervalSince(result.sessions[1].updatedAt!), 86400.123, accuracy: 0.01)
  }

  func test_no_output_is_an_empty_list_and_a_failure_line_is_the_reason() {
    XCTAssertEqual(ACPSavedSessionListing.parse(""), .init(sessions: [], failure: nil))
    let failed = ACPSavedSessionListing.parse("tether: agent exited before listing sessions")
    XCTAssertEqual(failed.failure, "agent exited before listing sessions")
    XCTAssertTrue(failed.sessions.isEmpty)
    XCTAssertTrue(
      ACPSavedSessionListing.parse("tether: unknown acp command \"sessions\"").failure?.contains("Update it") == true)
  }

  func test_a_stray_line_beside_sessions_is_not_a_failure() {
    let result = ACPSavedSessionListing.parse("npm warn something\n" + line("s-1", "x", "2027-01-15T08:00:00Z"))
    XCTAssertNil(result.failure)
    XCTAssertEqual(result.sessions.count, 1)
  }

  func test_a_conversation_updated_within_ten_minutes_gets_the_caution() {
    XCTAssertTrue(ChatContinueFormat.isRecent(now.addingTimeInterval(-60), now: now))
    XCTAssertTrue(ChatContinueFormat.isRecent(now.addingTimeInterval(-599), now: now))
    XCTAssertFalse(ChatContinueFormat.isRecent(now.addingTimeInterval(-601), now: now))
    XCTAssertFalse(ChatContinueFormat.isRecent(nil, now: now))
  }

  func test_relative_times_read_naturally() {
    func ago(_ seconds: Double) -> String { ChatContinueFormat.relative(now.addingTimeInterval(-seconds), now: now) }
    XCTAssertEqual(ago(10), "just now")
    XCTAssertEqual(ago(300), "5 min ago")
    XCTAssertEqual(ago(7300), "2 h ago")
    XCTAssertEqual(ago(86400 * 3), "3 d ago")
    XCTAssertEqual(ChatContinueFormat.relative(nil, now: now), "")
  }

  func test_the_sessions_command_quotes_a_hostile_folder_and_folds_stderr_in() {
    let command = ACPHostCommand.sessions(cwd: "/tmp/it's $(rm -rf ~)", limit: 20)
    XCTAssertTrue(command.contains(" sessions '/tmp/it'\"'\"'s $(rm -rf ~)' --limit 20"))
    XCTAssertTrue(command.hasSuffix("2>&1"))
  }

  func test_loading_resolves_home_asks_for_twenty_and_parses() async {
    let seen = LockedBox<[String]>([])
    let result = await ChatContinueLoader.load(folderText: "~/proj") { command in
      seen.update { $0.append(command) }
      if command == ACPHostCommand.home { return "/home/dev" }
      return self.line("s-1", "Add retry", "2027-01-15T08:00:00Z")
    }
    guard case let .loaded(sessions) = result else { return XCTFail("expected a list") }
    XCTAssertEqual(sessions.map(\.sessionId), ["s-1"])
    XCTAssertEqual(seen.value.last, ACPHostCommand.sessions(cwd: "/home/dev/proj", limit: 20))
  }

  func test_loading_an_empty_folder_gives_an_empty_list() async {
    let result = await ChatContinueLoader.load(folderText: "/srv/x") { _ in "" }
    XCTAssertEqual(result, .loaded([]))
  }

  func test_loading_reports_the_host_error_and_a_dead_connection() async {
    let refused = await ChatContinueLoader.load(folderText: "/srv/x") { _ in "tether: agent exited before listing sessions" }
    XCTAssertEqual(refused, .failed("agent exited before listing sessions"))
    let down = await ChatContinueLoader.load(folderText: "/srv/x") { _ in throw SSHConnectError.transport("down") }
    guard case let .failed(message) = down else { return XCTFail("expected a failure") }
    XCTAssertTrue(message.hasPrefix("Couldn't reach the host"))
    let noHome = await ChatContinueLoader.load(folderText: "~") { _ in throw SSHConnectError.transport("down") }
    XCTAssertEqual(noHome, .failed("Couldn't read the host's home folder."))
  }

  func test_a_host_that_never_answers_gives_up_at_the_deadline() async {
    let started = Date()
    let result = await ChatContinueLoader.load(folderText: "/srv/x", deadline: 0.2) { _ in
      // Ignores cancellation, like the control connection's exec.
      await withCheckedContinuation { (_: CheckedContinuation<Void, Never>) in }
      return ""
    }
    XCTAssertEqual(result, .failed("The host took too long to answer."))
    XCTAssertLessThan(Date().timeIntervalSince(started), 2)
  }

  func test_continuing_carries_the_session_id_on_the_route_and_keeps_the_host_checks() async {
    let session = ACPSavedSession(sessionId: "s-9", title: "T", updatedAt: nil, cwd: "/srv/x")
    let ready = await ChatRoute.startContinuing(session: session, cwdText: "/srv/x", host: "dev") { command in
      command.hasPrefix("sh -c") ? "notify=ok\nnode=ok" : ""
    }
    guard case let .ready(route) = ready else { return XCTFail("expected a route") }
    XCTAssertEqual(route.loadSessionId, "s-9")
    XCTAssertEqual(route.cwd, "/srv/x")
    XCTAssertFalse(route.readOnly)
    let blocked = await ChatRoute.startContinuing(session: session, cwdText: "/srv/x", host: "dev") { _ in "node=missing" }
    XCTAssertEqual(blocked, .failed("Node.js is required on dev."))
  }
}
