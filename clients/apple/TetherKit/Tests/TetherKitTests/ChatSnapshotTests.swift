import XCTest
@testable import TetherKit

final class ChatSnapshotTests: XCTestCase {
  private struct Case {
    var name: String
    var lines: [String]
    var journal: ChatJournal
  }

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

  private static var nesting: [String] {
    [
      update(["sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": ["type": "text", "text": "héllo "]]),
      tool("a", "Task", "pending", name: "Agent"),
      tool("a", "check things", "in_progress", update: true, name: "Agent", input: ["description": "check things"]),
      tool("c1", "Read a", "pending", parent: "a"),
      tool("c1", "Read a", "completed", update: true, parent: "a", text: "body"),
      tool("c2", "Bash b", "in_progress", parent: "a"),
      tool("m", "Main tool", "completed"),
      update(["sessionUpdate": "agent_thought_chunk", "content": ["type": "text", "text": "thinking"]]),
      tool("a", "check things", "completed", update: true, name: "Agent", text: "The report."),
      tool("b", "Task", "pending", name: "Agent"),
      tool("b", "audit", "completed", update: true, name: "Agent", input: ["description": "audit"],
        text: "Async agent launched successfully. (internal)\nagentId: z"),
      tool("d1", "Read d", "in_progress", parent: "b"),
      update(["sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": ["type": "text", "text": "done"]]),
    ]
  }

  private func cases() -> [Case] {
    var controls = ChatJournal()
    controls.sessionId = "sess-2"
    controls.nextRequestId = 3
    let nesting = Self.nesting
    var nested = ChatJournal()
    nested.sessionId = "sess-n"
    nested.entries = [
      .init(kind: .prompt, offset: 0, text: "go"),
      .init(kind: .prompt, offset: Self.offset(nesting, after: 6), text: "again", imageCount: 2),
      .init(kind: .silentRequest, offset: Self.offset(nesting, after: 6), requestId: .int(9)),
    ]
    return [
      Case(name: "turn-write", lines: ACPFixture.agentLines, journal: ACPFixture.journal),
      Case(name: "controls", lines: ACPFixture.Controls.agentLines, journal: controls),
      Case(name: "nesting", lines: nesting, journal: nested),
      Case(
        name: "question-answered", lines: ACPFixture.Elicitation.agentLines,
        journal: ACPFixture.Elicitation.journal(answer: ["question_0": .text("red"), "question_0_custom": .text("a note")])),
      Case(name: "question-turn-end", lines: ACPFixture.Elicitation.agentLines, journal: ACPFixture.Elicitation.journal()),
    ]
  }

  private static func offset(_ lines: [String], after count: Int) -> Int {
    lines.prefix(count).reduce(0) { $0 + $1.utf8.count + 1 }
  }

  private func data(_ lines: ArraySlice<String>) -> Data { Data((lines.joined(separator: "\n") + "\n").utf8) }

  /// What a live client holds at a line boundary: the journal entries it has seen by then.
  private func snapshot(_ test: Case, after count: Int) throws -> (ChatSnapshot, ChatJournal) {
    let cut = Self.offset(test.lines, after: count)
    var seen = test.journal
    seen.entries = test.journal.entries(upTo: cut)
    var builder = ChatTranscriptBuilder(journal: seen)
    try builder.feed(data(test.lines[0..<count]))
    XCTAssertEqual(builder.consumedOffset, cut)
    return (ChatSnapshot(identity: 1_700_000_000, offset: cut, journal: seen, state: builder.state), seen)
  }

  private func chunks(_ bytes: Data, using generator: inout SeededGenerator) -> [Data] {
    var result: [Data] = []
    var index = bytes.startIndex
    while index < bytes.endIndex {
      let size = Int.random(in: 1...200, using: &generator)
      let end = min(bytes.endIndex, index + size)
      result.append(bytes[index..<end])
      index = end
    }
    return result
  }

  func test_state_survives_a_json_round_trip_for_every_fixture() throws {
    for test in cases() {
      let state = try ChatTranscriptBuilder.replay(log: data(test.lines[...]), journal: test.journal)
      let decoded = try JSONDecoder().decode(ChatState.self, from: JSONEncoder().encode(state))
      XCTAssertEqual(decoded, state, test.name)
      XCTAssertTrue(!state.items.isEmpty || !state.configOptions.isEmpty, test.name)
    }
  }

  func test_a_snapshot_at_any_line_boundary_plus_the_rest_of_the_log_equals_a_full_replay() throws {
    var generator = SeededGenerator(seed: 7)
    for test in cases() {
      let full = data(test.lines[...])
      let expected = try ChatTranscriptBuilder.replay(log: full, journal: test.journal)
      for count in 1...test.lines.count {
        let (taken, _) = try snapshot(test, after: count)
        let stored = try JSONDecoder().decode(ChatSnapshot.self, from: JSONEncoder().encode(taken))
        XCTAssertTrue(stored.isConsistent(with: test.journal), "\(test.name) @\(count)")
        var builder = ChatTranscriptBuilder(journal: test.journal, resuming: stored)
        XCTAssertEqual(builder.receivedBytes, stored.offset)
        let rest = full.subdata(in: stored.offset..<full.count)
        for chunk in chunks(rest, using: &generator) { try builder.feed(chunk) }
        builder.finish()
        XCTAssertEqual(builder.state, expected, "\(test.name) cut after line \(count)")
        XCTAssertEqual(builder.receivedBytes, full.count)
      }
    }
  }

  func test_journal_entries_added_after_the_snapshot_are_applied_on_resume() throws {
    var test = cases()[0]
    let answered = ACPFixture.index(containing: "session/request_permission") + 1
    let (taken, seen) = try snapshot(test, after: answered)
    XCTAssertEqual(seen.entries.count, 2)
    test.journal.entries.append(.init(kind: .prompt, offset: taken.offset, text: "later"))
    let full = data(test.lines[...])
    let builder = ChatTranscriptBuilder(journal: test.journal, resuming: taken)
    XCTAssertTrue(taken.isConsistent(with: test.journal))
    XCTAssertTrue(
      builder.state.items.contains { if case .user("later", _, _) = $0.kind { true } else { false } })
    XCTAssertEqual(builder.state.turn, .working)
    var resumed = builder
    try resumed.feed(full.subdata(in: taken.offset..<full.count))
    resumed.finish()
    XCTAssertEqual(resumed.state, try ChatTranscriptBuilder.replay(log: full, journal: test.journal))
  }

  func test_a_snapshot_is_refused_when_the_journal_changed_underneath_it() throws {
    let test = cases()[0]
    let (taken, _) = try snapshot(test, after: test.lines.count)
    XCTAssertTrue(taken.isConsistent(with: test.journal))

    var edited = test.journal
    edited.entries[0].text = "something else"
    XCTAssertFalse(taken.isConsistent(with: edited))

    var removed = test.journal
    removed.entries.removeLast()
    XCTAssertFalse(taken.isConsistent(with: removed))

    var future = taken
    future.version = ChatSnapshot.currentVersion + 1
    XCTAssertFalse(future.isConsistent(with: test.journal))
  }

  func test_the_file_store_round_trips_atomically_and_discards_what_it_cannot_read() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("snap-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let files = ChatLocalFiles(directory: directory)
    let store = files.snapshots("chat-a/b")
    XCTAssertNil(store.load())
    let test = cases()[0]
    let (taken, _) = try snapshot(test, after: 5)
    store.save(taken)
    XCTAssertEqual(store.load(), taken)
    XCTAssertNil(files.snapshots("chat-a").load(), "names never share a file")

    store.save(taken)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 1)

    var future = taken
    future.version = 99
    store.save(future)
    XCTAssertNil(store.load())
    XCTAssertFalse(FileManager.default.fileExists(atPath: files.url("chat-a/b", FileChatSnapshotStore.kind).path))

    files.write(Data("{ not json".utf8), "chat-a/b", FileChatSnapshotStore.kind)
    XCTAssertNil(store.load())

    store.save(taken)
    files.clear("chat-a/b")
    XCTAssertNil(store.load())
  }

  func test_scopes_keep_hosts_apart() {
    let one = ChatLocalFiles(scope: "a:22", root: URL(fileURLWithPath: "/x"))
    let two = ChatLocalFiles(scope: "a_22", root: URL(fileURLWithPath: "/x"))
    XCTAssertNotEqual(one.directory, two.directory)
  }

  func test_resume_is_only_trusted_when_the_host_agrees() throws {
    let test = cases()[0]
    let (taken, _) = try snapshot(test, after: test.lines.count)
    func summary(created: Int = 1_700_000_000, bytes: Int, running: Bool = true) -> ACPChatSummary {
      ACPChatSummary(
        name: "c", isRunning: running, logBytes: bytes, cwd: "/x",
        created: Date(timeIntervalSince1970: TimeInterval(created)), spawn: "")
    }
    XCTAssertNotNil(ChatResume.usable(taken, journal: test.journal, summary: summary(bytes: taken.offset)))
    XCTAssertNotNil(ChatResume.usable(taken, journal: test.journal, summary: summary(bytes: taken.offset + 50)))
    XCTAssertNil(ChatResume.usable(taken, journal: test.journal, summary: summary(bytes: taken.offset - 1)))
    XCTAssertNil(ChatResume.usable(taken, journal: test.journal, summary: summary(created: 5, bytes: taken.offset)))
    XCTAssertNil(ChatResume.usable(taken, journal: test.journal, summary: nil))
    XCTAssertNil(ChatResume.usable(nil, journal: test.journal, summary: summary(bytes: 9)))
  }

  func test_after_a_loss_the_host_decides_between_replay_ended_and_dropped() {
    func summary(created: Int = 100, bytes: Int, running: Bool = true) -> ACPChatSummary {
      ACPChatSummary(
        name: "c", isRunning: running, logBytes: bytes, cwd: "/x",
        created: Date(timeIntervalSince1970: TimeInterval(created)), spawn: "")
    }
    let attempt = ChatResume.Attempt(offset: 500, identity: 100)
    func outcome(
      _ attempt: ChatResume.Attempt?, received: Int, failed: Bool = false, _ summary: ACPChatSummary?
    ) -> ChatResume.AfterLoss {
      ChatResume.afterLoss(attempt: attempt, receivedBytes: received, failedDecoding: failed, summary: summary)
    }
    XCTAssertEqual(outcome(attempt, received: 500, summary(bytes: 200)), .replayFromZero)
    XCTAssertEqual(outcome(attempt, received: 500, summary(created: 7, bytes: 900)), .replayFromZero)
    XCTAssertEqual(outcome(attempt, received: 900, failed: true, summary(bytes: 900)), .replayFromZero)
    XCTAssertEqual(outcome(attempt, received: 500, summary(bytes: 500, running: false)), .ended)
    XCTAssertEqual(outcome(attempt, received: 700, summary(bytes: 700, running: false)), .ended)
    XCTAssertEqual(outcome(attempt, received: 500, summary(bytes: 800)), .lost)
    XCTAssertEqual(outcome(attempt, received: 500, nil), .lost)
    XCTAssertEqual(outcome(nil, received: 0, summary(bytes: 0)), .lost)
    XCTAssertEqual(outcome(nil, received: 0, summary(bytes: 10, running: false)), .ended)
  }
}
