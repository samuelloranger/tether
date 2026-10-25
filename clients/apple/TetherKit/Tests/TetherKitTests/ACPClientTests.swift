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
}
