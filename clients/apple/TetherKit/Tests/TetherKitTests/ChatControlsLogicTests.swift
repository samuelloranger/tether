import XCTest
@testable import TetherKit

final class ChatControlsLogicTests: XCTestCase {
  private func state(mode: String = "default", model: String = "opus") -> ChatState {
    var state = ChatState()
    state.configOptions = [
      ACPConfigOption(
        id: "mode", name: "Mode", description: "", category: "mode", currentValue: mode,
        choices: [
          .init(value: "default", name: "Manual", description: ""),
          .init(value: "plan", name: "Plan", description: ""),
          .init(value: "bypassPermissions", name: "Bypass permissions", description: ""),
        ]),
      ACPConfigOption(
        id: "model", name: "Model", description: "", category: "model", currentValue: model,
        choices: [.init(value: "opus", name: "Opus 5", description: "")]),
    ]
    return state
  }

  func test_cost_format() {
    XCTAssertEqual(ChatFormat.cost(ChatCost(amount: 0.157, currency: "USD")), "$0.16")
    XCTAssertEqual(ChatFormat.cost(ChatCost(amount: 0, currency: "USD")), "$0.00")
    XCTAssertEqual(ChatFormat.cost(ChatCost(amount: 1.24, currency: "USD")), "$1.2")
    XCTAssertEqual(ChatFormat.cost(ChatCost(amount: 12.5, currency: "USD")), "$12.5")
    XCTAssertEqual(ChatFormat.cost(ChatCost(amount: 0.5, currency: "eur")), "0.50 EUR")
  }

  func test_context_percent() {
    XCTAssertEqual(ChatFormat.contextPercent(used: 20_000, size: 1_000_000), "2%")
    XCTAssertEqual(ChatFormat.contextPercent(used: 5_000_000, size: 1_000_000), "100%")
    XCTAssertNil(ChatFormat.contextPercent(used: nil, size: 100))
    XCTAssertNil(ChatFormat.contextPercent(used: 10, size: 0))
  }

  func test_mode_tint() {
    XCTAssertEqual(ChatModeTint(modeId: "plan"), .accent)
    XCTAssertEqual(ChatModeTint(modeId: "acceptEdits"), .success)
    XCTAssertEqual(ChatModeTint(modeId: "auto"), .secondary)
    XCTAssertEqual(ChatModeTint(modeId: "default"), .secondary)
    XCTAssertEqual(ChatModeTint(modeId: "bypassPermissions"), .danger)
    XCTAssertEqual(ChatModeTint(modeId: nil), .secondary)
  }

  func test_status_line_is_empty_without_options() {
    let line = ChatStatusLine(state: ChatState())
    XCTAssertFalse(line.isAvailable)
    XCTAssertNil(line.stats)
    XCTAssertEqual(line.spoken, "")
  }

  func test_status_line_composition_hides_missing_pieces() {
    var current = state(mode: "plan")
    var line = ChatStatusLine(state: current)
    XCTAssertTrue(line.isAvailable)
    XCTAssertEqual(line.model, "Opus 5")
    XCTAssertEqual(line.mode, "Plan")
    XCTAssertEqual(line.tint, .accent)
    XCTAssertNil(line.stats)
    current.contextUsed = 20_000
    current.contextSize = 1_000_000
    XCTAssertEqual(ChatStatusLine(state: current).stats, "2%")
    current.cost = ChatCost(amount: 0.16, currency: "USD")
    line = ChatStatusLine(state: current)
    XCTAssertEqual(line.stats, "2% · $0.16")
    XCTAssertEqual(line.spoken, "Model Opus 5, Mode Plan, Context 2% used, Cost $0.16")
    current.contextSize = nil
    XCTAssertEqual(ChatStatusLine(state: current).stats, "$0.16")
  }

  func test_status_line_falls_back_to_the_usage_model_id() {
    var current = ChatState()
    current.modelId = "some-model"
    XCTAssertEqual(ChatStatusLine(state: current).model, "some-model")
    XCTAssertTrue(ChatStatusLine(state: current).isAvailable)
  }

  func test_send_rule() {
    XCTAssertTrue(ChatComposerRule.canSend(text: "hi", readyImages: 0, encoding: 0, sessionCanSend: true))
    XCTAssertFalse(ChatComposerRule.canSend(text: "  \n", readyImages: 0, encoding: 0, sessionCanSend: true))
    XCTAssertTrue(ChatComposerRule.canSend(text: "", readyImages: 1, encoding: 0, sessionCanSend: true))
    XCTAssertFalse(ChatComposerRule.canSend(text: "hi", readyImages: 1, encoding: 1, sessionCanSend: true))
    XCTAssertFalse(ChatComposerRule.canSend(text: "hi", readyImages: 0, encoding: 0, sessionCanSend: false))
  }

  func test_image_messages() {
    XCTAssertEqual(ChatComposerRule.message(for: ChatImageError.tooLarge(bytes: 9)), "That image is too large to send.")
    XCTAssertEqual(ChatComposerRule.message(for: ChatImageError.notAnImage), "That file isn't an image.")
    XCTAssertEqual(ChatComposerRule.imageLabel(1), "1 image")
    XCTAssertEqual(ChatComposerRule.imageLabel(3), "3 images")
  }

  func test_quick_commands_follow_the_agent_list() {
    let none: [ACPCommand] = []
    XCTAssertTrue(ChatQuickCommand.compact.isOffered(by: none))
    let listed = [ACPCommand(name: "context", description: "", hint: nil)]
    XCTAssertFalse(ChatQuickCommand.compact.isOffered(by: listed))
    XCTAssertTrue(ChatQuickCommand.context.isOffered(by: listed))
    XCTAssertEqual(ChatQuickCommand.compact.text, "/compact")
  }
}
