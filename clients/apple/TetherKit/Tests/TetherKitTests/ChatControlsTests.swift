import XCTest
@testable import TetherKit

final class ChatControlsTests: XCTestCase {
  private let commandsLine =
    "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"sess-2\",\"update\":{\"sessionUpdate\":\"available_commands_update\",\"availableCommands\":[{\"name\":\"compact\",\"description\":\"Clear history\",\"input\":{\"hint\":\"<instructions>\"}},{\"name\":\"context\",\"description\":\"Show usage\",\"input\":null},{\"description\":\"nameless\"}]}}}"
  private let usageLine =
    "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"sess-2\",\"update\":{\"sessionUpdate\":\"usage_update\",\"used\":10,\"size\":100,\"cost\":{\"amount\":0.25,\"currency\":\"USD\"},\"_meta\":{\"_claude/model\":\"claude-haiku-5-5\"}}}}"
  private let usageNoCostLine =
    "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"sess-2\",\"update\":{\"sessionUpdate\":\"usage_update\",\"used\":20,\"size\":100}}}"

  private func replay(_ range: Range<Int>, extra: [String] = []) throws -> ChatState {
    var log = ACPFixture.Controls.log(range)
    log.append(Data((extra.joined(separator: "\n") + (extra.isEmpty ? "" : "\n")).utf8))
    return try ChatTranscriptBuilder.replay(log: log, journal: ChatJournal())
  }

  func test_session_new_result_populates_the_options_and_the_chip_names() throws {
    let state = try replay(0..<2)
    XCTAssertEqual(state.configOptions.map(\.id), ["mode", "model", "effort", "agent"])
    XCTAssertEqual(state.modeId, "default")
    XCTAssertEqual(state.currentChoice(of: "mode"), "Manual")
    XCTAssertEqual(state.currentChoice(of: "model"), "Sonnet 5.5")
    XCTAssertEqual(state.currentChoice(of: "effort"), "Medium")
    XCTAssertNil(state.currentChoice(of: "nope"))
    let model = try XCTUnwrap(state.option(id: "model"))
    XCTAssertEqual(model.category, "model")
    XCTAssertEqual(model.choices.map(\.value), ["default", "opus", "claude-fable-5-1[1m]", "sonnet", "haiku"])
    XCTAssertNil(state.option(id: "agent")?.category)
  }

  func test_set_config_result_and_updates_keep_the_mode_consistent() throws {
    var state = try replay(0..<3)
    XCTAssertEqual(state.currentChoice(of: "model"), "Haiku 5.5")
    state = try replay(0..<4)
    XCTAssertEqual(state.modeId, "plan")
    XCTAssertEqual(state.currentChoice(of: "mode"), "Plan")
    state = try replay(0..<6)
    XCTAssertEqual(state.modeId, "plan")
    state = try replay(0..<7)
    XCTAssertEqual(state.modeId, "default", "current_mode_update wins and the mode option follows")
    XCTAssertEqual(state.option(id: "mode")?.currentValue, "default")
    state = try replay(0..<ACPFixture.Controls.agentLines.count)
    XCTAssertEqual(state.modeId, "default")
    XCTAssertEqual(state.currentChoice(of: "model"), "Haiku 5.5")
    XCTAssertTrue(state.items.isEmpty, "settings traffic never reaches the transcript")
  }

  func test_commands_replace_wholesale_and_nameless_ones_are_dropped() throws {
    let state = try replay(0..<2, extra: [commandsLine])
    XCTAssertEqual(state.commands.map(\.name), ["compact", "context"])
    XCTAssertEqual(state.commands[0].hint, "<instructions>")
    XCTAssertNil(state.commands[1].hint)
    let second =
      "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"available_commands_update\",\"availableCommands\":[{\"name\":\"model\",\"description\":\"\"}]}}}"
    let replaced = try replay(0..<2, extra: [commandsLine, second])
    XCTAssertEqual(replaced.commands.map(\.name), ["model"])
  }

  func test_usage_carries_cost_and_model_and_a_costless_update_keeps_the_last_cost() throws {
    let state = try replay(0..<2, extra: [usageLine, usageNoCostLine])
    XCTAssertEqual(state.contextUsed, 20)
    XCTAssertEqual(state.cost, ChatCost(amount: 0.25, currency: "USD"))
    XCTAssertEqual(state.modelId, "claude-haiku-5-5")

    let recorded = try ChatTranscriptBuilder.replay(log: ACPFixture.log(), journal: ACPFixture.journal)
    XCTAssertEqual(recorded.modelId, "claude-sonnet-5-5")
    XCTAssertEqual(recorded.cost?.currency, "USD")
    XCTAssertEqual(recorded.cost?.amount ?? 0, 0.1638523, accuracy: 1e-9)
  }

  func test_malformed_option_shapes_are_skipped_not_fatal() {
    let line =
      "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"config_option_update\",\"configOptions\":[{\"id\":\"x\",\"type\":\"boolean\",\"currentValue\":true},{\"id\":\"y\",\"currentValue\":3},{\"id\":\"ok\",\"name\":\"Ok\",\"currentValue\":\"a\",\"options\":[{\"value\":\"a\"},{\"name\":\"no value\"}]}]}}}"
    guard case let .update(.configOptions(options)) = ACPDecoder.decode(Data(line.utf8)) else { return XCTFail() }
    XCTAssertEqual(options.map(\.id), ["ok"])
    XCTAssertEqual(options[0].choices, [ACPConfigChoice(value: "a", name: "a", description: "")])
  }

  func test_a_stored_journal_without_image_counts_still_decodes() throws {
    let json = "{\"nextRequestId\":4,\"sessionId\":\"s\",\"entries\":[{\"kind\":\"prompt\",\"offset\":5,\"text\":\"hi\"}]}"
    let journal = try JSONDecoder().decode(ChatJournal.self, from: Data(json.utf8))
    XCTAssertEqual(journal.entries.first?.imageCount, 0)
    var withImages = journal
    withImages.entries[0].imageCount = 2
    let round = try JSONDecoder().decode(ChatJournal.self, from: JSONEncoder().encode(withImages))
    XCTAssertEqual(round, withImages)
  }

  func test_a_replayed_image_prompt_shows_the_count() throws {
    var journal = ChatJournal()
    journal.entries = [.init(kind: .prompt, offset: 0, text: "look", imageCount: 2)]
    let state = try ChatTranscriptBuilder.replay(log: Data(), journal: journal)
    XCTAssertEqual(state.items.map(\.kind), [.user(text: "look", imageCount: 2, offset: 0)])
  }
}
