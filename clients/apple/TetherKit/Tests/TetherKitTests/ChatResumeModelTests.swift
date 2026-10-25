import XCTest
@testable import TetherKit

@MainActor
final class ChatResumeModelTests: XCTestCase {
  private static let identity = 1_700_000_000

  private final class Dialer: @unchecked Sendable {
    var streams: [ScriptedByteStream]
    private(set) var offsets: [Int] = []
    init(_ streams: [ScriptedByteStream]) { self.streams = streams }
    func dial(from: Int) throws -> any TerminalByteStream {
      offsets.append(from)
      guard !streams.isEmpty else { throw SSHConnectError.transport("no route") }
      return streams.removeFirst()
    }
  }

  nonisolated private static func summary(bytes: Int, created: Int = identity, running: Bool = true) -> ACPChatSummary {
    ACPChatSummary(
      name: "chat-t", isRunning: running, logBytes: bytes, cwd: "/work/project",
      created: Date(timeIntervalSince1970: TimeInterval(created)), spawn: "")
  }

  private func snapshot(afterLines count: Int) throws -> ChatSnapshot {
    let cut = ACPFixture.offset(after: count)
    var seen = ACPFixture.journal
    seen.entries = seen.entries(upTo: cut)
    var builder = ChatTranscriptBuilder(journal: seen)
    try builder.feed(ACPFixture.log(count))
    return ChatSnapshot(identity: Self.identity, offset: cut, journal: seen, state: builder.state)
  }

  private func model(
    _ dialer: Dialer, snapshots: InMemoryChatSnapshotStore, summaries: @escaping @Sendable () -> ACPChatSummary?
  ) -> ChatSessionModel {
    ChatSessionModel(
      chatName: "chat-t", cwd: "/work/project", readOnly: false,
      store: InMemoryChatJournalStore(ACPFixture.journal), snapshots: snapshots,
      inspect: { summaries() }
    ) { _, from in try dialer.dial(from: from) }
  }

  private func settled(_ model: ChatSessionModel) async -> Bool {
    await eventually(timeout: 4) { model.link.phase == .live }
  }

  nonisolated private static var fullLog: Data { ACPFixture.log() }
  private var fullLog: Data { Self.fullLog }

  func test_a_matching_snapshot_attaches_from_its_offset_and_shows_the_saved_transcript_at_once() async throws {
    let taken = try snapshot(afterLines: ACPFixture.agentLines.count - 4)
    let stream = ScriptedByteStream()
    let dialer = Dialer([stream])
    let store = InMemoryChatSnapshotStore(taken)
    let model = model(dialer, snapshots: store) { Self.summary(bytes: Self.fullLog.count) }
    Task { await model.connect() }
    let attached = await eventually { dialer.offsets.count == 1 }
    XCTAssertTrue(attached)
    XCTAssertEqual(dialer.offsets, [taken.offset])
    let shown = await eventually { model.state.items == taken.state.items }
    XCTAssertTrue(shown, "the saved transcript is on screen before the host sends anything")
    stream.push(fullLog.subdata(in: taken.offset..<fullLog.count))
    let live = await settled(model)
    XCTAssertTrue(live)
    XCTAssertEqual(model.state.title, "Hello.txt to out.txt")
    let replayed = try ChatTranscriptBuilder.replay(log: fullLog, journal: ACPFixture.journal)
    XCTAssertEqual(model.state.items, replayed.items)
    model.leave()
  }

  func test_a_snapshot_of_another_host_session_is_discarded_for_a_clean_replay() async throws {
    let taken = try snapshot(afterLines: 6)
    let stream = ScriptedByteStream()
    let dialer = Dialer([stream])
    let store = InMemoryChatSnapshotStore(taken)
    let model = model(dialer, snapshots: store) { Self.summary(bytes: Self.fullLog.count, created: 5) }
    Task { await model.connect() }
    stream.push(fullLog)
    let live = await settled(model)
    XCTAssertTrue(live)
    XCTAssertEqual(dialer.offsets, [0])
    XCTAssertNil(store.load().flatMap { $0.identity == Self.identity ? $0 : nil })
    model.leave()
  }

  func test_without_the_host_listing_nothing_is_trusted_and_the_snapshot_is_kept() async throws {
    let taken = try snapshot(afterLines: 6)
    let stream = ScriptedByteStream()
    let dialer = Dialer([stream])
    let store = InMemoryChatSnapshotStore(taken)
    let model = model(dialer, snapshots: store) { nil }
    Task { await model.connect() }
    stream.push(fullLog)
    let live = await settled(model)
    XCTAssertTrue(live)
    XCTAssertEqual(dialer.offsets, [0])
    XCTAssertNotNil(store.load())
    model.leave()
  }

  func test_a_resume_the_host_cannot_serve_falls_back_to_a_replay_from_zero() async throws {
    let taken = try snapshot(afterLines: ACPFixture.agentLines.count - 2)
    let first = ScriptedByteStream()
    let second = ScriptedByteStream()
    let dialer = Dialer([first, second])
    let store = InMemoryChatSnapshotStore(taken)
    let calls = LockedBox(0)
    // Passes the pre-dial check, then the host reports a shorter log, as when --from ran past it.
    let model = model(dialer, snapshots: store) {
      let call = calls.update { $0 += 1; return $0 }
      return Self.summary(bytes: call == 1 ? Self.fullLog.count : taken.offset - 10)
    }
    Task { await model.connect() }
    let dialed = await eventually { dialer.offsets.count == 1 }
    XCTAssertTrue(dialed)
    await first.close()
    let redialed = await eventually(timeout: 4) { dialer.offsets.count == 2 }
    XCTAssertTrue(redialed)
    XCTAssertEqual(dialer.offsets, [taken.offset, 0])
    XCTAssertNil(store.load().flatMap { $0.offset == taken.offset ? $0 : nil }, "the stale snapshot is dropped")
    second.push(fullLog)
    let live = await settled(model)
    XCTAssertTrue(live)
    let replayed = try ChatTranscriptBuilder.replay(log: fullLog, journal: ACPFixture.journal)
    XCTAssertEqual(model.state.items, replayed.items)
    model.leave()
  }

  func test_leaving_saves_a_snapshot_the_next_open_resumes_from() async throws {
    let stream = ScriptedByteStream()
    let store = InMemoryChatSnapshotStore()
    let dialer = Dialer([stream])
    let model = model(dialer, snapshots: store) { Self.summary(bytes: Self.fullLog.count) }
    Task { await model.connect() }
    stream.push(fullLog)
    let live = await settled(model)
    XCTAssertTrue(live)
    let learned = await eventually { store.saveCount > 0 }
    XCTAssertTrue(learned, "the identity arrives from the host listing and snapshots start")
    model.leave()
    let saved = await eventually { store.load()?.offset == self.fullLog.count }
    XCTAssertTrue(saved)

    let next = Dialer([ScriptedByteStream()])
    let reopened = self.model(next, snapshots: store) { Self.summary(bytes: Self.fullLog.count) }
    Task { await reopened.connect() }
    let attached = await eventually { next.offsets.count == 1 }
    XCTAssertTrue(attached)
    XCTAssertEqual(next.offsets, [fullLog.count])
    reopened.leave()
  }
}
