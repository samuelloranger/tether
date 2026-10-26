import XCTest
@testable import TetherKit

final class ACPLoadSessionTests: XCTestCase {
  private func written(_ stream: ScriptedByteStream) -> [NSDictionary] {
    stream.writtenText.split(separator: "\n").compactMap {
      (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? NSDictionary
    }
  }

  private func waitUntil(_ client: ACPClient, _ predicate: @escaping (ChatState) -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(3)
    while Date() < end {
      if predicate(await client.state) { return true }
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return false
  }

  /// Runs the whole handshake against the recorded load: initialize, then session/load, then the replay.
  private func loadedClient(store: InMemoryChatJournalStore = InMemoryChatJournalStore()) async throws
    -> (ACPClient, ScriptedByteStream)
  {
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream, store: store)
    let started = Task { try await client.start(cwd: "/work/project", loadSessionId: "sess-4") }
    let sentInit = await eventually { stream.writtenText.contains("\"method\":\"initialize\"") }
    XCTAssertTrue(sentInit)
    stream.push(ACPFixture.Load.log(0..<1))
    let sentLoad = await eventually { stream.writtenText.contains("session/load") }
    XCTAssertTrue(sentLoad)
    stream.push(ACPFixture.Load.log(1..<ACPFixture.Load.agentLines.count))
    try await started.value
    return (client, stream)
  }

  func test_a_load_asks_for_session_load_not_session_new() async throws {
    let (_, stream) = try await loadedClient()
    let load = written(stream).first { $0["method"] as? String == "session/load" }
    XCTAssertEqual(load?["id"] as? Int, 2)
    XCTAssertEqual(
      load?["params"] as? NSDictionary,
      ["sessionId": "sess-4", "cwd": "/work/project", "mcpServers": [Any]()] as NSDictionary)
    XCTAssertFalse(stream.writtenText.contains("session/new"))
  }

  func test_the_replayed_history_becomes_the_transcript_and_the_load_answer_is_read_like_session_new() async throws {
    let store = InMemoryChatJournalStore()
    let (client, _) = try await loadedClient(store: store)
    let ready = await waitUntil(client) { !$0.commands.isEmpty }
    XCTAssertTrue(ready)
    let state = await client.state
    XCTAssertEqual(state.sessionId, "sess-4")
    XCTAssertEqual(state.turn, .idle)
    XCTAssertFalse(state.configOptions.isEmpty)
    XCTAssertEqual(state.items.count, 3)
    guard case let .user(text, _, _) = state.items[0].kind else { return XCTFail("first row is the user message") }
    XCTAssertTrue(text.contains("cat notes.txt"))
    guard case let .tool(call) = state.items[1].kind else { return XCTFail("second row is the tool call") }
    XCTAssertEqual(call.title, "cat notes.txt")
    XCTAssertEqual(call.status, .completed)
    XCTAssertEqual(call.kind, .execute)
    guard case let .assistant(reply, _) = state.items[2].kind else { return XCTFail("third row is the reply") }
    XCTAssertEqual(reply, "3")
    XCTAssertEqual(store.load().sessionId, "sess-4")
    XCTAssertEqual(store.load().loadedSessionId, "sess-4")
    XCTAssertTrue(store.load().entries.isEmpty)
  }

  func test_replay_from_zero_equals_the_live_load() async throws {
    let store = InMemoryChatJournalStore()
    let (client, _) = try await loadedClient(store: store)
    let ready = await waitUntil(client) { !$0.commands.isEmpty }
    XCTAssertTrue(ready)
    let live = await client.state
    XCTAssertEqual(live, try ChatTranscriptBuilder.replay(log: ACPFixture.Load.full, journal: store.load()))
  }

  func test_a_snapshot_taken_inside_the_replay_resumes_to_the_same_state() async throws {
    var journal = ChatJournal()
    journal.sessionId = "sess-4"
    journal.loadedSessionId = "sess-4"
    let cut = ACPFixture.Load.responseLine
    var builder = ChatTranscriptBuilder(journal: journal)
    try builder.feed(ACPFixture.Load.log(0..<cut))
    let snapshot = ChatSnapshot(
      identity: 7, offset: ACPFixture.Load.offset(after: cut), journal: journal, state: builder.state)
    XCTAssertTrue(snapshot.isConsistent(with: journal))

    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream, store: InMemoryChatJournalStore(journal), resume: snapshot)
    try await client.start(cwd: "/work/project", loadSessionId: "sess-4")
    XCTAssertEqual(stream.writtenText, "")
    stream.push(ACPFixture.Load.log(cut..<ACPFixture.Load.agentLines.count))
    let ready = await waitUntil(client) { !$0.commands.isEmpty }
    XCTAssertTrue(ready)
    let state = await client.state
    XCTAssertEqual(state, try ChatTranscriptBuilder.replay(log: ACPFixture.Load.full, journal: journal))
  }

  func test_a_redial_before_the_load_answered_asks_for_the_same_conversation_and_a_resume_skips_it() async throws {
    var interrupted = ChatJournal()
    interrupted.loadedSessionId = "sess-4"
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream, store: InMemoryChatJournalStore(interrupted))
    let started = Task { try await client.start(cwd: "/work/project") }
    let sentInit = await eventually { stream.writtenText.contains("\"method\":\"initialize\"") }
    XCTAssertTrue(sentInit)
    stream.push(ACPFixture.Load.log(0..<1))
    let sentLoad = await eventually { stream.writtenText.contains("session/load") }
    XCTAssertTrue(sentLoad)
    XCTAssertTrue(stream.writtenText.contains("\"sessionId\":\"sess-4\""))
    started.cancel()

    var loaded = interrupted
    loaded.sessionId = "sess-4"
    let resumed = ScriptedByteStream()
    let second = ACPClient(stream: resumed, store: InMemoryChatJournalStore(loaded))
    try await second.start(cwd: "/work/project", loadSessionId: "sess-4")
    XCTAssertEqual(resumed.writtenText, "")
  }

  func test_a_refused_load_throws_the_agent_error_and_keeps_asking_for_the_same_id() async throws {
    let store = InMemoryChatJournalStore()
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream, store: store)
    let started = Task { try await client.start(cwd: "/work/project", loadSessionId: "sess-gone") }
    let sentInit = await eventually { stream.writtenText.contains("\"method\":\"initialize\"") }
    XCTAssertTrue(sentInit)
    stream.push(ACPFixture.Load.log(0..<1))
    let sentLoad = await eventually { stream.writtenText.contains("session/load") }
    XCTAssertTrue(sentLoad)
    stream.push(Data("{\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"code\":-32002,\"message\":\"Session not found\"}}\n".utf8))
    do {
      try await started.value
      XCTFail("the refusal should reach the caller")
    } catch {
      XCTAssertEqual(error as? ACPClientError, .agent(code: -32002, message: "Session not found"))
    }
    XCTAssertNil(store.load().sessionId)
    XCTAssertEqual(store.load().loadedSessionId, "sess-gone")
  }

  func test_a_journal_from_before_loads_decodes_without_the_field() throws {
    let data = Data("{\"nextRequestId\":3,\"entries\":[],\"sessionId\":\"sess-1\"}".utf8)
    let journal = try JSONDecoder().decode(ChatJournal.self, from: data)
    XCTAssertEqual(journal.sessionId, "sess-1")
    XCTAssertNil(journal.loadedSessionId)
  }

  private func chunk(_ text: String, id: String?) -> ChatEvent {
    .message(.update(.userMessage(text: text, messageId: id)))
  }

  func test_replayed_user_messages_with_different_ids_stay_separate_rows_and_chunks_of_one_merge() {
    var state = ChatState()
    for event in [chunk("first ", id: "u1"), chunk("part", id: "u1"), chunk("second", id: "u2")] {
      state = ChatReducer.reduce(state, event)
    }
    let texts = state.items.compactMap { item -> String? in
      if case let .user(text, _, _) = item.kind { return text }
      return nil
    }
    XCTAssertEqual(texts, ["first part", "second"])
  }

  func test_the_echo_of_a_queued_prompt_after_a_load_adds_no_second_row() {
    var state = ChatState()
    state = ChatReducer.reduce(state, chunk("old question", id: "u1"))
    state = ChatReducer.reduce(state, .userPrompt(text: "now", atOffset: 10, requestId: .int(3)))
    state = ChatReducer.reduce(state, .userPrompt(text: "queued", atOffset: 10, requestId: .int(4)))
    state = ChatReducer.reduce(state, chunk("queued", id: "u9"))
    let users = state.items.filter { if case .user = $0.kind { return true } else { return false } }
    XCTAssertEqual(users.count, 3)
  }
}
