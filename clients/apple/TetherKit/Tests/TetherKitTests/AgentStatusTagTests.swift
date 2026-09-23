import XCTest
@testable import TetherKit

final class AgentStatusTagTests: XCTestCase {
  private func status(_ state: AgentStatus.State) -> AgentStatus {
    AgentStatus(session: "b", agent: "claude", state: state,
                since: Date(timeIntervalSince1970: 1_000), updated: Date(timeIntervalSince1970: 1_000),
                message: "", link: "")
  }

  func test_labels_are_words_not_just_colour() {
    let now = Date(timeIntervalSince1970: 1_000 + 5 * 60)
    XCTAssertEqual(AgentStatusTag.label(for: status(.working), now: now), "working")
    XCTAssertEqual(AgentStatusTag.label(for: status(.waiting), now: now), "needs you")
    XCTAssertEqual(AgentStatusTag.label(for: status(.done), now: now), "done 5m")
  }
}
