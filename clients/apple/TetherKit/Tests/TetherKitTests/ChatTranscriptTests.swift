import XCTest
@testable import TetherKit

final class ChatTranscriptTests: XCTestCase {
  private func replay(_ log: Data, _ journal: ChatJournal = ACPFixture.journal) throws -> ChatState {
    try ChatTranscriptBuilder.replay(log: log, journal: journal)
  }

  private func tools(_ state: ChatState) -> [ChatToolCall] {
    state.items.compactMap { if case let .tool(call) = $0.kind { return call } else { return nil } }
  }

  func test_fixture_replays_into_the_expected_transcript() throws {
    let state = try replay(ACPFixture.log())
    XCTAssertEqual(state.turn, .idle)
    XCTAssertEqual(state.sessionId, "sess-1")
    XCTAssertEqual(state.loadSession, true)
    XCTAssertEqual(state.lastStopReason, "end_turn")
    XCTAssertEqual(state.title, "Hello.txt to out.txt")
    XCTAssertEqual(state.contextUsed, 39457)

    guard state.items.count == 5 else { return XCTFail("items: \(state.items)") }
    guard case let .user(text, offset) = state.items[0].kind else { return XCTFail() }
    XCTAssertEqual(text, ACPFixture.promptText)
    XCTAssertEqual(offset, ACPFixture.promptOffset)

    let calls = tools(state)
    XCTAssertEqual(calls.map(\.title), ["Read hello.txt", "Write out.txt"])
    XCTAssertEqual(calls.map(\.status), [.completed, .completed])
    XCTAssertEqual(calls.map(\.kind), [.read, .edit])
    XCTAssertTrue(calls[0].rawOutput?.contains("hello from a fixture") == true)
    XCTAssertEqual(calls[1].diff, ACPDiff(path: "/work/project/out.txt", oldText: nil, newText: "hi\n"))

    guard case let .permission(permission) = state.items[3].kind else { return XCTFail() }
    XCTAssertEqual(permission.resolvedOptionId, "allow-once")
    XCTAssertEqual(permission.diff?.newText, "hi\n")
    XCTAssertEqual(permission.options.map(\.optionId), ["allow-once", "allow-with-updates", "reject"])
    XCTAssertEqual(permission.options.map(\.kind), ["allow_once", "allow_always", "reject_once"])
    XCTAssertEqual(permission.toolCallId, calls[1].id)
    XCTAssertTrue(state.pendingPermissions.isEmpty)

    guard case let .assistant(reply, _) = state.items[4].kind else { return XCTFail() }
    XCTAssertEqual(reply, "I read `hello.txt` (it says \"hello from a fixture\") and created `out.txt` containing \"hi\".")
  }

  func test_random_chunking_gives_the_identical_transcript() throws {
    let log = ACPFixture.log(extra: ["{\"jsonrpc\":\"2.0\",\"method\":\"_x/y\",\"params\":{\"s\":\"é你😀\"}}"])
    let expected = try replay(log)
    for seed in UInt64(0)..<40 {
      var rng = SeededGenerator(seed: seed)
      var builder = ChatTranscriptBuilder(journal: ACPFixture.journal)
      var position = 0
      while position < log.count {
        let size = min(Int.random(in: 1...(seed % 2 == 0 ? 7 : 400), using: &rng), log.count - position)
        try builder.feed(log.subdata(in: position..<(position + size)))
        position += size
      }
      builder.finish()
      XCTAssertEqual(builder.state, expected, "seed \(seed)")
      XCTAssertEqual(builder.receivedBytes, log.count)
    }
  }

  func test_live_path_and_replay_from_zero_agree() throws {
    var builder = ChatTranscriptBuilder()
    var journal = ChatJournal()
    journal.sessionId = "sess-1"
    let sessionLine = ACPFixture.index(containing: "\"sessionId\":\"sess-1\",\"modes\"")
    let permissionLine = ACPFixture.index(containing: "session/request_permission")
    for (index, line) in ACPFixture.agentLines.enumerated() {
      try builder.feed(Data((line + "\n").utf8))
      if index == sessionLine {
        journal.entries.append(.init(kind: .prompt, offset: builder.consumedOffset, text: ACPFixture.promptText))
        builder.apply(.userPrompt(text: ACPFixture.promptText, atOffset: builder.consumedOffset))
      }
      if index == permissionLine {
        journal.entries.append(.init(kind: .answer, offset: builder.consumedOffset, requestId: .int(0), optionId: "allow-once"))
        builder.apply(.permissionAnswered(requestId: .int(0), optionId: "allow-once"))
      }
    }
    XCTAssertEqual(journal.entries, ACPFixture.journal.entries)
    XCTAssertEqual(builder.state, try replay(ACPFixture.log(), journal))
  }

  func test_a_log_ending_mid_turn_shows_the_unanswered_permission_pending() throws {
    let cut = ACPFixture.index(containing: "session/request_permission") + 1
    var unanswered = ACPFixture.journal
    unanswered.entries.removeLast()
    let pending = try replay(ACPFixture.log(cut), unanswered)
    XCTAssertEqual(pending.turn, .working)
    XCTAssertEqual(pending.pendingPermissions.map(\.requestId), [.int(0)])

    let answered = try replay(ACPFixture.log(cut), ACPFixture.journal)
    XCTAssertEqual(answered.turn, .working)
    XCTAssertTrue(answered.pendingPermissions.isEmpty)
    guard case let .permission(permission) = answered.items.first(where: {
      if case .permission = $0.kind { return true } else { return false }
    })?.kind else { return XCTFail() }
    XCTAssertEqual(permission.resolvedOptionId, "allow-once")
  }

  func test_unknown_kinds_and_garbage_lines_are_ignored() throws {
    let noise = [
      "{\"jsonrpc\":\"2.0\",\"method\":\"_auth/status_update\",\"params\":{\"status\":\"ok\"}}",
      "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"s\",\"update\":{\"sessionUpdate\":\"brand_new_kind\",\"x\":1}}}",
      "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"image\"}}}}",
      "{not json at all",
      "[1,2,3]",
      "\"just a string\"",
      "{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"fs/read_text_file\",\"params\":{}}",
      "{\"jsonrpc\":\"2.0\"}",
    ]
    let clean = try replay(ACPFixture.log())
    var lines = ACPFixture.agentLines
    for (index, line) in noise.enumerated() { lines.insert(line, at: min(2 + index * 3, lines.count)) }
    // Offsets shift with inserted lines; the journal is rebuilt by marker instead.
    var builder = ChatTranscriptBuilder()
    for line in lines {
      try builder.feed(Data((line + "\n").utf8))
      if line.contains("\"sessionId\":\"sess-1\",\"modes\"") {
        builder.apply(.userPrompt(text: ACPFixture.promptText, atOffset: builder.consumedOffset))
      }
      if line.contains("session/request_permission") {
        builder.apply(.permissionAnswered(requestId: .int(0), optionId: "allow-once"))
      }
    }
    func normalized(_ state: ChatState) -> [ChatItem.Kind] {
      state.items.map {
        if case let .user(text, _) = $0.kind { return .user(text: text, offset: 0) }
        return $0.kind
      }
    }
    XCTAssertEqual(normalized(builder.state), normalized(clean))
    XCTAssertEqual(builder.state.turn, .idle)
  }

  func test_decoder_covers_the_documented_shapes() {
    XCTAssertEqual(
      ACPDecoder.decode(Data("{\"jsonrpc\":\"2.0\",\"id\":5,\"error\":{\"code\":-32000,\"message\":\"boom\"}}".utf8)),
      .errorResponse(id: .int(5), code: -32000, message: "boom"))
    XCTAssertEqual(
      ACPDecoder.decode(Data("{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"current_mode_update\",\"currentModeId\":\"plan\"}}}".utf8)),
      .update(.currentMode("plan")))
    XCTAssertEqual(
      ACPDecoder.decode(Data("{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_thought_chunk\",\"content\":{\"type\":\"text\",\"text\":\"hm\"}}}}".utf8)),
      .update(.agentThought(text: "hm")))
    XCTAssertEqual(
      ACPDecoder.decode(Data("{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"plan\",\"entries\":[{\"content\":\"a\",\"status\":\"pending\",\"priority\":\"high\"}]}}}".utf8)),
      .update(.plan([ACPPlanEntry(content: "a", status: "pending", priority: "high")])))
    XCTAssertEqual(
      ACPDecoder.decode(Data(ACPFixture.agentLines[0].utf8)),
      .response(id: .int(1), result: ACPResult(loadSession: true, sessionId: nil, stopReason: nil)))
  }

  func test_errors_and_plan_and_thought_reduce_into_items() {
    var state = ChatState()
    state = ChatReducer.reduce(state, .userPrompt(text: "go", atOffset: 0))
    state = ChatReducer.reduce(state, .message(.update(.agentThought(text: "a"))))
    state = ChatReducer.reduce(state, .message(.update(.agentThought(text: "b"))))
    state = ChatReducer.reduce(state, .message(.update(.plan([ACPPlanEntry(content: "x", status: "pending", priority: "low")]))))
    state = ChatReducer.reduce(state, .message(.update(.plan([ACPPlanEntry(content: "x", status: "completed", priority: "low")]))))
    XCTAssertEqual(state.items.count, 3)
    XCTAssertEqual(state.items[1].kind, .thought(text: "ab"))
    state = ChatReducer.reduce(state, .message(.errorResponse(id: .int(3), code: -1, message: "nope")))
    XCTAssertEqual(state.turn, .idle)
    XCTAssertEqual(state.items.last?.kind, .error("nope"))
    state = ChatReducer.reduce(state, .connectionLost)
    XCTAssertEqual(state.connection, .lost)
  }

  func test_consecutive_tool_and_resolved_permission_rows_share_one_block() {
    func tool(_ id: Int) -> ChatItem { .init(id: id, kind: .tool(ChatToolCall(ACPToolFields(id: "t\(id)")))) }
    let resolved = ChatPermission(
      requestId: .int(1), toolCallId: "t2", title: "Edit", kind: .edit, diff: nil, text: nil, options: [],
      resolvedOptionId: "once")
    let items: [ChatItem] = [
      .init(id: 0, kind: .notice("hi")), tool(1), .init(id: 2, kind: .permission(resolved)), tool(3),
      .init(id: 4, kind: .assistant(text: "done", messageId: nil)), tool(5),
    ]
    let blocks = ChatGrouping.blocks(items)
    XCTAssertEqual(blocks.count, 4)
    guard case let .tools(group) = blocks[1] else { return XCTFail("expected a tool group") }
    XCTAssertEqual(group.map(\.id), [1, 2, 3])
    guard case let .tools(last) = blocks[3] else { return XCTFail("expected a tool group") }
    XCTAssertEqual(last.map(\.id), [5])
  }
}
