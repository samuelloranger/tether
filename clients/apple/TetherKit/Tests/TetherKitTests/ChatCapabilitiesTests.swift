import XCTest
@testable import TetherKit

/// Background commands, agent-started turns, notices and compaction, driven by recorded adapter traffic.
final class ChatCapabilitiesTests: XCTestCase {
  private func fixtureLines(_ name: String) -> [String] {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/\(name)")
    let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    return text.split(separator: "\n").map(String.init)
  }

  /// Feeds the recording in order; each client prompt becomes the user's prompt at the current offset.
  /// `observe` sees the state after every agent line, with that line.
  private func replay(_ name: String, observe: (ChatState, String) -> Void = { _, _ in }) throws -> ChatState {
    var builder = ChatTranscriptBuilder()
    for line in fixtureLines(name) {
      if line.hasPrefix("> ") {
        guard let object = try JSONSerialization.jsonObject(with: Data(line.dropFirst(2).utf8)) as? [String: Any],
          object["method"] as? String == "session/prompt", let id = object["id"] as? Int,
          let blocks = (object["params"] as? [String: Any])?["prompt"] as? [[String: Any]]
        else { continue }
        let text = blocks.compactMap { $0["text"] as? String }.joined()
        builder.apply(.userPrompt(text: text, atOffset: builder.consumedOffset, requestId: .int(id)))
      } else if line.hasPrefix("< ") {
        let agent = String(line.dropFirst(2))
        try builder.feed(Data((agent + "\n").utf8))
        observe(builder.state, agent)
      }
    }
    return builder.state
  }

  private func decode(_ json: String) -> ACPInbound { ACPDecoder.decode(Data(json.utf8)) }

  private func update(_ body: String) -> ACPInbound {
    decode(#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":"# + body + "}}")
  }

  private func reduce(_ state: ChatState, _ body: String) -> ChatState {
    ChatReducer.reduce(state, .message(update(body)))
  }

  /// A chat past its `session/new` answer, where agent output with no prompt is a live turn.
  private func established() -> ChatState {
    ChatReducer.reduce(ChatState(), .message(decode(#"{"jsonrpc":"2.0","id":1,"result":{"sessionId":"s","modes":{}}}"#)))
  }

  func test_a_background_command_runs_after_the_prompt_ends_and_stops_at_terminal_exit() throws {
    var afterResponse: ChatState?
    var afterExit: ChatState?
    _ = try replay("acp-background.log") { state, line in
      if line.contains(#""id":3,"result""#) { afterResponse = state }
      if line.contains("terminal_exit") { afterExit = state }
    }
    let running = try XCTUnwrap(afterResponse).backgroundCommands
    XCTAssertEqual(running.count, 1)
    XCTAssertEqual(running.first?.title, "sleep 25; echo probe-finished")
    XCTAssertTrue(running.first?.text?.hasPrefix("```console\nCommand running in background") == true)
    XCTAssertEqual(try XCTUnwrap(afterResponse).turn, .idle)
    XCTAssertTrue(try XCTUnwrap(afterExit).backgroundCommands.isEmpty)
  }

  func test_the_agents_own_turn_after_the_task_ends_works_until_the_cost_update() throws {
    var states: [(ChatState, String)] = []
    let final = try replay("acp-background.log") { state, line in states.append((state, line)) }
    let finished = try XCTUnwrap(states.first { $0.1.contains(#""text":"finished""#) }).0
    XCTAssertEqual(finished.turn, .working)
    XCTAssertTrue(finished.agentStarted)
    let exit = try XCTUnwrap(states.first { $0.1.contains("terminal_exit") }).0
    XCTAssertEqual(exit.turn, .idle, "the exit update alone starts no turn")
    XCTAssertEqual(final.turn, .idle)
    XCTAssertFalse(final.agentStarted)
    XCTAssertEqual(final.items.compactMap { item -> String? in
      if case let .assistant(text, _) = item.kind { return text }
      return nil
    }, ["started", "finished"])
  }

  func test_a_cost_update_inside_a_prompt_does_not_end_anything_and_stop_ends_an_agent_started_turn() {
    var state = reduce(
      established(), #"{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"},"messageId":"m"}"#)
    XCTAssertEqual(state.turn, .working)
    state = ChatReducer.reduce(state, .cancelRequested)
    XCTAssertEqual(state.turn, .idle)
    XCTAssertFalse(state.agentStarted)

    state = reduce(state, #"{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"hm"}}"#)
    XCTAssertEqual(state.turn, .working)
    state = ChatReducer.reduce(state, .userPrompt(text: "go", atOffset: 0, requestId: .int(9)))
    XCTAssertFalse(state.agentStarted)
    state = reduce(state, #"{"sessionUpdate":"usage_update","used":1,"size":2,"cost":{"amount":1,"currency":"USD"}}"#)
    XCTAssertEqual(state.turn, .working, "the prompt is still in flight")
  }

  func test_a_tool_call_update_alone_does_not_start_a_turn_but_a_new_tool_call_does() {
    var state = reduce(established(), #"{"sessionUpdate":"tool_call_update","toolCallId":"x","status":"completed"}"#)
    XCTAssertEqual(state.turn, .idle)
    state = reduce(state, #"{"sessionUpdate":"tool_call","toolCallId":"y","title":"ls","kind":"execute","status":"pending"}"#)
    XCTAssertEqual(state.turn, .working)
  }

  func test_replayed_history_during_a_load_is_not_a_live_turn_and_the_load_answer_ends_commands() {
    var state = ChatReducer.reduce(ChatState(), .loadRequested)
    state = reduce(state, #"{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"old"},"messageId":"m"}"#)
    XCTAssertEqual(state.turn, .idle)
    state = reduce(
      state,
      #"{"sessionUpdate":"tool_call","toolCallId":"b","title":"sleep 9","kind":"execute","status":"completed","_meta":{"claudeCode":{"toolResponse":{"backgroundTaskId":"t"}},"terminal_info":{"terminal_id":"b"}}}"#)
    XCTAssertEqual(state.backgroundCommands.count, 1)
    state = ChatReducer.reduce(
      state, .message(decode(#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s","modes":{}}}"#)))
    XCTAssertTrue(state.backgroundCommands.isEmpty)
    XCTAssertFalse(state.loading)
  }

  func test_history_replayed_before_any_session_answer_is_not_a_live_turn() {
    // A device joining a chat another device loaded replays the history before the load answer.
    let state = reduce(ChatState(), #"{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"old"},"messageId":"m"}"#)
    XCTAssertEqual(state.turn, .idle)
    XCTAssertFalse(state.agentStarted)
  }

  func test_a_failed_load_ends_the_wait_so_later_output_is_live() {
    var state = ChatReducer.reduce(ChatState(), .loadRequested)
    state = ChatReducer.reduce(
      state, .message(decode(#"{"jsonrpc":"2.0","id":2,"error":{"code":-32002,"message":"Resource not found"}}"#)))
    XCTAssertFalse(state.loading)
    state = reduce(state, #"{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"},"messageId":"m"}"#)
    XCTAssertEqual(state.turn, .working)
  }

  func test_a_task_id_without_a_terminal_never_shows_a_running_command() {
    let state = reduce(
      ChatState(),
      #"{"sessionUpdate":"tool_call","toolCallId":"b","title":"sleep 9","kind":"execute","status":"completed","_meta":{"claudeCode":{"toolResponse":{"backgroundTaskId":"t"}}}}"#)
    XCTAssertTrue(state.backgroundCommands.isEmpty)
  }

  func test_terminal_output_sets_the_old_fenced_text_and_a_delta_appends() throws {
    var state = reduce(
      ChatState(), #"{"sessionUpdate":"tool_call","toolCallId":"c","title":"ls","kind":"execute","status":"pending"}"#)
    state = reduce(
      state, #"{"sessionUpdate":"tool_call_update","toolCallId":"c","_meta":{"terminal_output":{"terminal_id":"c","data":"a\n"}}}"#)
    state = reduce(
      state, #"{"sessionUpdate":"tool_call_update","toolCallId":"c","_meta":{"terminal_output_delta":{"terminal_id":"c","data":"b\n\n"}}}"#)
    guard case let .tool(call) = state.items[0].kind else { return XCTFail() }
    XCTAssertEqual(call.text, "```console\na\nb\n```")
  }

  func test_old_format_output_in_content_still_parses_and_blank_terminal_data_is_ignored() throws {
    var state = reduce(
      ChatState(),
      #"{"sessionUpdate":"tool_call","toolCallId":"c","title":"ls","kind":"execute","status":"completed","content":[{"type":"content","content":{"type":"text","text":"```console\nx\n```"}},{"type":"terminal","terminalId":"c"}]}"#)
    guard case let .tool(call) = state.items[0].kind else { return XCTFail() }
    XCTAssertEqual(call.text, "```console\nx\n```")
    state = reduce(
      state, #"{"sessionUpdate":"tool_call_update","toolCallId":"c","_meta":{"terminal_output":{"terminal_id":"c","data":"  \n"}}}"#)
    guard case let .tool(after) = state.items[0].kind else { return XCTFail() }
    XCTAssertEqual(after.text, "```console\nx\n```")
  }

  func test_a_notice_becomes_its_own_item_with_severity_and_never_joins_the_message() {
    var state = reduce(
      ChatState(), #"{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"a"},"messageId":"m"}"#)
    state = reduce(
      state, #"{"sessionUpdate":"notice","severity":"warning","title":"Slow down","description":"near the limit"}"#)
    state = reduce(state, #"{"sessionUpdate":"notice","title":"Plain"}"#)
    state = reduce(
      state, #"{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"b"},"messageId":"m"}"#)
    XCTAssertEqual(state.items.count, 4)
    XCTAssertEqual(
      state.items[1].kind,
      .agentNotice(ChatAgentNotice(severity: .warning, title: "Slow down", detail: "near the limit")))
    XCTAssertEqual(state.items[2].kind, .agentNotice(ChatAgentNotice(severity: nil, title: "Plain", detail: nil)))
    XCTAssertEqual(state.items[0].kind, .assistant(text: "a", messageId: "m"))
  }

  func test_compaction_yields_one_completed_item_with_the_summary_and_no_second_divider() throws {
    var midway: ChatState?
    let final = try replay("acp-compact.log") { state, line in
      if line.contains(#""status":"in_progress""#) { midway = state }
    }
    guard case let .compaction(running)? = midway?.items.last?.kind else { return XCTFail("no compaction") }
    XCTAssertEqual(running.status, .inProgress)
    let compactions = final.items.compactMap { item -> ChatCompaction? in
      if case let .compaction(value) = item.kind { return value }
      return nil
    }
    XCTAssertEqual(compactions.count, 1)
    XCTAssertEqual(compactions[0].status, .completed)
    XCTAssertTrue(compactions[0].summary?.hasPrefix("1. Primary Request and Intent:") == true)
    XCTAssertFalse(final.items.contains { if case .divider = $0.kind { return true } else { return false } })
    XCTAssertEqual(final.turn, .idle)
  }

  func test_a_compact_without_compaction_updates_keeps_the_old_divider() {
    var state = ChatReducer.reduce(ChatState(), .userPrompt(text: "/compact", atOffset: 0, requestId: .int(1)))
    state = ChatReducer.reduce(
      state, .message(decode(#"{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}"#)))
    XCTAssertTrue(state.items.contains { $0.kind == .divider("Context compacted") })
  }

  func test_summary_chunks_append_and_a_later_completed_without_summary_keeps_it() {
    var state = reduce(ChatState(), #"{"sessionUpdate":"compaction_update","compactionId":"k","status":"in_progress"}"#)
    state = reduce(
      state, #"{"sessionUpdate":"compaction_summary_chunk","compactionId":"k","content":{"type":"text","text":"one "}}"#)
    state = reduce(
      state, #"{"sessionUpdate":"compaction_summary_chunk","compactionId":"k","content":{"type":"text","text":"two"}}"#)
    state = reduce(state, #"{"sessionUpdate":"compaction_update","compactionId":"k","status":"completed"}"#)
    state = reduce(state, #"{"sessionUpdate":"compaction_update","compactionId":"k","status":"failed"}"#)
    XCTAssertEqual(state.items.count, 1)
    XCTAssertEqual(state.items[0].kind, .compaction(ChatCompaction(id: "k", status: .failed, summary: "one two")))
  }

  func test_snapshots_from_before_these_fields_still_decode() throws {
    var state = reduce(
      ChatState(),
      #"{"sessionUpdate":"tool_call","toolCallId":"c","title":"ls","kind":"execute","status":"pending"}"#)
    state = reduce(state, #"{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"a"},"messageId":"m"}"#)
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: Any])
    object["agentStarted"] = nil
    object["loading"] = nil
    let old = try JSONSerialization.data(withJSONObject: object)
    let decoded = try JSONDecoder().decode(ChatState.self, from: old)
    XCTAssertEqual(decoded.items, state.items)
    XCTAssertFalse(decoded.agentStarted)
    XCTAssertEqual(decoded.turn, state.turn)
  }

  func test_status_lines_carry_tasks_and_the_tag_reads_one_task_or_n_tasks() {
    let lines = [
      #"{"name":"a","state":"running","turn":"idle","cwd":"/x","created":3,"tasks":1}"#,
      #"{"name":"b","state":"running","turn":"idle","cwd":"/x","created":2,"tasks":3}"#,
      #"{"name":"c","state":"running","turn":"working","cwd":"/x","created":1,"tasks":2}"#,
      #"{"name":"d","state":"running","turn":"waiting","cwd":"/x","created":0,"tasks":2}"#,
      #"{"name":"e","state":"running","turn":"idle","cwd":"/x","created":-1}"#,
    ].joined(separator: "\n")
    let chats = ACPChatStatusListing.parse(lines).chats
    XCTAssertEqual(chats.map(\.tasks), [1, 3, 2, 2, 0])
    let rows = DrawerChatRows.rows(chats: chats, titles: [:])
    XCTAssertEqual(rows.map(\.stateLabel), ["1 task", "3 tasks", "working", "needs you", "idle"])
    XCTAssertFalse(DrawerChatRows.othersWaiting(chats: Array(chats.prefix(3)), open: nil))
  }
}
