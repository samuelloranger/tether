import XCTest
@testable import TetherKit

final class ChatOptionDefaultsTests: XCTestCase {
  private func option(_ id: String, current: String, _ values: [String]) -> ACPConfigOption {
    ACPConfigOption(
      id: id, name: id, description: "", category: nil, currentValue: current,
      choices: values.map { .init(value: $0, name: $0, description: "") })
  }

  func test_plan_skips_missing_options_unoffered_values_and_equal_values() {
    let offered = [
      option("mode", current: "default", ["default", "plan"]),
      option("model", current: "opus", ["opus", "haiku"]),
      option("agent", current: "default", ["default", "other"]),
    ]
    let calls = ChatOptionDefaults.plan(
      stored: ["mode": "default", "model": "haiku", "effort": "high", "agent": "other"], offered: offered)
    XCTAssertEqual(calls.map(\.id), ["model"])
    XCTAssertEqual(calls.map(\.value), ["haiku"])
    XCTAssertTrue(ChatOptionDefaults.plan(stored: ["model": "gone"], offered: offered).isEmpty)
    XCTAssertTrue(ChatOptionDefaults.plan(stored: [:], offered: offered).isEmpty)
  }

  func test_plan_runs_in_a_fixed_order() {
    let offered = [
      option("effort", current: "low", ["low", "high"]),
      option("mode", current: "default", ["default", "plan"]),
      option("model", current: "opus", ["opus", "haiku"]),
    ]
    let calls = ChatOptionDefaults.plan(stored: ["mode": "plan", "effort": "high", "model": "haiku"], offered: offered)
    XCTAssertEqual(calls.map(\.id), ["model", "effort", "mode"])
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
