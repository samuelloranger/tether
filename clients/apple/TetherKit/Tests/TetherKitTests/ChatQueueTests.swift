import XCTest
@testable import TetherKit

private func chunk(_ text: String, kind: String = "agent_message_chunk", id: String = "m1") -> ACPInbound {
  .update(kind == "user_message_chunk" ? .userMessage(text: text) : .agentMessage(text: text, messageId: id))
}

private func done(_ id: Int, _ reason: String = "end_turn") -> ACPInbound {
  ACPDecoder.decode(Data("{\"jsonrpc\":\"2.0\",\"id\":\(id),\"result\":{\"stopReason\":\"\(reason)\"}}".utf8))
}

private func prompt(_ text: String, id: Int, _ state: ChatState) -> ChatState {
  ChatReducer.reduce(state, .userPrompt(text: text, atOffset: 0, requestId: .int(id)))
}

private func reduce(_ state: ChatState, _ message: ACPInbound) -> ChatState {
  ChatReducer.reduce(state, .message(message))
}

private func userId(_ text: String, in state: ChatState) -> Int {
  state.items.first {
    if case let .user(existing, _, _, _) = $0.kind { return existing == text }
    return false
  }!.id
}

final class ChatQueueTests: XCTestCase {
  func test_a_second_prompt_is_queued_until_the_first_ends_and_the_agent_starts_it() {
    var state = prompt("one", id: 1, ChatState())
    XCTAssertTrue(state.queuedItemIds.isEmpty, "the first prompt starts at once")
    state = prompt("two", id: 2, state)
    let two = userId("two", in: state)
    XCTAssertEqual(state.queuedItemIds, [two])

    state = reduce(state, chunk("working on one"))
    XCTAssertTrue(state.isQueued(two), "output of the running prompt does not start the next")
    state = reduce(state, done(1))
    XCTAssertEqual(state.turn, .working, "the turn lasts until the last prompt answers")
    XCTAssertTrue(state.isQueued(two), "kept until the agent's own output arrives")
    state = reduce(state, chunk("working on two", id: "m2"))
    XCTAssertFalse(state.isQueued(two))
    state = reduce(state, done(2))
    XCTAssertEqual(state.turn, .idle)
  }

  func test_the_prompts_own_response_clears_its_label_even_without_output() {
    var state = prompt("one", id: 1, ChatState())
    state = prompt("two", id: 2, state)
    state = reduce(state, done(1))
    state = reduce(state, done(2))
    XCTAssertTrue(state.queuedItemIds.isEmpty)
    XCTAssertEqual(state.turn, .idle)
  }

  func test_responses_match_by_id_not_by_order() {
    var state = prompt("one", id: 1, ChatState())
    state = prompt("two", id: 2, state)
    state = prompt("three", id: 3, state)
    state = reduce(state, done(2, "cancelled"))
    XCTAssertEqual(state.turn, .working)
    XCTAssertEqual(state.queuedItemIds, [userId("three", in: state)])
    state = reduce(state, done(1))
    state = reduce(state, done(3))
    XCTAssertEqual(state.turn, .idle)
  }

  func test_an_echoed_user_message_starts_the_queued_prompt_without_doubling_it() {
    var state = prompt("one", id: 1, ChatState())
    state = prompt("two", id: 2, state)
    state = reduce(state, done(1))
    state = reduce(state, chunk("two", kind: "user_message_chunk"))
    XCTAssertTrue(state.queuedItemIds.isEmpty)
    let users = state.items.compactMap { item -> String? in
      if case let .user(text, _, _, _) = item.kind { return text }
      return nil
    }
    XCTAssertEqual(users, ["one", "two"])
  }

  private func users(_ state: ChatState) -> [String] {
    state.items.compactMap { if case let .user(text, _, _, _) = $0.kind { text } else { nil } }
  }

  func test_the_running_answer_keeps_streaming_into_one_row_past_a_queued_message() {
    var state = prompt("one", id: 1, ChatState())
    state = reduce(state, chunk("Hel"))
    state = prompt("two", id: 2, state)
    state = prompt("three", id: 3, state)
    state = reduce(state, chunk("lo"))
    XCTAssertEqual(state.items[1].kind, .assistant(text: "Hello", messageId: "m1"))
    XCTAssertEqual(users(state), ["one", "two", "three"], "queued ones wait at the end, in order")
    XCTAssertEqual(state.queuedTexts, ["two", "three"])
    state = reduce(state, done(1))
    state = reduce(state, chunk("on two", id: "m2"))
    XCTAssertEqual(state.queuedTexts, ["three"])
    XCTAssertEqual(state.items.last.map { if case let .user(text, _, _, _) = $0.kind { text } else { "" } }, "three")
    XCTAssertEqual(state.items[state.items.count - 2].kind, .assistant(text: "on two", messageId: "m2"))
  }

  func test_a_stop_sends_the_waiting_text_again_and_counts_the_pictures_it_cannot() {
    var state = prompt("one", id: 1, ChatState())
    state = prompt("two", id: 2, state)
    state = ChatReducer.reduce(state, .userPrompt(text: "", imageCount: 2, atOffset: 0, requestId: .int(3)))
    state = ChatReducer.reduce(state, .userPrompt(text: "three", imageCount: 1, atOffset: 0, requestId: .int(4)))
    let waiting = state.queuedResend
    XCTAssertEqual(waiting.text, "two\n\nthree")
    XCTAssertEqual(waiting.images, 3)
  }

  func test_stop_withdraws_the_queued_prompts_and_notes_it_once() {
    var state = prompt("one", id: 1, ChatState())
    state = prompt("two", id: 2, state)
    state = ChatReducer.reduce(state, .cancelRequested)
    XCTAssertTrue(state.queuedItemIds.isEmpty)
    XCTAssertEqual(users(state), ["one"], "the agent never ran it")
    XCTAssertEqual(state.items.last?.kind, .notice("Stopped"))
    XCTAssertEqual(state.turn, .working, "only the agent's responses end the turn")
    state = reduce(state, done(1, "cancelled"))
    state = reduce(state, done(2, "cancelled"))
    XCTAssertEqual(state.turn, .idle)
    state = ChatReducer.reduce(state, .cancelRequested)
    XCTAssertEqual(state.items.filter { $0.kind == .notice("Stopped") }.count, 1, "nothing to stop when idle")
  }

  func test_an_undelivered_queued_prompt_leaves_the_running_turn_working() {
    var state = prompt("one", id: 1, ChatState())
    state = prompt("two", id: 2, state)
    state = ChatReducer.reduce(state, .promptUndelivered(text: "two", atOffset: 0, requestId: .int(2)))
    XCTAssertEqual(state.turn, .working)
    XCTAssertTrue(state.queuedItemIds.isEmpty)
    XCTAssertEqual(state.items.count, 1)
    state = ChatReducer.reduce(state, .promptUndelivered(text: "one", atOffset: 0, requestId: .int(1)))
    XCTAssertEqual(state.turn, .idle)
  }

  func test_a_prompt_recorded_without_an_id_still_matches_the_oldest_response() {
    var state = ChatReducer.reduce(ChatState(), .userPrompt(text: "old", atOffset: 0))
    state = reduce(state, done(7))
    XCTAssertEqual(state.turn, .idle)
  }

  // MARK: Context markers

  func test_clear_adds_a_divider_when_it_ends() {
    var state = prompt("hello", id: 1, ChatState())
    state = reduce(state, chunk("hi"))
    state = reduce(state, done(1))
    state = prompt(" /clear \n", id: 2, state)
    XCTAssertFalse(state.items.contains { $0.kind == .divider("Context cleared") })
    state = reduce(state, done(2))
    XCTAssertEqual(state.items.last?.kind, .divider("Context cleared"))
    XCTAssertEqual(state.items.count, 4, "history stays above the divider")
  }

  func test_clear_that_was_cancelled_or_refused_adds_no_divider() {
    var state = prompt("/clear", id: 1, ChatState())
    state = reduce(state, done(1, "cancelled"))
    XCTAssertFalse(state.items.contains { if case .divider = $0.kind { return true } else { return false } })
    state = prompt("/clearly not", id: 2, state)
    state = reduce(state, done(2))
    XCTAssertFalse(state.items.contains { if case .divider = $0.kind { return true } else { return false } })
  }

  func test_compact_adds_a_divider_unless_the_agent_announced_it() {
    var quiet = prompt("/compact", id: 1, ChatState())
    quiet = reduce(quiet, done(1))
    XCTAssertEqual(quiet.items.last?.kind, .divider("Context compacted"))

    var announced = prompt("/compact", id: 1, ChatState())
    announced = reduce(announced, chunk("Conversation compacted"))
    announced = reduce(announced, done(1))
    XCTAssertFalse(announced.items.contains { if case .divider = $0.kind { return true } else { return false } })
  }

  func test_a_divider_sits_before_messages_queued_behind_it() {
    var state = prompt("/clear", id: 1, ChatState())
    state = prompt("next", id: 2, state)
    state = reduce(state, done(1))
    XCTAssertEqual(state.items.map(\.kind).dropFirst().first, .divider("Context cleared"))
    guard case .user = state.items.last?.kind else { return XCTFail("the queued message stays last") }
  }

  // MARK: Signed out

  func test_an_auth_error_becomes_one_sign_in_row_not_an_error_row() {
    var state = prompt("hi", id: 1, ChatState())
    let auth = ACPInbound.errorResponse(id: .int(1), code: -32000, message: "Authentication required")
    state = reduce(state, auth)
    XCTAssertEqual(state.items.last?.kind, .signedOut)
    XCTAssertEqual(state.turn, .idle)
    state = reduce(state, .errorResponse(id: .int(2), code: -32000, message: "Authentication required"))
    XCTAssertEqual(state.items.filter { $0.kind == .signedOut }.count, 1)
  }

  func test_the_adapters_auth_status_notification_drives_the_sign_in_row() {
    let none = ACPDecoder.decode(Data(
      "{\"jsonrpc\":\"2.0\",\"method\":\"_auth/status_update\",\"params\":{\"authStatus\":{\"kind\":\"none\",\"label\":\"Not logged in\"}}}".utf8))
    XCTAssertEqual(none, .authStatus(signedIn: false))
    let account = ACPDecoder.decode(Data(
      "{\"jsonrpc\":\"2.0\",\"method\":\"_auth/status_update\",\"params\":{\"authStatus\":{\"kind\":\"account\",\"label\":\"Team\"}}}".utf8))
    XCTAssertEqual(account, .authStatus(signedIn: true))

    var state = reduce(ChatState(), none)
    XCTAssertEqual(state.items.map(\.kind), [.signedOut])
    state = reduce(state, none)
    XCTAssertEqual(state.items.count, 1)
    state = reduce(state, account)
    XCTAssertTrue(state.items.isEmpty, "a later login makes the old row stale")
  }

  func test_a_failed_prompt_after_the_status_notice_shows_one_sign_in_row() {
    var state = prompt("hi", id: 1, ChatState())
    state = reduce(state, .authStatus(signedIn: false))
    state = reduce(state, .errorResponse(id: .int(1), code: -32000, message: "Authentication required"))
    XCTAssertEqual(state.items.filter { $0.kind == .signedOut }.count, 1)
    XCTAssertEqual(state.turn, .idle)
  }

  func test_the_status_notice_that_opens_a_turn_starts_the_queued_prompt() {
    var state = prompt("one", id: 1, ChatState())
    state = prompt("two", id: 2, state)
    state = reduce(state, .authStatus(signedIn: true))
    XCTAssertEqual(state.queuedItemIds.count, 1, "the running prompt's own notice does not start the next")
    state = reduce(state, done(1))
    state = reduce(state, .authStatus(signedIn: true))
    XCTAssertTrue(state.queuedItemIds.isEmpty)
  }

  func test_other_errors_stay_error_rows() {
    let state = reduce(ChatState(), .errorResponse(id: .int(3), code: -32603, message: "Internal error"))
    XCTAssertEqual(state.items.last?.kind, .error("Internal error"))
  }

  func test_the_auth_detector() {
    XCTAssertTrue(ChatAuthError.matches(code: -32000, message: ""))
    XCTAssertTrue(ChatAuthError.matches(code: -32603, message: "Please run /login to authenticate"))
    XCTAssertTrue(ChatAuthError.matches(code: 1, message: "Not logged in"))
    XCTAssertTrue(ChatAuthError.matches(code: 1, message: "Invalid credentials"))
    XCTAssertTrue(ChatAuthError.matches(code: 1, message: "Please sign in again"))
    XCTAssertFalse(ChatAuthError.matches(code: -32603, message: "Internal error"))
    XCTAssertFalse(ChatAuthError.matches(code: -32602, message: "Invalid params"))
    XCTAssertFalse(ChatAuthError.matches(code: -32601, message: "Method not found"))
    XCTAssertFalse(ChatAuthError.matches(code: 429, message: "Rate limit exceeded"))
    XCTAssertFalse(ChatAuthError.matches(code: 1, message: "Author field missing"))
    XCTAssertFalse(ChatAuthError.matches(code: 1, message: "Session not found"))
  }

  func test_the_composer_stops_only_when_working_with_nothing_typed() {
    XCTAssertEqual(ChatComposerRule.action(working: true, hasContent: false), .stop)
    XCTAssertEqual(ChatComposerRule.action(working: true, hasContent: true), .send)
    XCTAssertEqual(ChatComposerRule.action(working: false, hasContent: false), .send)
  }

  func test_a_signed_out_chat_reopens_live_and_an_untouched_one_stays_read_only() {
    var journal = ChatJournal()
    XCTAssertEqual(ChatOpenMode.mode(for: journal, multiClient: false), .readOnly)
    journal.nextRequestId = 3
    XCTAssertEqual(ChatOpenMode.mode(for: journal, multiClient: false), .resume)
  }
}

final class ChatQueueClientTests: XCTestCase {
  private func objects(_ stream: ScriptedByteStream) -> [NSDictionary] {
    stream.writtenText.split(separator: "\n").compactMap {
      (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? NSDictionary
    }
  }

  private func line(_ json: String) -> Data { Data((json + "\n").utf8) }

  func test_two_prompts_in_flight_stay_working_until_both_answer_and_replay_equals_live() async throws {
    var journal = ChatJournal()
    journal.sessionId = "sess-q"
    let store = InMemoryChatJournalStore(journal)
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream, store: store)
    await client.startReading()
    var log = Data()
    func agent(_ json: String) {
      log.append(line(json))
      stream.push(line(json))
    }
    func settle(_ predicate: @escaping (ChatState) async -> Bool) async {
      let end = Date().addingTimeInterval(3)
      while Date() < end {
        if await predicate(await client.state) { return }
        try? await Task.sleep(nanoseconds: 10_000_000)
      }
      XCTFail("state never settled")
    }

    try await client.prompt(text: "first")
    try await client.prompt(text: "second")
    let sent = objects(stream).filter { $0["method"] as? String == "session/prompt" }
    XCTAssertEqual(sent.compactMap { $0["id"] as? Int }, [1, 2])
    var state = await client.state
    XCTAssertEqual(state.queuedItemIds.count, 1)

    agent("{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"a\"},\"messageId\":\"m1\"}}}")
    agent("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"stopReason\":\"end_turn\"}}")
    await settle { $0.lastStopReason == "end_turn" }
    state = await client.state
    XCTAssertEqual(state.turn, .working)
    XCTAssertEqual(state.queuedItemIds.count, 1)

    agent("{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"b\"},\"messageId\":\"m2\"}}}")
    await settle { $0.queuedItemIds.isEmpty }
    try await client.cancel()
    agent("{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"stopReason\":\"cancelled\"}}")
    await settle { $0.turn == .idle }

    let live = await client.state
    XCTAssertEqual(live.items.last?.kind, .notice("Stopped"), "the cancel notice follows the stopped turn's output")
    XCTAssertEqual(live, try ChatTranscriptBuilder.replay(log: log, journal: store.load()))
    XCTAssertTrue(store.load().entries.contains { $0.kind == .cancel })
  }
}
