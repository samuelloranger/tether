import XCTest
@testable import TetherKit

final class ChatQuestionTests: XCTestCase {
  private func decode(_ object: [String: Any]) -> ACPInbound {
    ACPDecoder.decode(try! JSONSerialization.data(withJSONObject: object))
  }

  private func request(_ properties: [String: Any], required: [String]? = nil, id: Any = 5) -> ACPInbound {
    var schema: [String: Any] = ["type": "object", "properties": properties]
    if let required { schema["required"] = required }
    return decode([
      "jsonrpc": "2.0", "id": id, "method": "elicitation/create",
      "params": ["mode": "form", "sessionId": "s", "toolCallId": "t1", "message": "Pick", "requestedSchema": schema],
    ])
  }

  private func fields(_ message: ACPInbound) -> [ChatQuestionField] {
    guard case let .elicitation(_, request) = message else { XCTFail("\(message)"); return [] }
    return request.fields
  }

  private func choice(_ value: String, _ title: String? = nil, _ description: String = "") -> [String: Any] {
    ["const": value, "title": title ?? value, "description": description]
  }

  // MARK: Decoding

  func test_the_recorded_request_decodes_to_one_single_select_with_an_other_companion() {
    let line = ACPFixture.Elicitation.agentLines[ACPFixture.Elicitation.requestLine]
    guard case let .elicitation(id, request) = ACPDecoder.decode(Data(line.utf8)) else { return XCTFail() }
    XCTAssertEqual(id, .int(0))
    XCTAssertEqual(request.toolCallId, "toolu_018YwX7H4Ke3gQSGdDrZaV2s")
    XCTAssertEqual(request.message, "Which colour do you prefer?")
    XCTAssertEqual(request.fields.count, 1)
    let field = request.fields[0]
    XCTAssertEqual(field.name, "question_0")
    XCTAssertEqual(field.title, "Colour")
    XCTAssertEqual(field.choices.map(\.value), ["red", "green", "blue"])
    XCTAssertEqual(field.choices.map(\.description), ["Red", "Green", "Blue"])
    XCTAssertFalse(field.required)
    XCTAssertEqual(field.custom?.name, "question_0_custom")
    XCTAssertEqual(field.custom?.title, "Other")
    guard case .single = field.kind else { return XCTFail() }
  }

  func test_the_recorded_log_is_decoded_without_dropping_any_line() {
    for line in ACPFixture.Elicitation.agentLines {
      if case .unknown = ACPDecoder.decode(Data(line.utf8)),
        !line.contains("session/update")
      {
        XCTFail(line)
      }
    }
  }

  func test_the_initialize_request_recorded_from_the_real_adapter_advertises_the_form_capability() throws {
    let line = try XCTUnwrap(ACPFixture.Elicitation.clientLines.first)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
    let capabilities = try XCTUnwrap((object["params"] as? [String: Any])?["clientCapabilities"] as? [String: Any])
    XCTAssertEqual(capabilities["elicitation"] as? NSDictionary, ["form": [:]] as NSDictionary)
  }

  func test_multi_select_accepts_items_oneOf_anyOf_and_enum() {
    let parsed = fields(request([
      "a": ["type": "array", "title": "A", "items": ["oneOf": [choice("x", "X", "the x"), choice("y")]]],
      "b": ["type": "array", "items": ["anyOf": [choice("p"), choice("q")]]],
      "c": ["type": "array", "items": ["enum": ["m", "n"], "enumNames": ["Em", "En"]]],
    ]))
    XCTAssertEqual(parsed.map(\.name), ["a", "b", "c"])
    for field in parsed { guard case .multi = field.kind else { return XCTFail(field.name) } }
    XCTAssertEqual(parsed[0].choices, [
      ChatQuestionChoice(value: "x", title: "X", description: "the x"),
      ChatQuestionChoice(value: "y", title: "y", description: ""),
    ])
    XCTAssertEqual(parsed[1].choices.map(\.value), ["p", "q"])
    XCTAssertEqual(parsed[2].choices.map(\.title), ["Em", "En"])
  }

  func test_single_select_accepts_anyOf_and_enum_and_numeric_constants() {
    let parsed = fields(request([
      "a": ["type": "string", "anyOf": [choice("x"), choice("y")]],
      "b": ["type": "string", "enum": ["m", "n"]],
      "c": ["type": "integer", "enum": [1, 2]],
    ]))
    for field in parsed { guard case .single = field.kind else { return XCTFail(field.name) } }
    XCTAssertEqual(parsed[1].choices.map(\.title), ["m", "n"])
    XCTAssertEqual(parsed[2].choices.map(\.value), ["1", "2"])
  }

  func test_boolean_unknown_and_empty_choice_fields_and_required() {
    let parsed = fields(request([
      "yes": ["type": "boolean", "title": "Run it"],
      "num": ["type": "number", "title": "Count"],
      "odd": ["type": "frobnicate"],
      "empty": ["type": "string", "oneOf": [Any]()],
      "arr": ["type": "array", "items": ["type": "string"]],
      "plain": ["type": "string", "description": "free"],
    ], required: ["plain", "yes"]))
    let byName = Dictionary(uniqueKeysWithValues: parsed.map { ($0.name, $0) })
    XCTAssertEqual(byName["yes"]?.kind, .boolean)
    XCTAssertEqual(byName["yes"]?.required, true)
    for name in ["num", "odd", "empty", "arr", "plain"] { XCTAssertEqual(byName[name]?.kind, .text, name) }
    XCTAssertEqual(byName["plain"]?.required, true)
    XCTAssertEqual(byName["odd"]?.title, "odd")
  }

  func test_fields_keep_numeric_order_and_a_custom_without_a_choice_stays_a_field() {
    let parsed = fields(request([
      "question_10": ["type": "string", "oneOf": [choice("a")]],
      "question_2": ["type": "string", "oneOf": [choice("b")]],
      "question_2_custom": ["type": "string", "title": "Other"],
      "note_custom": ["type": "string"],
      "note": ["type": "string"],
    ]))
    XCTAssertEqual(parsed.map(\.name), ["note", "note_custom", "question_2", "question_10"])
    XCTAssertEqual(parsed.first { $0.name == "question_2" }?.custom?.name, "question_2_custom")
    XCTAssertNil(parsed.first { $0.name == "note" }?.custom, "a text field has no companion")
  }

  func test_a_malformed_request_still_becomes_a_question_the_user_can_decline() {
    for params: [String: Any] in [[:], ["message": 4], ["requestedSchema": "no"], ["requestedSchema": ["properties": 3]]] {
      let message = decode(["jsonrpc": "2.0", "id": "r-1", "method": "elicitation/create", "params": params])
      guard case let .elicitation(id, request) = message else { return XCTFail("\(params)") }
      XCTAssertEqual(id, .string("r-1"))
      XCTAssertEqual(request.message, "The agent has a question.")
      XCTAssertTrue(request.fields.isEmpty)
    }
    XCTAssertEqual(
      decode(["jsonrpc": "2.0", "method": "elicitation/create", "params": [:]]), .unknown(method: "elicitation/create"),
      "a notification has nothing to reply to")
  }

  // MARK: Reducer

  private func question(_ properties: [String: Any]? = nil, id: Int = 5) -> ChatState {
    let message = request(properties ?? ["question_0": ["type": "string", "oneOf": [choice("red"), choice("blue")]]], id: id)
    return ChatReducer.reduce(ChatState(), .message(message))
  }

  func test_a_request_appends_a_pending_question() {
    let state = question()
    XCTAssertEqual(state.pendingQuestions.map(\.requestId), [.int(5)])
    guard case let .question(question) = state.items.last?.kind else { return XCTFail() }
    XCTAssertEqual(question.message, "Pick")
    XCTAssertEqual(question.state, .pending)
  }

  func test_answer_decline_and_cancel_resolve_the_question() {
    let answered = ChatReducer.reduce(
      question(), .questionAnswered(requestId: .int(5), action: .accept, content: ["question_0": .text("red")]))
    XCTAssertTrue(answered.pendingQuestions.isEmpty)
    guard case let .question(a) = answered.items.last?.kind else { return XCTFail() }
    XCTAssertEqual(a.state, .answered(["question_0": .text("red")]))
    XCTAssertEqual(a.answerSummary, "red")

    for (action, expected) in [(ChatQuestionAction.decline, ChatQuestion.State.declined), (.cancel, .cancelled)] {
      let state = ChatReducer.reduce(question(), .questionAnswered(requestId: .int(5), action: action, content: [:]))
      guard case let .question(q) = state.items.last?.kind else { return XCTFail() }
      XCTAssertEqual(q.state, expected)
      XCTAssertNil(q.answerSummary)
    }
  }

  func test_a_second_answer_does_not_override_the_first() {
    var state = ChatReducer.reduce(question(), .questionAnswered(requestId: .int(5), action: .decline, content: [:]))
    state = ChatReducer.reduce(
      state, .questionAnswered(requestId: .int(5), action: .accept, content: ["question_0": .text("red")]))
    guard case let .question(q) = state.items.last?.kind else { return XCTFail() }
    XCTAssertEqual(q.state, .declined)
  }

  func test_an_undelivered_answer_reopens_the_question_unless_something_else_resolved_it() {
    let content: [String: ChatQuestionValue] = ["question_0": .text("red")]
    var state = ChatReducer.reduce(question(), .questionAnswered(requestId: .int(5), action: .accept, content: content))
    state = ChatReducer.reduce(state, .questionAnswerUndelivered(requestId: .int(5), action: .accept, content: content))
    XCTAssertEqual(state.pendingQuestions.count, 1)

    state = ChatReducer.reduce(state, .hostAnswered(requestId: .int(5), optionId: "blue"))
    XCTAssertTrue(state.pendingQuestions.isEmpty)
    state = ChatReducer.reduce(state, .questionAnswerUndelivered(requestId: .int(5), action: .accept, content: content))
    XCTAssertTrue(state.pendingQuestions.isEmpty, "the host's answer stands")
  }

  func test_a_turn_end_or_error_clears_an_unanswered_question_as_cancelled() {
    for ending: ACPInbound in [
      .response(id: .int(3), result: ACPResult(stopReason: "end_turn")),
      .errorResponse(id: .int(3), code: -1, message: "boom"),
    ] {
      let state = ChatReducer.reduce(question(), .message(ending))
      XCTAssertTrue(state.pendingQuestions.isEmpty)
      guard case let .question(q) = state.items.first?.kind else { return XCTFail() }
      XCTAssertEqual(q.state, .cancelled)
    }
    var answered = ChatReducer.reduce(question(), .questionAnswered(requestId: .int(5), action: .decline, content: [:]))
    answered = ChatReducer.reduce(answered, .message(.response(id: .int(3), result: ACPResult(stopReason: "end_turn"))))
    guard case let .question(q) = answered.items.first?.kind else { return XCTFail() }
    XCTAssertEqual(q.state, .declined, "a resolved question keeps its outcome")
  }

  func test_host_answers_map_values_to_the_first_choice_field_and_declined_cancelled_to_states() {
    let properties: [String: Any] = [
      "a_note": ["type": "string"],
      "q1": ["type": "array", "items": ["anyOf": [choice("x"), choice("y")]]],
      "q2": ["type": "string", "oneOf": [choice("red")]],
    ]
    func state(for value: String) -> ChatQuestion.State {
      var state = ChatReducer.reduce(ChatState(), .hostAnswered(requestId: .int(5), optionId: value))
      state = ChatReducer.reduce(state, .message(request(properties)))
      guard case let .question(q) = state.items.last?.kind else { return .pending }
      return q.state
    }
    XCTAssertEqual(state(for: "x"), .answered(["q1": .list(["x"])]), "a request that arrives after its host answer")
    XCTAssertEqual(state(for: "declined"), .declined)
    XCTAssertEqual(state(for: "cancelled"), .cancelled)

    var live = ChatReducer.reduce(question(), .hostAnswered(requestId: .int(5), optionId: "blue"))
    guard case let .question(q) = live.items.last?.kind else { return XCTFail() }
    XCTAssertEqual(q.state, .answered(["question_0": .text("blue")]))
    live = ChatReducer.reduce(live, .hostAnswered(requestId: .int(6), optionId: "red"))
    XCTAssertEqual(live.items.count, 1, "an answer for an unknown request adds nothing")
  }

  func test_the_question_tools_own_calls_stay_out_of_the_transcript() {
    func call(_ kind: String, _ status: String?, name: String?) -> ACPInbound {
      var update: [String: Any] = ["sessionUpdate": kind, "toolCallId": "t1", "title": "Asking for your input"]
      if let status { update["status"] = status }
      if let name { update["_meta"] = ["claudeCode": ["toolName": name]] }
      return decode(["jsonrpc": "2.0", "method": "session/update", "params": ["update": update]])
    }
    var state = ChatState()
    state = ChatReducer.reduce(state, .message(call("tool_call", "pending", name: "AskUserQuestion")))
    state = ChatReducer.reduce(state, .message(call("tool_call_update", "completed", name: nil)))
    XCTAssertTrue(state.items.isEmpty)
    let other = ChatReducer.reduce(ChatState(), .message(call("tool_call", "pending", name: "Bash")))
    XCTAssertEqual(other.items.count, 1)
  }

  func test_the_answer_summary_names_choices_lists_and_notes() {
    let state = ChatReducer.reduce(ChatState(), .message(request([
      "question_0": ["type": "string", "oneOf": [choice("v", "Vitest")]],
      "question_1": ["type": "array", "items": ["anyOf": [choice("l", "Lint"), choice("t", "Types")]]],
      "question_1_custom": ["type": "string"],
      "question_2": ["type": "boolean"],
    ])))
    guard case var .question(q) = state.items[0].kind else { return XCTFail() }
    q.state = .answered([
      "question_0": .text("v"), "question_1": .list(["l", "t"]), "question_1_custom": .text("and docs"),
      "question_2": .flag(true),
    ])
    XCTAssertEqual(q.answerSummary, "Vitest \u{00B7} Lint, Types, and docs \u{00B7} Yes")
    q.state = .answered([:])
    XCTAssertEqual(q.answerSummary, "Answered")
  }

  // MARK: Journal and replay

  func test_a_journaled_answer_resolves_the_question_on_replay_and_state_round_trips() throws {
    let journal = ACPFixture.Elicitation.journal(answer: ["question_0": .text("green")])
    let decodedJournal = try JSONDecoder().decode(ChatJournal.self, from: JSONEncoder().encode(journal))
    XCTAssertEqual(decodedJournal, journal)
    XCTAssertTrue(journal.answeredRequestIds.contains(.int(0)))
    let log = Data(ACPFixture.Elicitation.agentLines.prefix(ACPFixture.Elicitation.requestLine + 1).joined(separator: "\n").utf8)
      + Data("\n".utf8)
    let state = try ChatTranscriptBuilder.replay(log: log, journal: journal)
    XCTAssertTrue(state.pendingQuestions.isEmpty)
    guard case let .question(q) = state.items.first(where: { if case .question = $0.kind { true } else { false } })?.kind
    else { return XCTFail() }
    XCTAssertEqual(q.state, .answered(["question_0": .text("green")]))
    XCTAssertEqual(try JSONDecoder().decode(ChatState.self, from: JSONEncoder().encode(state)), state)
    XCTAssertTrue(state.items.allSatisfy { if case .tool = $0.kind { false } else { true } }, "no AskUserQuestion tool row")
  }

  func test_the_snapshot_digest_covers_the_answers_content() {
    func entry(_ text: String) -> ChatJournal.Entry {
      .init(kind: .questionAnswer, offset: 0, requestId: .int(0), optionId: "accept", content: ["k": .text(text)])
    }
    XCTAssertEqual(ChatSnapshot.digest([entry("a")]), ChatSnapshot.digest([entry("a")]))
    XCTAssertNotEqual(ChatSnapshot.digest([entry("a")]), ChatSnapshot.digest([entry("b")]))
    XCTAssertEqual(ChatSnapshot.currentVersion, 2)
  }

  func test_an_old_journal_entry_without_content_still_decodes() throws {
    let json = #"{"kind":"answer","offset":3,"requestId":0,"optionId":"allow-once","imageCount":0}"#
    let entry = try JSONDecoder().decode(ChatJournal.Entry.self, from: Data(json.utf8))
    XCTAssertNil(entry.content)
    XCTAssertEqual(entry.event, .permissionAnswered(requestId: .int(0), optionId: "allow-once"))
  }
}
