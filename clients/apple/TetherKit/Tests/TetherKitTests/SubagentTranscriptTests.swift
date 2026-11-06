import XCTest
@testable import TetherKit

final class SubagentTranscriptTests: XCTestCase {
  private func fields(
    _ id: String, title: String? = nil, status: ACPToolStatus? = nil, text: String? = nil, parent: String? = nil,
    name: String? = nil, input: [String: String]? = nil
  ) -> ACPToolFields {
    var fields = ACPToolFields(id: id)
    fields.title = title
    fields.status = status
    fields.text = text
    fields.parentId = parent
    fields.toolName = name
    fields.input = input
    return fields
  }

  private func reduce(_ events: [ACPUpdate], from state: ChatState = ChatState()) -> ChatState {
    events.reduce(state) { ChatReducer.reduce($0, .message(.update($1))) }
  }

  private func calls(_ state: ChatState) -> [ChatToolCall] {
    state.items.compactMap { if case let .tool(call) = $0.kind { call } else { nil } }
  }

  private let launch: [ACPUpdate] = [
    .toolCall(ACPToolFields(id: "a", title: "Task", kind: .think, status: .pending, toolName: "Agent")),
  ]

  func test_children_nest_under_their_launch_and_create_no_top_level_rows() {
    let state = reduce(launch + [
      .toolCall(fields("c1", title: "Read a", parent: "a")),
      .toolCall(fields("c2", title: "Bash b", parent: "a")),
      .toolCall(fields("m", title: "Main tool")),
    ])
    let top = calls(state)
    XCTAssertEqual(top.map(\.id), ["a", "m"])
    XCTAssertEqual(top[0].children.map(\.id), ["c1", "c2"])
    XCTAssertEqual(top[0].children[0].parentId, "a")
    XCTAssertEqual(state.items.count, 2)
  }

  func test_updates_merge_by_id_at_either_level() {
    let state = reduce(launch + [
      .toolCall(fields("c1", title: "Read a", status: .pending, parent: "a")),
      .toolCallUpdate(fields("c1", status: .completed, text: "body")),
      .toolCallUpdate(fields("a", status: .completed)),
    ])
    let top = calls(state)
    XCTAssertEqual(top.count, 1)
    XCTAssertEqual(top[0].status, .completed)
    XCTAssertEqual(top[0].children.count, 1)
    XCTAssertEqual(top[0].children[0].status, .completed)
    XCTAssertEqual(top[0].children[0].text, "body")
    XCTAssertEqual(top[0].children[0].title, "Read a")
  }

  func test_a_child_with_an_unknown_parent_falls_back_to_a_top_level_row() {
    let state = reduce([.toolCall(fields("c1", title: "Read a", parent: "missing"))])
    XCTAssertEqual(calls(state).map(\.id), ["c1"])
    XCTAssertEqual(calls(state)[0].parentId, "missing")
  }

  func test_a_nested_subagents_calls_join_the_same_child_list() {
    let state = reduce(launch + [
      .toolCall(fields("inner", title: "Task", parent: "a", name: "Agent")),
      .toolCall(fields("deep", title: "Read deep", parent: "inner")),
    ])
    let top = calls(state)
    XCTAssertEqual(top.count, 1)
    XCTAssertEqual(top[0].children.map(\.id), ["inner", "deep"])
  }

  func test_title_and_input_fill_in_progressively() {
    let state = reduce(launch + [
      .toolCallUpdate(fields("a", title: "run the check", status: .inProgress, input: ["description": "run the check"])),
      .toolCallUpdate(fields("a", input: ["description": "run the check", "model": "sonnet"])),
      .toolCallUpdate(fields("a", input: [
        "description": "run the check", "model": "sonnet", "prompt": "the brief", "subagent_type": "reviewer",
      ])),
    ])
    let call = calls(state)[0]
    XCTAssertEqual(call.title, "run the check")
    XCTAssertEqual(call.subagent, ChatSubagent(description: "run the check", model: "sonnet", subagentType: "reviewer", prompt: "the brief"))
    XCTAssertEqual(call.subagentTitle, "run the check")
    XCTAssertEqual(calls(reduce(launch))[0].subagentTitle, "Subagent")
  }

  func test_a_non_subagent_call_ignores_input_and_is_not_a_launch() {
    let state = reduce([.toolCall(fields("b", title: "Bash", name: "Bash", input: ["description": "x", "prompt": "y"]))])
    XCTAssertNil(calls(state)[0].subagent)
  }

  func test_the_async_launch_text_is_suppressed_and_marks_the_run_as_background() {
    let state = reduce(launch + [
      .toolCallUpdate(fields("a", status: .completed, text: "Async agent launched successfully. (This tool result is internal metadata.)\nagentId: x")),
      .toolCall(fields("c1", title: "Read a", status: .inProgress, parent: "a")),
    ])
    let call = calls(state)[0]
    XCTAssertNil(call.text)
    XCTAssertEqual(call.subagent?.background, true)
    XCTAssertTrue(call.isActive)
    XCTAssertEqual(state.subagentActivity, "Subagent \u{00B7} Read a")
  }

  func test_run_in_background_input_marks_the_run_as_background() {
    let state = reduce(launch + [.toolCallUpdate(fields("a", input: ["run_in_background": "true"]))])
    XCTAssertEqual(calls(state)[0].subagent?.background, true)
  }

  func test_a_foreground_report_is_kept() {
    let state = reduce(launch + [.toolCallUpdate(fields("a", status: .completed, text: "## Report\n\nAll good."))])
    let call = calls(state)[0]
    XCTAssertEqual(call.text, "## Report\n\nAll good.")
    XCTAssertEqual(call.subagent?.background, false)
    XCTAssertFalse(call.isActive)
  }

  func test_a_permission_for_a_childs_call_merges_into_the_nested_row() {
    var tool = fields("c1", title: "Bash run", parent: "a")
    var state = reduce(launch + [.toolCall(tool)])
    tool.title = "Bash run (needs approval)"
    state = ChatReducer.reduce(state, .message(.permissionRequest(
      id: .int(1), request: ACPPermissionRequest(tool: tool, options: []))))
    XCTAssertEqual(calls(state).count, 1)
    XCTAssertEqual(calls(state)[0].children[0].title, "Bash run (needs approval)")
    XCTAssertEqual(state.pendingPermissions.count, 1)
  }

  func test_decoder_reads_the_adapter_meta_and_raw_input() {
    let line = """
    {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"a","title":"go","rawInput":{"description":"go","run_in_background":true,"n":2,"nested":{"x":1}},"_meta":{"claudeCode":{"toolName":"Agent","parentToolUseId":"p"}}}}}
    """
    guard case let .update(.toolCallUpdate(fields)) = ACPDecoder.decode(Data(line.utf8)) else { return XCTFail() }
    XCTAssertEqual(fields.toolName, "Agent")
    XCTAssertEqual(fields.parentId, "p")
    XCTAssertEqual(fields.input, ["description": "go", "run_in_background": "true", "n": "2"])
  }

  func test_replay_from_zero_equals_the_live_path() throws {
    let log = Data((ChatFixtureLines.subagents.joined(separator: "\n") + "\n").utf8)
    let journal = ChatJournal()
    let replayed = try ChatTranscriptBuilder.replay(log: log, journal: journal)
    var live = ChatTranscriptBuilder(journal: journal)
    for line in ChatFixtureLines.subagents { try live.feed(Data((line + "\n").utf8)) }
    XCTAssertEqual(live.state, replayed)
    let top = calls(replayed)
    XCTAssertEqual(top.map(\.id), ["a", "m", "b"])
    XCTAssertEqual(top[0].children.map(\.id), ["c1", "c2"])
    XCTAssertEqual(top[0].children[0].status, .completed)
    XCTAssertEqual(top[2].subagent?.background, true)
    XCTAssertNil(top[2].text)
  }

  // MARK: - OpenCode child sessions

  private func apply(_ frames: [String]) -> ChatState {
    frames.reduce(ChatState()) { state, json in
      ChatReducer.reduce(state, .message(ACPDecoder.decode(Data(json.utf8))))
    }
  }

  private func thoughts(_ state: ChatState) -> [String] {
    state.items.compactMap { if case let .thought(text) = $0.kind { text } else { nil } }
  }

  private let openCodeLaunch = #"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"call_task","title":"Explore the codebase","kind":"think","status":"in_progress","rawInput":{"description":"Explore the codebase","prompt":"Read src/app.ts"},"rawOutput":{"metadata":{"sessionId":"ses_child","model":"x"}}}}}"#

  private let openCodeChild = #"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"ses_child:call_1","title":"Explore the codebase: Read src/app.ts","kind":"read","status":"in_progress","_meta":{"opencode/child-session":{"id":"ses_child","parentID":"ses_123","depth":1,"title":"Explore the codebase"}}}}}"#

  func test_decoder_reads_the_opencode_child_session_dialect() {
    guard case let .update(.toolCall(child)) = ACPDecoder.decode(Data(openCodeChild.utf8)) else { return XCTFail() }
    XCTAssertEqual(child.childSessionId, "ses_child")
    XCTAssertEqual(child.childParentSessionId, "ses_123")
    XCTAssertEqual(child.childTitle, "Explore the codebase")

    guard case let .update(.toolCall(launch)) = ACPDecoder.decode(Data(openCodeLaunch.utf8)) else { return XCTFail() }
    XCTAssertEqual(launch.launchedSessionId, "ses_child")
  }

  func test_opencode_child_calls_nest_under_the_task_that_launched_them() {
    let main = #"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"call_main","title":"ls","kind":"execute","status":"in_progress"}}}"#
    let state = apply([openCodeLaunch, openCodeChild, main])
    let top = calls(state)
    XCTAssertEqual(top.map(\.id), ["call_task", "call_main"])
    XCTAssertEqual(top[0].children.map(\.id), ["ses_child:call_1"])
    XCTAssertEqual(top[0].children[0].title, "Read src/app.ts")
    XCTAssertNotNil(top[0].subagent)
    XCTAssertEqual(top[0].subagentTitle, "Explore the codebase")
  }

  func test_opencode_child_thoughts_and_messages_stay_out_of_the_main_transcript() {
    let rootThought = #"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"main reasoning"}}}}"#
    let childThought = #"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"child reasoning"},"_meta":{"opencode/child-session":{"id":"ses_child","parentID":"ses_123","depth":1,"title":"Explore the codebase"}}}}}"#
    let childMessage = #"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","messageId":"ses_child:m1","content":{"type":"text","text":"child narration"},"_meta":{"opencode/child-session":{"id":"ses_child","parentID":"ses_123","depth":1,"title":"Explore the codebase"}}}}}"#
    let state = apply([rootThought, childThought, childMessage])
    XCTAssertEqual(thoughts(state), ["main reasoning"])
    XCTAssertFalse(state.items.contains {
      if case let .assistant(text, _) = $0.kind { text.contains("child narration") } else { false }
    })
  }

  func test_a_late_task_metadata_adopts_children_that_arrived_first() {
    let state = apply([openCodeChild, openCodeLaunch])
    let top = calls(state)
    XCTAssertEqual(top.map(\.id), ["call_task"])
    XCTAssertEqual(top[0].children.map(\.id), ["ses_child:call_1"])
    XCTAssertEqual(state.items.count, 1)
  }

  // MARK: - Codex native subagents

  private let codexSpawn = #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_root","update":{"sessionUpdate":"subagent_spawned","subagentSessionId":"sub-1","name":"Explore the repo","task":"Read src/app.ts"}}}"#

  func test_codex_native_subagent_spawn_creates_a_row_that_child_updates_nest_under() {
    let childTool = #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sub-1","update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Read src/app.ts","kind":"read","status":"in_progress"}}}"#
    let childThought = #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sub-1","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"child reasoning"}}}}"#
    let state = apply([codexSpawn, childTool, childThought])
    let top = calls(state)
    XCTAssertEqual(top.map(\.id), ["subagent:sub-1"])
    XCTAssertEqual(top[0].children.map(\.id), ["t1"])
    XCTAssertEqual(top[0].subagentTitle, "Explore the repo")
    XCTAssertEqual(thoughts(state), [])
  }

  func test_codex_subagent_state_update_finishes_the_row() {
    let done = #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_root","update":{"sessionUpdate":"subagent_state_update","subagentSessionId":"sub-1","state":"completed"}}}"#
    let state = apply([codexSpawn, done])
    XCTAssertEqual(calls(state)[0].status, .completed)
  }

  func test_scoped_updates_on_the_chat_session_still_apply() {
    let message = #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_root","update":{"sessionUpdate":"agent_message_chunk","messageId":"m1","content":{"type":"text","text":"hello"}}}}"#
    let state = apply([message])
    XCTAssertTrue(state.items.contains {
      if case let .assistant(text, _) = $0.kind { text == "hello" } else { false }
    })
  }
}

private enum ChatFixtureLines {
  private static func update(_ body: [String: Any]) -> String {
    let object: [String: Any] = ["jsonrpc": "2.0", "method": "session/update", "params": ["update": body]]
    return String(decoding: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
  }

  private static func tool(
    _ id: String, _ title: String, _ status: String, update isUpdate: Bool = false, parent: String? = nil,
    name: String? = nil, input: [String: Any]? = nil, text: String? = nil
  ) -> String {
    var body: [String: Any] = [
      "sessionUpdate": isUpdate ? "tool_call_update" : "tool_call", "toolCallId": id, "title": title, "status": status,
    ]
    var meta: [String: Any] = [:]
    if let parent { meta["parentToolUseId"] = parent }
    if let name { meta["toolName"] = name }
    if !meta.isEmpty { body["_meta"] = ["claudeCode": meta] }
    if let input { body["rawInput"] = input }
    if let text { body["content"] = [["type": "content", "content": ["type": "text", "text": text]]] }
    return update(body)
  }

  static let subagents: [String] = [
    tool("a", "Task", "pending", name: "Agent"),
    tool("a", "check things", "in_progress", update: true, name: "Agent", input: ["description": "check things"]),
    tool("c1", "Read a", "pending", parent: "a"),
    tool("c1", "Read a", "completed", update: true, parent: "a", text: "body"),
    tool("c2", "Bash b", "in_progress", parent: "a"),
    tool("m", "Main tool", "completed"),
    tool("a", "check things", "completed", update: true, name: "Agent", text: "The report."),
    tool("b", "Task", "pending", name: "Agent"),
    tool("b", "audit", "completed", update: true, name: "Agent", input: ["description": "audit"],
      text: "Async agent launched successfully. (internal)\nagentId: z"),
    tool("d1", "Read d", "in_progress", parent: "b"),
  ]
}
