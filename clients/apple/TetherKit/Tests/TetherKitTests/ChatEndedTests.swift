import XCTest
@testable import TetherKit

@MainActor
final class ChatEndedTests: XCTestCase {
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

  nonisolated private static func row(running: Bool, bytes: Int = ACPFixture.log().count) -> ACPChatSummary {
    ACPChatSummary(
      name: "chat-t", isRunning: running, logBytes: bytes, cwd: "/work/project",
      created: Date(timeIntervalSince1970: 1_700_000_000), spawn: "")
  }

  private func model(
    _ dialer: Dialer, snapshots: InMemoryChatSnapshotStore? = nil, host: @escaping @Sendable () -> ACPChatSummary?
  ) -> ChatSessionModel {
    ChatSessionModel(
      chatName: "chat-t", cwd: "/work/project", readOnly: false,
      store: InMemoryChatJournalStore(ACPFixture.journal), snapshots: snapshots, inspect: { host() }
    ) { _, from in try dialer.dial(from: from) }
  }

  func test_a_stream_that_drains_and_closes_on_an_ended_chat_shows_ended_and_never_redials() async throws {
    let stream = ScriptedByteStream()
    let dialer = Dialer([stream, ScriptedByteStream()])
    let model = model(dialer) { Self.row(running: false) }
    Task { await model.connect() }
    stream.push(ACPFixture.log())
    await stream.close()
    let ended = await eventually(timeout: 4) { model.link.phase == .ended }
    XCTAssertTrue(ended)
    XCTAssertTrue(model.hasEnded)
    XCTAssertFalse(model.canSend)
    XCTAssertFalse(model.canInteract)
    XCTAssertEqual(model.state.title, "Hello.txt to out.txt", "the transcript stays readable")
    XCTAssertFalse(model.state.items.isEmpty)

    model.sceneEnteredBackground()
    model.sceneBecameActive()
    model.reconnect()
    try await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertEqual(dialer.offsets.count, 1, "no redial loop")
    XCTAssertEqual(model.link.phase, .ended)
    model.leave()
  }

  func test_a_dropped_connection_on_a_running_chat_stays_lost_and_can_reconnect() async throws {
    let first = ScriptedByteStream()
    let second = ScriptedByteStream()
    let dialer = Dialer([first, second])
    let model = model(dialer) { Self.row(running: true) }
    Task { await model.connect() }
    first.push(ACPFixture.log())
    await first.close()
    let lost = await eventually(timeout: 4) { model.link.phase == .lost }
    XCTAssertTrue(lost)
    try await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertEqual(model.link.phase, .lost)
    XCTAssertFalse(model.hasEnded)
    model.reconnect()
    let redialed = await eventually { dialer.offsets.count == 2 }
    XCTAssertTrue(redialed)
    model.leave()
  }

  func test_a_host_that_cannot_answer_is_a_dropped_connection_not_an_ended_chat() async throws {
    let stream = ScriptedByteStream()
    let dialer = Dialer([stream])
    let model = model(dialer) { nil }
    Task { await model.connect() }
    stream.push(ACPFixture.log())
    await stream.close()
    let lost = await eventually(timeout: 4) { model.link.phase == .lost }
    XCTAssertTrue(lost)
    try await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertEqual(model.link.phase, .lost)
    model.leave()
  }

  func test_opening_an_ended_chat_from_a_snapshot_at_the_end_of_its_log_is_ended_with_nothing_to_replay() async throws {
    let cut = ACPFixture.log().count
    var builder = ChatTranscriptBuilder(journal: ACPFixture.journal)
    try builder.feed(ACPFixture.log())
    let taken = ChatSnapshot(identity: 1_700_000_000, offset: cut, journal: ACPFixture.journal, state: builder.state)
    let stream = ScriptedByteStream()
    let dialer = Dialer([stream])
    let model = model(dialer, snapshots: InMemoryChatSnapshotStore(taken)) { Self.row(running: false) }
    Task { await model.connect() }
    await stream.close()
    let ended = await eventually(timeout: 4) { model.link.phase == .ended }
    XCTAssertTrue(ended)
    XCTAssertEqual(dialer.offsets, [cut], "an empty resume on an ended chat is not a failed resume")
    XCTAssertEqual(model.state.title, "Hello.txt to out.txt")
    model.leave()
  }

  func test_the_link_tracker_keeps_ended_and_the_policy_never_redials_it() {
    var link = ChatLinkTracker()
    link.dialSucceeded(at: .now)
    link.ended()
    link.connectionLost()
    XCTAssertEqual(link.phase, .ended)
    XCTAssertFalse(link.allowsInteraction)
    XCTAssertFalse(ChatReconnectPolicy.shouldReconnect(phase: .ended, dialInFlight: false, left: false))
    XCTAssertTrue(ChatReconnectPolicy.shouldReconnect(phase: .lost, dialInFlight: false, left: false))
  }

  func test_list_and_drawer_rows_already_say_ended() {
    let chat = Self.row(running: false)
    let rows = DrawerChatRows.rows(chats: [chat], titles: [:])
    XCTAssertEqual(rows.first?.stateLabel, "ended")
    XCTAssertFalse(chat.isRunning)
  }
}
