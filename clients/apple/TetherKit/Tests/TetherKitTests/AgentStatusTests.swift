import XCTest
@testable import TetherKit

final class AgentStatusTests: XCTestCase {
  private func status(_ session: String, _ state: AgentStatus.State, since: TimeInterval = 100) -> AgentStatus {
    AgentStatus(session: session, agent: "claude", state: state,
                since: Date(timeIntervalSince1970: since), updated: Date(timeIntervalSince1970: since),
                message: "", link: "tether://session/\(session)?host=devbox")
  }

  func test_parses_status_output() {
    let out = """
    [{"session":"App terminal ssh","agent":"claude","state":"waiting","since":100,"updated":120,"message":"Allow Bash?","link":"tether://session/App%20terminal%20ssh?host=devbox","agentPid":7}]
    """
    let parsed = AgentStatus.parse(out)
    XCTAssertEqual(parsed.count, 1)
    XCTAssertEqual(parsed[0].session, "App terminal ssh")
    XCTAssertEqual(parsed[0].state, .waiting)
    XCTAssertEqual(parsed[0].since, Date(timeIntervalSince1970: 100))
    XCTAssertEqual(parsed[0].message, "Allow Bash?")
    XCTAssertEqual(parsed[0].hostLabel, "devbox")
  }

  func test_malformed_or_empty_output_is_no_statuses() {
    XCTAssertTrue(AgentStatus.parse("").isEmpty)
    XCTAssertTrue(AgentStatus.parse("not json").isEmpty)
    XCTAssertTrue(AgentStatus.parse("{\"session\":\"x\"}").isEmpty)
    XCTAssertTrue(AgentStatus.parse("[]\n").isEmpty)
  }

  func test_rows_with_an_unknown_state_or_no_session_are_skipped() {
    let out = #"[{"session":"a","state":"thinking"},{"session":"","state":"done"},{"session":"b","state":"done"}]"#
    XCTAssertEqual(AgentStatus.parse(out).map(\.session), ["b"])
  }

  func test_first_read_is_a_baseline() {
    XCTAssertTrue(AgentStatusChanges.alerts(old: nil, new: [status("b", .waiting)], current: "a").isEmpty)
  }

  func test_another_session_entering_waiting_or_done_alerts() {
    let old = ["b": status("b", .working), "c": status("c", .working)]
    let alerts = AgentStatusChanges.alerts(old: old, new: [status("b", .waiting), status("c", .done)], current: "a")
    XCTAssertEqual(alerts.map(\.session), ["b", "c"])
  }

  func test_the_current_session_never_alerts() {
    let old = ["a": status("a", .working)]
    XCTAssertTrue(AgentStatusChanges.alerts(old: old, new: [status("a", .waiting)], current: "a").isEmpty)
  }

  func test_staying_in_a_state_does_not_alert_but_a_new_turn_does() {
    let old = ["b": status("b", .done, since: 100)]
    XCTAssertTrue(AgentStatusChanges.alerts(old: old, new: [status("b", .done, since: 100)], current: "a").isEmpty)
    XCTAssertEqual(AgentStatusChanges.alerts(old: old, new: [status("b", .done, since: 300)], current: "a").count, 1)
  }

  func test_a_session_first_seen_waiting_alerts() {
    XCTAssertEqual(AgentStatusChanges.alerts(old: [:], new: [status("b", .waiting)], current: "a").count, 1)
  }

  func test_working_never_alerts() {
    XCTAssertTrue(AgentStatusChanges.alerts(old: [:], new: [status("b", .working)], current: "a").isEmpty)
  }

  func test_banner_lifetime() {
    XCTAssertNil(status("b", .waiting).bannerLifetime)
    XCTAssertEqual(status("b", .done).bannerLifetime, 6)
  }

  func test_age_label() {
    let since = Date(timeIntervalSince1970: 1_000)
    XCTAssertEqual(AgentStatus.ageLabel(since: since, now: since.addingTimeInterval(30)), "now")
    XCTAssertEqual(AgentStatus.ageLabel(since: since, now: since.addingTimeInterval(5 * 60)), "5m")
    XCTAssertEqual(AgentStatus.ageLabel(since: since, now: since.addingTimeInterval(2 * 3600)), "2h")
    XCTAssertEqual(AgentStatus.ageLabel(since: since, now: since.addingTimeInterval(3 * 86400)), "3d")
    XCTAssertEqual(AgentStatus.ageLabel(since: since, now: since.addingTimeInterval(-10)), "now")
  }
}
