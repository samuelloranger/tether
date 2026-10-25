import XCTest
@testable import TetherKit

final class ACPClientTests: XCTestCase {
  private func push(_ stream: ScriptedByteStream, _ range: Range<Int>) {
    let lines = ACPFixture.agentLines[range]
    stream.push(Data((lines.joined(separator: "\n") + "\n").utf8))
  }

  private func waitUntil(_ client: ACPClient, _ predicate: @escaping (ChatState) -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(3)
    while Date() < end {
      if predicate(await client.state) { return true }
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return false
  }

  private func waitForBytes(_ client: ACPClient, _ count: Int) async -> Bool {
    let end = Date().addingTimeInterval(3)
    while Date() < end {
      if await client.receivedBytes >= count { return true }
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return false
  }

  private func writtenObjects(_ stream: ScriptedByteStream) -> [NSDictionary] {
    stream.writtenText.split(separator: "\n").compactMap {
      (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? NSDictionary
    }
  }

  func test_handshake_prompt_permission_answer_and_loss() async throws {
    let stream = ScriptedByteStream()
    let store = InMemoryChatJournalStore()
    let client = ACPClient(stream: stream, store: store)
    await client.startReading()

    let initialize = Task { try await client.initialize() }
    let sentInitialize = await eventually { stream.writtenText.contains("\"method\":\"initialize\"") }
    XCTAssertTrue(sentInitialize)
    push(stream, 0..<1)
    let result = try await initialize.value
    XCTAssertEqual(result.loadSession, true)

    let session = Task { try await client.newSession(cwd: "/work/project") }
    let sentSession = await eventually { stream.writtenText.contains("session/new") }
    XCTAssertTrue(sentSession)
    push(stream, 1..<2)
    let sessionId = try await session.value
    XCTAssertEqual(sessionId, "sess-1")

    try await client.prompt(text: ACPFixture.promptText)
    let prompts = writtenObjects(stream).filter { $0["method"] as? String == "session/prompt" }
    XCTAssertEqual(prompts.count, 1)
    XCTAssertEqual(prompts[0]["id"] as? Int, 3)
    XCTAssertEqual(
      (prompts[0]["params"] as? NSDictionary)?["prompt"] as? NSArray,
      [["type": "text", "text": ACPFixture.promptText]] as NSArray)
    let working = await client.state.turn
    XCTAssertEqual(working, .working)

    let permissionLine = ACPFixture.index(containing: "session/request_permission")
    push(stream, 2..<(permissionLine + 1))
    let sawPermission = await waitUntil(client) { !$0.pendingPermissions.isEmpty }
    XCTAssertTrue(sawPermission)

    try await client.answerPermission(requestId: .int(0), optionId: "allow-once")
    let response = writtenObjects(stream).first { $0["method"] == nil && $0["id"] as? Int == 0 }
    XCTAssertEqual(
      response,
      ["jsonrpc": "2.0", "id": 0, "result": ["outcome": ["outcome": "selected", "optionId": "allow-once"]]] as NSDictionary)
    // Answering twice does not write twice.
    try await client.answerPermission(requestId: .int(0), optionId: "reject")
    XCTAssertEqual(writtenObjects(stream).filter { $0["method"] == nil && $0["id"] as? Int == 0 }.count, 1)

    push(stream, (permissionLine + 1)..<ACPFixture.agentLines.count)
    let idle = await waitUntil(client) { $0.turn == .idle && $0.lastStopReason == "end_turn" }
    XCTAssertTrue(idle)

    let live = await client.state
    let journal = store.load()
    XCTAssertEqual(live.modelId, "claude-sonnet-5-5")
    XCTAssertEqual(live.cost?.currency, "USD")
    XCTAssertEqual(journal.sessionId, "sess-1")
    XCTAssertEqual(journal.entries, ACPFixture.journal.entries)
    XCTAssertEqual(live, try ChatTranscriptBuilder.replay(log: ACPFixture.log(), journal: journal))

    await stream.close()
    let lost = await waitUntil(client) { $0.connection == .lost }
    XCTAssertTrue(lost)
  }

  func test_resume_replays_without_a_handshake_and_does_not_resurface_the_answered_permission() async throws {
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream, store: InMemoryChatJournalStore(ACPFixture.journal))
    try await client.start(cwd: "/work/project")
    XCTAssertEqual(stream.writtenText, "")
    stream.push(ACPFixture.log())
    let done = await waitUntil(client) { $0.turn == .idle && $0.lastStopReason == "end_turn" }
    XCTAssertTrue(done)
    let state = await client.state
    XCTAssertTrue(state.pendingPermissions.isEmpty)
    XCTAssertEqual(state, try ChatTranscriptBuilder.replay(log: ACPFixture.log(), journal: ACPFixture.journal))
    XCTAssertEqual(stream.writtenText, "")

    try await client.prompt(text: "again")
    let prompt = writtenObjects(stream).first { $0["method"] as? String == "session/prompt" }
    XCTAssertEqual(prompt?["id"] as? Int, 4)
  }

  func test_a_dropped_stream_fails_waiters_and_surfaces_connection_lost() async throws {
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream)
    await client.startReading()
    let initialize = Task { try await client.initialize() }
    _ = await eventually { stream.writtenText.contains("initialize") }
    await stream.close()
    do {
      _ = try await initialize.value
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? ACPClientError, .connectionLost)
    }
    let state = await client.state
    XCTAssertEqual(state.connection, .lost)
  }

  func test_a_runaway_line_surfaces_an_error_instead_of_growing() async throws {
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream)
    await client.startReading()
    stream.push(Data(count: 17 * 1024 * 1024))
    let failed = await waitUntil(client) { $0.connection == .lost }
    XCTAssertTrue(failed)
    let state = await client.state
    guard case .error = state.items.last?.kind else { return XCTFail("\(state.items)") }
  }

  private struct FailingWriteStream: TerminalByteStream {
    func read() async throws -> Data? { try await Task.sleep(nanoseconds: 60_000_000_000); return nil }
    func write(_ bytes: Data) async throws { throw ACPClientError.connectionLost }
    func close() async {}
  }

  private func controlsJournal() -> ChatJournal {
    var journal = ChatJournal()
    journal.sessionId = "sess-2"
    journal.nextRequestId = 3
    return journal
  }

  func test_set_config_option_waits_for_the_agent_and_live_state_equals_replay() async throws {
    let stream = ScriptedByteStream()
    let store = InMemoryChatJournalStore(controlsJournal())
    let client = ACPClient(stream: stream, store: store)
    await client.startReading()
    let extra = [
      "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"available_commands_update\",\"availableCommands\":[{\"name\":\"context\",\"description\":\"d\",\"input\":null}]}}}"
    ]
    let change = Task { try await client.setConfigOption(id: "model", value: "haiku") }
    let sent = await eventually { stream.writtenText.contains("session/set_config_option") }
    XCTAssertTrue(sent)
    let request = writtenObjects(stream).first { $0["method"] as? String == "session/set_config_option" }
    XCTAssertEqual(
      request?["params"] as? NSDictionary, ["sessionId": "sess-2", "configId": "model", "value": "haiku"] as NSDictionary)
    XCTAssertEqual(request?["id"] as? Int, 3)
    let beforeConfirm = await client.state
    XCTAssertTrue(beforeConfirm.configOptions.isEmpty)

    let lines = ACPFixture.Controls.agentLines
    stream.push(Data((lines[2..<4].joined(separator: "\n") + "\n").utf8))
    try await change.value
    let confirmed = await client.state
    XCTAssertEqual(confirmed.option(id: "model")?.currentValue, "haiku")

    stream.push(Data(((Array(lines[4..<lines.count]) + extra).joined(separator: "\n") + "\n").utf8))
    let done = await waitUntil(client) { !$0.commands.isEmpty && $0.modeId == "default" }
    XCTAssertTrue(done)
    let live = await client.state
    let log = Data(((Array(lines[2..<lines.count]) + extra).joined(separator: "\n") + "\n").utf8)
    XCTAssertEqual(live, try ChatTranscriptBuilder.replay(log: log, journal: store.load()))
    XCTAssertEqual(live.currentChoice(of: "model"), "Haiku 5.5")
  }

  func test_a_refused_option_change_throws_the_agent_error_without_touching_the_transcript() async throws {
    let stream = ScriptedByteStream()
    let store = InMemoryChatJournalStore(controlsJournal())
    let client = ACPClient(stream: stream, store: store)
    await client.startReading()
    let change = Task { try await client.setConfigOption(id: "model", value: "nope") }
    _ = await eventually { stream.writtenText.contains("session/set_config_option") }
    let error = "{\"jsonrpc\":\"2.0\",\"id\":3,\"error\":{\"code\":-32602,\"message\":\"bad value\"}}"
    stream.push(Data((error + "\n").utf8))
    do {
      try await change.value
      XCTFail("expected a failure")
    } catch {
      XCTAssertEqual(error as? ACPClientError, .agent(code: -32602, message: "bad value"))
    }
    let live = await client.state
    XCTAssertTrue(live.items.isEmpty)
    let replayed = try ChatTranscriptBuilder.replay(log: Data((error + "\n").utf8), journal: store.load())
    XCTAssertEqual(live, replayed, "a replay must not surface the refusal either")
  }

  func test_set_config_option_fails_without_a_session_or_on_a_dead_connection() async throws {
    let none = ACPClient(stream: ScriptedByteStream())
    do {
      try await none.setConfigOption(id: "mode", value: "plan")
      XCTFail("expected noSession")
    } catch {
      XCTAssertEqual(error as? ACPClientError, .noSession)
    }
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream, store: InMemoryChatJournalStore(controlsJournal()))
    await client.startReading()
    await stream.close()
    _ = await waitUntil(client) { $0.connection == .lost }
    do {
      try await client.setConfigOption(id: "mode", value: "plan")
      XCTFail("expected connectionLost")
    } catch {
      XCTAssertEqual(error as? ACPClientError, .connectionLost)
    }
  }

  func test_an_image_prompt_sends_images_first_then_text_and_journals_the_count() async throws {
    let stream = ScriptedByteStream()
    let store = InMemoryChatJournalStore(controlsJournal())
    let client = ACPClient(stream: stream, store: store)
    await client.startReading()
    let images = [ChatImageAttachment(mimeType: "image/png", data: "AAAA"), ChatImageAttachment(mimeType: "image/jpeg", data: "BBBB")]
    try await client.prompt(text: "what is this", images: images)
    let prompt = writtenObjects(stream).first { $0["method"] as? String == "session/prompt" }
    XCTAssertEqual(
      (prompt?["params"] as? NSDictionary)?["prompt"] as? NSArray,
      [
        ["type": "image", "mimeType": "image/png", "data": "AAAA"],
        ["type": "image", "mimeType": "image/jpeg", "data": "BBBB"],
        ["type": "text", "text": "what is this"],
      ] as NSArray)
    XCTAssertEqual(store.load().entries.map(\.imageCount), [2])
    let state = await client.state
    XCTAssertEqual(state.items.map(\.kind).count, 1)
    guard case let .user(_, count, _)? = state.items.first?.kind else { return XCTFail() }
    XCTAssertEqual(count, 2)

    try await client.prompt(text: "", images: [images[0]])
    let second = writtenObjects(stream).filter { $0["method"] as? String == "session/prompt" }.last
    XCTAssertEqual(
      (second?["params"] as? NSDictionary)?["prompt"] as? NSArray,
      [["type": "image", "mimeType": "image/png", "data": "AAAA"]] as NSArray)
  }

  func test_an_image_prompt_that_cannot_be_written_is_removed_again() async throws {
    let store = InMemoryChatJournalStore(controlsJournal())
    let client = ACPClient(stream: FailingWriteStream(), store: store)
    let image = ChatImageAttachment(mimeType: "image/png", data: "AAAA")
    do {
      try await client.prompt(text: "x", images: [image])
      XCTFail("expected a failure")
    } catch {
      XCTAssertEqual(error as? ACPClientError, .connectionLost)
    }
    let state = await client.state
    XCTAssertTrue(state.items.isEmpty)
    XCTAssertEqual(state.turn, .idle)
    XCTAssertTrue(store.load().entries.isEmpty)
    await client.stop()
  }

  // MARK: Snapshots

  private func turnWriteJournal() -> ChatJournal { ACPFixture.journal }

  func test_a_client_snapshots_at_turn_end_and_a_resumed_one_matches_the_live_state() async throws {
    let live = ScriptedByteStream()
    let snapshots = InMemoryChatSnapshotStore()
    let first = ACPClient(
      stream: live, store: InMemoryChatJournalStore(turnWriteJournal()), snapshots: snapshots,
      snapshotInterval: .seconds(3600))
    await first.setSnapshotIdentity(42)
    await first.startReading()
    let cut = ACPFixture.agentLines.count - 3
    live.push(ACPFixture.log(cut))
    let sawCut = await waitForBytes(first, ACPFixture.offset(after: cut))
    XCTAssertTrue(sawCut)
    await first.stop()
    let saved = try XCTUnwrap(snapshots.load())
    XCTAssertEqual(saved.offset, ACPFixture.offset(after: cut))
    XCTAssertEqual(saved.identity, 42)
    XCTAssertTrue(saved.isConsistent(with: ACPFixture.journal))

    let resumed = ScriptedByteStream()
    let second = ACPClient(
      stream: resumed, store: InMemoryChatJournalStore(turnWriteJournal()), resume: saved)
    try await second.start(cwd: "/work/project")
    let resumedBytes = ACPFixture.log().subdata(in: saved.offset..<ACPFixture.log().count)
    resumed.push(resumedBytes)
    let done = await waitUntil(second) { $0.turn == .idle && $0.lastStopReason == "end_turn" }
    XCTAssertTrue(done)
    let resumedState = await second.state
    XCTAssertEqual(
      resumedState, try ChatTranscriptBuilder.replay(log: ACPFixture.log(), journal: ACPFixture.journal))
    XCTAssertEqual(resumed.writtenText, "")
  }

  func test_snapshots_are_throttled_while_streaming_but_a_turn_end_writes_one() async throws {
    let stream = ScriptedByteStream()
    let snapshots = InMemoryChatSnapshotStore()
    let client = ACPClient(
      stream: stream, store: InMemoryChatJournalStore(turnWriteJournal()), snapshots: snapshots,
      snapshotInterval: .seconds(3600))
    await client.setSnapshotIdentity(1)
    await client.startReading()
    let lines = ACPFixture.agentLines
    for line in lines { stream.push(Data((line + "\n").utf8)) }
    let done = await waitUntil(client) { $0.turn == .idle && $0.lastStopReason == "end_turn" }
    XCTAssertTrue(done)
    // The first line writes (nothing saved yet) and the end of the turn writes; the hour-long
    // interval stops everything in between.
    let settled = await eventually { snapshots.saveCount >= 2 }
    XCTAssertTrue(settled)
    XCTAssertLessThanOrEqual(snapshots.saveCount, 3)
    XCTAssertEqual(snapshots.load()?.state.turn, .idle)
  }

  func test_no_snapshot_is_written_before_the_identity_is_known_or_after_the_connection_dropped() async throws {
    let stream = ScriptedByteStream()
    let snapshots = InMemoryChatSnapshotStore()
    let client = ACPClient(
      stream: stream, store: InMemoryChatJournalStore(turnWriteJournal()), snapshots: snapshots,
      snapshotInterval: .zero)
    await client.startReading()
    stream.push(ACPFixture.log(4))
    let got = await waitForBytes(client, ACPFixture.offset(after: 4))
    XCTAssertTrue(got)
    XCTAssertEqual(snapshots.saveCount, 0)
    await client.setSnapshotIdentity(9)
    await client.saveSnapshot()
    XCTAssertEqual(snapshots.saveCount, 1)

    await stream.close()
    let lost = await waitUntil(client) { $0.connection == .lost }
    XCTAssertTrue(lost)
    XCTAssertEqual(snapshots.load()?.state.connection, .live)
    XCTAssertEqual(snapshots.load()?.offset, ACPFixture.offset(after: 4))
    let before = snapshots.saveCount
    await client.saveSnapshot()
    XCTAssertEqual(snapshots.saveCount, before, "a lost state holds events the log does not")
  }

  func test_undecodable_output_is_reported_so_a_resume_can_fall_back_to_a_replay() async throws {
    let stream = ScriptedByteStream()
    let snapshots = InMemoryChatSnapshotStore()
    let client = ACPClient(stream: stream, snapshots: snapshots, snapshotInterval: .zero)
    await client.setSnapshotIdentity(1)
    await client.startReading()
    stream.push(Data(repeating: 0x61, count: ACPLineSplitter.defaultMaxLineBytes + 10))
    let lost = await waitUntil(client) { $0.connection == .lost }
    XCTAssertTrue(lost)
    let failed = await client.failedDecoding
    XCTAssertTrue(failed)
    XCTAssertEqual(snapshots.saveCount, 0)
  }

  // MARK: Failed writes

  private var unansweredJournal: ChatJournal {
    var journal = ACPFixture.journal
    journal.entries.removeLast()
    return journal
  }

  func test_a_permission_answer_that_cannot_be_written_is_taken_back_and_can_be_retried() async throws {
    let inner = ScriptedByteStream()
    let stream = SwitchableWriteStream(inner)
    let store = InMemoryChatJournalStore(unansweredJournal)
    let client = ACPClient(stream: stream, store: store)
    await client.startReading()
    inner.push(ACPFixture.log(ACPFixture.index(containing: "session/request_permission") + 1))
    let pending = await waitUntil(client) { !$0.pendingPermissions.isEmpty }
    XCTAssertTrue(pending)

    do {
      try await client.answerPermission(requestId: .int(0), optionId: "allow-once")
      XCTFail("the write was refused")
    } catch {}
    let after = await client.state
    XCTAssertEqual(after.pendingPermissions.map(\.requestId), [.int(0)], "the card stays pending")
    XCTAssertFalse(store.load().entries.contains { $0.kind == .answer }, "nothing journaled as answered")

    stream.failing = false
    try await client.answerPermission(requestId: .int(0), optionId: "allow-once")
    let answered = await client.state
    XCTAssertTrue(answered.pendingPermissions.isEmpty)
    XCTAssertEqual(store.load().entries.filter { $0.kind == .answer }.count, 1)
    XCTAssertTrue(inner.writtenText.contains("allow-once"))
  }

  func test_a_failed_cancel_leaves_the_pending_permission_cards() async throws {
    let inner = ScriptedByteStream()
    let stream = SwitchableWriteStream(inner)
    let store = InMemoryChatJournalStore(unansweredJournal)
    let client = ACPClient(stream: stream, store: store)
    await client.startReading()
    inner.push(ACPFixture.log(ACPFixture.index(containing: "session/request_permission") + 1))
    let pending = await waitUntil(client) { !$0.pendingPermissions.isEmpty }
    XCTAssertTrue(pending)
    do {
      try await client.cancel()
      XCTFail("the write was refused")
    } catch {}
    let after = await client.state
    XCTAssertEqual(after.pendingPermissions.count, 1)
    XCTAssertFalse(store.load().entries.contains { $0.kind == .answer })
  }

  func test_a_host_answer_that_lands_during_a_failed_write_is_not_undone() {
    var state = ChatState()
    state = ChatReducer.reduce(
      state,
      .message(.permissionRequest(
        id: .int(0),
        request: ACPPermissionRequest(
          tool: ACPToolFields(id: "t"), options: [ACPPermissionOption(optionId: "a", name: "A", kind: "allow_once")]))))
    state = ChatReducer.reduce(state, .permissionAnswered(requestId: .int(0), optionId: "a"))
    state = ChatReducer.reduce(state, .permissionAnswerUndelivered(requestId: .int(0), optionId: "other"))
    XCTAssertTrue(state.pendingPermissions.isEmpty)
    state = ChatReducer.reduce(state, .permissionAnswerUndelivered(requestId: .int(0), optionId: "a"))
    XCTAssertEqual(state.pendingPermissions.count, 1)
  }
}
