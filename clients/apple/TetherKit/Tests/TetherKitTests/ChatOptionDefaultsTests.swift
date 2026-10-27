import XCTest
@testable import TetherKit

final class ChatOptionDefaultsTests: XCTestCase {
  private func option(_ id: String, current: String, _ values: [String]) -> ACPConfigOption {
    ACPConfigOption(
      id: id, name: id, description: "", category: nil, currentValue: current,
      choices: values.map { .init(value: $0, name: $0, description: "") })
  }

  func test_next_skips_missing_options_unoffered_values_and_equal_values() {
    let offered = [
      option("mode", current: "default", ["default", "plan"]),
      option("model", current: "opus", ["opus", "haiku"]),
      option("agent", current: "default", ["default", "other"]),
    ]
    let stored = ["mode": "default", "model": "haiku", "effort": "high", "agent": "other"]
    XCTAssertEqual(ChatOptionDefaults.next(stored: stored, offered: offered, skipping: [])?.id, "model")
    XCTAssertNil(ChatOptionDefaults.next(stored: stored, offered: offered, skipping: ["model"]))
    XCTAssertNil(ChatOptionDefaults.next(stored: ["model": "gone"], offered: offered, skipping: []))
    XCTAssertNil(ChatOptionDefaults.next(stored: [:], offered: offered, skipping: []))
  }

  func test_next_follows_a_fixed_order() {
    let offered = [
      option("effort", current: "low", ["low", "high"]),
      option("mode", current: "default", ["default", "plan"]),
      option("model", current: "opus", ["opus", "haiku"]),
    ]
    let stored = ["mode": "plan", "effort": "high", "model": "haiku"]
    XCTAssertEqual(ChatOptionDefaults.next(stored: stored, offered: offered, skipping: [])?.id, "model")
    XCTAssertEqual(ChatOptionDefaults.next(stored: stored, offered: offered, skipping: ["model"])?.id, "effort")
    XCTAssertEqual(ChatOptionDefaults.next(stored: stored, offered: offered, skipping: ["model", "effort"])?.id, "mode")
  }

  func test_only_model_effort_and_mode_are_remembered_per_agent() {
    let suite = UserDefaults(suiteName: "tether.test.\(UUID().uuidString)")!
    let store = ChatOptionDefaultsStore(defaults: suite)
    store.remember(agent: "claude", id: "model", value: "haiku")
    store.remember(agent: "claude", id: "agent", value: "other")
    store.remember(agent: "other", id: "mode", value: "plan")
    XCTAssertEqual(store.stored(agent: "claude"), ["model": "haiku"])
    XCTAssertEqual(store.stored(agent: "other"), ["mode": "plan"])
    XCTAssertEqual(ChatOptionDefaultsStore(defaults: suite).stored(agent: "claude"), ["model": "haiku"])
  }
}
