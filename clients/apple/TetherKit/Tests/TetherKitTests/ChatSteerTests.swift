import XCTest
@testable import TetherKit

private func line(_ json: String) -> ACPInbound { ACPDecoder.decode(Data(json.utf8)) }

private func tool(_ id: String, _ status: String, parent: String? = nil, update: Bool = true) -> ACPInbound {
  let meta = parent.map { ",\"_meta\":{\"claudeCode\":{\"parentToolUseId\":\"\($0)\"}}" } ?? ""
  let kind = update ? "tool_call_update" : "tool_call"
  return line(
    "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"\(kind)\",\"toolCallId\":\"\(id)\",\"title\":\"Bash\",\"kind\":\"execute\",\"status\":\"\(status)\"\(meta)}}}")
}

private func reduce(_ state: ChatState, _ message: ACPInbound) -> ChatState {
  ChatReducer.reduce(state, .message(message))
}

private func users(_ state: ChatState) -> [String] {
  state.items.compactMap { if case let .user(text, _, _, _) = $0.kind { return text }; return nil }
}

final class ChatSteerTests: XCTestCase {
  private func running() -> ChatState {
    ChatReducer.reduce(ChatState(), .userPrompt(text: "go", atOffset: 0, requestId: .int(1)))
  }

  func test_a_boundary_is_a_top_level_call_ending_with_none_of_the_turn_still_running() {
    var state = running()
    state = reduce(state, tool("a", "in_progress", update: false))
    state = reduce(state, tool("b", "in_progress", update: false))
    state = reduce(state, tool("a", "completed"))
    XCTAssertEqual(state.toolBoundaries, 0, "b still runs")
    state = reduce(state, tool("b", "failed"))
    XCTAssertEqual(state.toolBoundaries, 1)
    state = reduce(state, tool("b", "failed"))
    XCTAssertEqual(state.toolBoundaries, 1, "an update to a call that already ended is no new boundary")
  }

  func test_a_subagents_own_calls_are_no_boundary() {
    var state = running()
    state = reduce(state, tool("agent", "in_progress", update: false))
    state = reduce(state, tool("inner", "in_progress", parent: "agent", update: false))
    state = reduce(state, tool("inner", "completed", parent: "agent"))
    XCTAssertEqual(state.toolBoundaries, 0)
    state = reduce(state, tool("agent", "completed"))
    XCTAssertEqual(state.toolBoundaries, 1)
  }

  func test_a_call_left_running_by_an_earlier_turn_does_not_hold_back_this_one() {
    var state = running()
    state = reduce(state, tool("stuck", "in_progress", update: false))
    state = reduce(state, line(#"{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}"#))
    state = ChatReducer.reduce(state, .userPrompt(text: "again", atOffset: 0, requestId: .int(2)))
    state = reduce(state, tool("c", "in_progress", update: false))
    state = reduce(state, tool("c", "completed"))
    XCTAssertEqual(state.toolBoundaries, 1)
  }

  func test_a_steered_message_joins_the_turn_and_one_the_agent_did_not_take_leaves() {
    var state = running()
    state = ChatReducer.reduce(state, .userSteered(text: "also this", atOffset: 0, requestId: .int(2)))
    XCTAssertEqual(users(state), ["go", "also this"])
    XCTAssertTrue(state.queuedItemIds.isEmpty)
    state = reduce(state, line(#"{"jsonrpc":"2.0","id":2,"result":{"outcome":"injected"}}"#))
    XCTAssertEqual(users(state), ["go", "also this"])
    XCTAssertEqual(state.turn, .working, "a steer answer is not the end of the prompt")

    state = ChatReducer.reduce(state, .userSteered(text: "late", atOffset: 0, requestId: .int(3)))
    state = reduce(state, line(#"{"jsonrpc":"2.0","id":3,"result":{"outcome":"promptRequired","reason":"noRunningTurn"}}"#))
    state = ChatReducer.reduce(state, .userSteered(text: "refused", atOffset: 0, requestId: .int(4)))
    state = reduce(state, line(#"{"jsonrpc":"2.0","id":4,"error":{"code":-32601,"message":"Method not found"}}"#))
    XCTAssertEqual(users(state), ["go", "also this"])
    XCTAssertFalse(state.items.contains { if case .error = $0.kind { return true }; return false })
    XCTAssertEqual(state.turn, .working)
  }

  func test_another_clients_steer_shows_from_its_echo_and_replay_equals_live() throws {
    let steer = #"{"id":"b-2","jsonrpc":"2.0","method":"_session/steering","params":{"prompt":[{"text":"from b","type":"text"}],"sessionId":"s"}}"#
    let echo = "{\"jsonrpc\":\"2.0\",\"method\":\"_tether/client\",\"params\":{\"client\":\"b\",\"message\":\(steer)}}"
    let lines = [
      #"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"working"},"messageId":"m1"}}}"#,
      echo,
      #"{"jsonrpc":"2.0","id":"b-2","result":{"outcome":"injected"}}"#,
    ]
    let log = Data(lines.map { $0 + "\n" }.joined().utf8)
    var journal = ChatJournal()
    journal.clientId = "a"
    journal.entries = [.init(kind: .prompt, offset: 0, text: "go", requestId: .string("a-1"))]
    let state = try ChatTranscriptBuilder.replay(log: log, journal: journal)
    XCTAssertEqual(users(state), ["go", "from b"])

    var own = ChatJournal()
    own.clientId = "b"
    own.entries = [
      .init(kind: .prompt, offset: 0, text: "go", requestId: .string("a-1")),
      .init(kind: .steer, offset: lines[0].utf8.count + 1, text: "from b", requestId: .string("b-2")),
    ]
    let mine = try ChatTranscriptBuilder.replay(log: log, journal: own)
    XCTAssertEqual(users(mine), ["go", "from b"])
  }
}
