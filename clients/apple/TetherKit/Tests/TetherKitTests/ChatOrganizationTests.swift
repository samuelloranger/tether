import XCTest
@testable import TetherKit

final class ChatOrganizationTests: XCTestCase {
  func test_branch_excludes_selected_prompt_later_messages_hidden_thoughts_and_tools() throws {
    let items: [ChatItem] = [
      .init(id: 1, kind: .user(text: "Find the helper", offset: 0)),
      .init(id: 2, kind: .thought(text: "private reasoning")),
      .init(id: 3, kind: .assistant(text: "It is in fetch.ts", messageId: nil)),
      .init(id: 4, kind: .user(text: "Add retries", offset: 1)),
      .init(id: 5, kind: .assistant(text: "Later answer", messageId: nil)),
    ]
    let point = try XCTUnwrap(ChatBranching.point(items: items, at: 4))
    XCTAssertEqual(point.prompt, "Add retries")
    XCTAssertTrue(point.earlier.contains("Find the helper"))
    XCTAssertTrue(point.earlier.contains("It is in fetch.ts"))
    XCTAssertFalse(point.earlier.contains("Add retries"))
    XCTAssertFalse(point.earlier.contains("Later answer"))
    XCTAssertFalse(point.earlier.contains("private reasoning"))
    XCTAssertNil(ChatBranching.point(items: items, at: 4, queued: [4]))
    XCTAssertEqual(items.count, 5, "The parent is not rewritten")
  }

  func test_other_devices_hide_marked_context_but_keep_normal_text() {
    let input = #"{"jsonrpc":"2.0","method":"_tether/client","params":{"client":"desktop","message":{"jsonrpc":"2.0","id":"desktop-3","method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"text","text":"Earlier private context","_meta":{"tether/branchContext":true}},{"type":"text","text":"Edited prompt"}]}}}}"#
    XCTAssertEqual(ACPDecoder.decode(Data(input.utf8)), .clientEcho(client: "desktop",
      line: .prompt(id: .string("desktop-3"), text: "Edited prompt", imageCount: 0, sessionId: "s1")))
  }

  func test_adapter_replayed_user_messages_hide_only_marked_branch_context() throws {
    let seed = #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Earlier context","_meta":{"tether/branchContext":true}}}}}"#
    let visible = #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Edited prompt"}}}}"#
    var builder = ChatTranscriptBuilder(journal: ChatJournal())
    try builder.feed(Data((seed + "\n" + visible + "\n").utf8))
    let users = builder.state.items.compactMap { item -> String? in
      if case let .user(text, _, _, _) = item.kind { return text }; return nil
    }
    XCTAssertEqual(users, ["Edited prompt"])
  }

  func test_image_prompts_cannot_be_branched_without_copying_their_images() {
    let items = [ChatItem(id: 1, kind: .user(text: "Compare these", imageCount: 2, offset: 0))]
    XCTAssertNil(ChatBranching.point(items: items, at: 1))
  }

  func test_branch_refuses_oversized_context_and_earlier_images_without_silently_dropping_them() throws {
    let large = [ChatItem(id: 1, kind: .assistant(text: String(repeating: "x", count: 128 * 1024), messageId: nil)),
      ChatItem(id: 2, kind: .user(text: "Try another way", offset: 0))]
    XCTAssertNotNil(try XCTUnwrap(ChatBranching.point(items: large, at: 2)).failure)
    let images = [ChatItem(id: 1, kind: .user(text: "Screenshot", imageCount: 1, offset: 0)),
      ChatItem(id: 2, kind: .user(text: "Try another way", offset: 1))]
    XCTAssertTrue(try XCTUnwrap(ChatBranching.point(items: images, at: 2)).failure?.contains("images") == true)
  }

  func test_host_metadata_groups_pins_once_and_preserves_archived_attention() throws {
    let listing = ACPChatStatusListing.parse("""
      {"name":"a","state":"running","cwd":"/work/api/sub","projectRoot":"/work/api","customTitle":"My title","pinned":true}
      {"name":"b","state":"running","cwd":"/work/api","projectRoot":"/work/api","archived":true,"turn":"waiting"}
      {"name":"c","state":"ended","cwd":"/work/api/other","projectRoot":"/work/api","parent":{"name":"a","title":"Parent","method":"copy"}}
      """)
    let rows = DrawerChatRows.rows(chats: listing.chats, titles: [:])
    XCTAssertEqual(rows.first { $0.name == "a" }?.title, "My title")
    XCTAssertEqual(ChatOrganization.groups(rows).map(\.path), ["/work/api"])
    XCTAssertEqual(ChatOrganization.groups(rows).first?.rows.map(\.name), ["c"])
    XCTAssertEqual(ChatOrganization.attention(rows).map(\.name), ["b"])
    XCTAssertEqual(rows.first { $0.name == "c" }?.parent?.name, "a")
    XCTAssertEqual(rows.first { $0.name == "c" }?.route(journal: ChatJournal()).parent?.name, "a")
    XCTAssertTrue(rows.first { $0.name == "b" }?.isRunning == true, "Archive does not end an agent")
  }

  func test_quota_missing_is_not_zero_and_stale_reset_times_are_honest() throws {
    let usage = try XCTUnwrap(ChatPlanUsage.parse("""
      {"claude":{"fiveHour":{"usedPercent":0,"resetsAt":2000},"weekly":null,"updatedAt":1000,"stale":true},"codex":{"fiveHour":null,"weekly":null,"error":"unavailable"}}
      """))
    XCTAssertEqual(usage.claude?.fiveHour?.usedPercent, 0)
    XCTAssertNil(usage.claude?.weekly)
    XCTAssertNil(usage.codex?.fiveHour)
    XCTAssertEqual(usage.claude?.freshness(now: Date(timeIntervalSince1970: 2200)), "Updated 20m ago")
    XCTAssertEqual(usage.claude?.fiveHour?.resetLabel(now: Date(timeIntervalSince1970: 2200)), "Reset due")
    XCTAssertNil(ChatPlanUsage.parse("tether: unknown acp command usage"))
    XCTAssertFalse(ChatQuotaWindow(usedPercent: -1, resetsAt: 1000).valid)
    XCTAssertFalse(ChatQuotaWindow(usedPercent: 101, resetsAt: 1000).valid)
  }

  func test_branch_seed_and_unsent_draft_survive_journal_roundtrip_and_old_journals_decode() throws {
    var journal = ChatJournal()
    journal.branch = ChatBranch(parent: .init(name: "parent", title: "Source"), title: "Alternative", earlier: "[]")
    journal.branchSeed = "earlier context"
    journal.branchDraft = "Try another approach"
    XCTAssertEqual(try JSONDecoder().decode(ChatJournal.self, from: JSONEncoder().encode(journal)), journal)
    let legacy = try JSONDecoder().decode(ChatJournal.self, from: Data("{\"nextRequestId\":1,\"entries\":[]}".utf8))
    XCTAssertNil(legacy.branch)
    XCTAssertNil(legacy.branchSeed)
  }
}

extension ChatOrganizationTests {
  func test_branching_a_branch_keeps_the_inherited_context_and_bounds_the_combined_text() throws {
    let inherited = #"[{"role":"user","text":"Grandparent question"},{"role":"assistant","text":"Grandparent answer"}]"#
    let items: [ChatItem] = [
      .init(id: 1, kind: .user(text: "Branch prompt", offset: 0)),
      .init(id: 2, kind: .assistant(text: "Branch answer", messageId: nil)),
      .init(id: 3, kind: .user(text: "Next", offset: 1)),
    ]
    let point = try XCTUnwrap(ChatBranching.point(items: items, at: 3, inherited: inherited))
    let order = ["Grandparent question", "Grandparent answer", "Branch prompt", "Branch answer"].map { point.earlier.range(of: $0)?.lowerBound }
    XCTAssertFalse(order.contains { $0 == nil })
    XCTAssertEqual(order.compactMap { $0 }, order.compactMap { $0 }.sorted())
    XCTAssertNil(point.failure)

    let big = String(repeating: "x", count: 100 * 1024)
    let bigInherited = "[{\"role\":\"user\",\"text\":\"\(big)\"}]"
    let small: [ChatItem] = [
      .init(id: 1, kind: .user(text: big, offset: 0)), .init(id: 2, kind: .user(text: "Next", offset: 1)),
    ]
    XCTAssertNil(try XCTUnwrap(ChatBranching.point(items: small, at: 2)).failure)
    XCTAssertNotNil(try XCTUnwrap(ChatBranching.point(items: small, at: 2, inherited: bigInherited)).failure)
  }

  func test_a_collapsed_project_can_tell_that_a_chat_needs_you() {
    func row(_ name: String, _ state: DrawerChatState) -> DrawerChatRow {
      DrawerChatRow(name: name, title: name, subtitle: "", state: state, cwd: "/w", agentKey: nil)
    }
    XCTAssertTrue(ChatProjectGroup(path: "/w", rows: [row("a", .idle), row("b", .waiting)]).needsYou)
    XCTAssertFalse(ChatProjectGroup(path: "/w", rows: [row("a", .idle)]).needsYou)
  }
}

final class ChatBranchDeliveryTests: XCTestCase {
  func test_seed_and_draft_stay_stored_until_the_write_succeeds() async throws {
    var journal = ChatJournal()
    journal.sessionId = "session"
    journal.branchSeed = "Earlier context"
    journal.branchDraft = "edited prompt"
    journal.branch = .init(parent: .init(name: "parent", title: "Source"), title: "Alternative", earlier: "[]")
    let store = InMemoryChatJournalStore(journal)
    let stream = BranchHeldWriteStream()
    let client = ACPClient(stream: stream, store: store)
    let first = Task { try await client.prompt(text: "edited prompt") }
    for _ in 0..<100 {
      if await stream.isWriting { break }
      try await Task.sleep(nanoseconds: 1_000_000)
    }
    XCTAssertEqual(store.load().branchSeed, "Earlier context")
    XCTAssertEqual(store.load().entries.last?.text, "edited prompt")
    await stream.succeed()
    try await first.value
    XCTAssertNil(store.load().branchSeed)
    XCTAssertNil(store.load().branchDraft)
    await client.stop()
  }

  func test_the_client_owns_draft_persistence_and_ignores_non_branch_chats() async throws {
    var journal = ChatJournal()
    journal.sessionId = "session"
    let plain = InMemoryChatJournalStore(journal)
    let plainClient = ACPClient(stream: ScriptedByteStream(), store: plain)
    await plainClient.saveBranchDraft("typed")
    XCTAssertNil(plain.load().branchDraft)

    journal.branch = .init(parent: .init(name: "parent", title: "Source"), title: "Alternative", earlier: "[]")
    let store = InMemoryChatJournalStore(journal)
    let client = ACPClient(stream: ScriptedByteStream(), store: store)
    await client.saveBranchDraft("first")
    await client.saveBranchDraft("second")
    XCTAssertEqual(store.load().branchDraft, "second")
    await client.stop()
    await plainClient.stop()
  }

  func test_first_send_carries_seed_once_without_polluting_visible_prompt_or_reconnect() async throws {
    var journal = ChatJournal()
    journal.sessionId = "session"
    journal.branchSeed = "Earlier conversation context"
    journal.branchDraft = "edited prompt"
    let store = InMemoryChatJournalStore(journal)
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream, store: store)
    try await client.prompt(text: "edited prompt")
    XCTAssertNil(store.load().branchSeed)
    XCTAssertNil(store.load().branchDraft)
    XCTAssertEqual(store.load().entries.last?.text, "edited prompt")
    XCTAssertTrue(stream.writtenText.contains("Earlier conversation context"))
    let nextStream = ScriptedByteStream()
    let resumed = ACPClient(stream: nextStream, store: store)
    try await resumed.prompt(text: "next prompt")
    XCTAssertFalse(nextStream.writtenText.contains("Earlier conversation context"))
    await client.stop()
    await resumed.stop()
  }

  func test_remote_first_prompt_prevents_reseeding_but_keeps_the_unsent_draft() async throws {
    var journal = ChatJournal()
    journal.sessionId = "session"
    journal.clientId = "ios"
    journal.branchSeed = "Earlier context"
    journal.branchDraft = "My unsent edit"
    let store = InMemoryChatJournalStore(journal)
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream, store: store)
    await client.startReading()
    stream.push(Data((#"{"jsonrpc":"2.0","method":"_tether/client","params":{"client":"desktop","message":{"jsonrpc":"2.0","id":"desktop-3","method":"session/prompt","params":{"sessionId":"session","prompt":[{"type":"text","text":"Remote edited prompt"}]}}}}"# + "\n").utf8))
    for _ in 0..<100 {
      if await client.state.items.contains(where: { if case .user = $0.kind { return true }; return false }) { break }
      try await Task.sleep(nanoseconds: 1_000_000)
    }
    XCTAssertEqual(store.load().branchDraft, "My unsent edit")
    try await client.prompt(text: "My unsent edit")
    XCTAssertFalse(stream.writtenText.contains("Earlier context"))
    XCTAssertNil(store.load().branchSeed)
    await client.stop()
  }

  func test_an_overlapping_send_cannot_take_or_lose_the_first_branch_context() async throws {
    var journal = ChatJournal()
    journal.sessionId = "session"
    journal.branchSeed = "Earlier context"
    journal.branch = .init(parent: .init(name: "parent", title: "Source"), title: "Alternative", earlier: "[]")
    let store = InMemoryChatJournalStore(journal)
    let stream = BranchHeldWriteStream()
    let client = ACPClient(stream: stream, store: store)
    let first = Task { try await client.prompt(text: "first edited prompt") }
    for _ in 0..<100 {
      if await stream.isWriting { break }
      try await Task.sleep(nanoseconds: 1_000_000)
    }
    do { try await client.prompt(text: "queued follow-up"); XCTFail("Must wait for branch context") } catch {}
    await stream.fail()
    do { try await first.value; XCTFail("Expected failed first write") } catch {}
    XCTAssertEqual(store.load().branchSeed, "Earlier context")
    XCTAssertEqual(store.load().branchDraft, "first edited prompt")
    XCTAssertTrue(store.load().entries.isEmpty)
    await client.stop()
  }

  func test_failed_first_write_keeps_context_for_an_explicit_retry() async throws {
    var journal = ChatJournal()
    journal.sessionId = "session"
    journal.branchSeed = "Earlier conversation context"
    journal.branch = .init(parent: .init(name: "parent", title: "Source"), title: "Alternative", earlier: "[]")
    let store = InMemoryChatJournalStore(journal)
    let client = ACPClient(stream: BranchFailingStream(), store: store)
    do { try await client.prompt(text: "edited prompt"); XCTFail("Expected write failure") } catch {}
    XCTAssertEqual(store.load().branchSeed, "Earlier conversation context")
    XCTAssertEqual(store.load().branchDraft, "edited prompt")
    XCTAssertTrue(store.load().entries.isEmpty)
    await client.stop()
  }
}

private struct BranchFailingStream: TerminalByteStream {
  func read() async throws -> Data? { nil }
  func write(_ data: Data) async throws { throw ACPClientError.connectionLost }
  func close() async {}
}

private actor BranchHeldWriteStream: TerminalByteStream {
  private var pending: CheckedContinuation<Void, Error>?
  var isWriting: Bool { pending != nil }
  func read() async throws -> Data? { nil }
  func write(_ data: Data) async throws {
    try await withCheckedThrowingContinuation { pending = $0 }
  }
  func succeed() { pending?.resume(); pending = nil }
  func fail() { pending?.resume(throwing: ACPClientError.connectionLost); pending = nil }
  func close() async { fail() }
}
