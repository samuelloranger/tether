import XCTest
@testable import TetherKit

private struct FailingWriteStream: TerminalByteStream {
  let inner: ScriptedByteStream
  func read() async throws -> Data? { try await inner.read() }
  func write(_ bytes: Data) async throws { throw ACPClientError.connectionLost }
  func close() async { await inner.close() }
}

@MainActor
final class ChatSessionModelTests: XCTestCase {
  private final class Dialer: @unchecked Sendable {
    var streams: [any TerminalByteStream]
    private(set) var spawns: [Bool] = []
    init(_ streams: [any TerminalByteStream]) { self.streams = streams }
    func dial(spawn: Bool) throws -> any TerminalByteStream {
      spawns.append(spawn)
      guard !streams.isEmpty else { throw SSHConnectError.transport("no route") }
      return streams.removeFirst()
    }
  }

  private func model(
    _ dialer: Dialer, journal: ChatJournal = ACPFixture.journal, readOnly: Bool = false
  ) -> ChatSessionModel {
    ChatSessionModel(
      chatName: "chat-t", cwd: "/work/project", readOnly: readOnly, store: InMemoryChatJournalStore(journal)
    ) { try dialer.dial(spawn: $0) }
  }

  private func settled(_ model: ChatSessionModel) async -> Bool {
    await eventually(timeout: 4) { model.link.phase == .live }
  }

  func test_resume_replays_the_log_then_goes_live_and_unlocks_sending() async throws {
    let stream = ScriptedByteStream()
    let dialer = Dialer([stream])
    let model = model(dialer)
    let connecting = Task { await model.connect() }
    stream.push(ACPFixture.log())
    XCTAssertFalse(model.canSend)
    let live = await settled(model)
    XCTAssertTrue(live)
    await connecting.value
    XCTAssertEqual(dialer.spawns, [false])
    XCTAssertTrue(model.canSend)
    XCTAssertEqual(model.state.title, "Hello.txt to out.txt")
    XCTAssertEqual(model.state.turn, .idle)
    model.leave()
  }

  func test_a_new_chat_spawns_the_agent_and_runs_the_handshake() async throws {
    let stream = ScriptedByteStream()
    let dialer = Dialer([stream])
    let model = model(dialer, journal: ChatJournal())
    Task { await model.connect() }
    let sent = await eventually { stream.writtenText.contains("session/new") || stream.writtenText.contains("initialize") }
    XCTAssertTrue(sent)
    XCTAssertEqual(dialer.spawns, [true])
    model.leave()
  }

  func test_losing_the_stream_marks_the_link_lost_and_reconnect_redials_with_the_old_transcript_kept() async throws {
    let first = ScriptedByteStream()
    let second = ScriptedByteStream()
    let dialer = Dialer([first, second])
    let model = model(dialer)
    Task { await model.connect() }
    first.push(ACPFixture.log())
    let live = await settled(model)
    XCTAssertTrue(live)
    let items = model.state.items.count
    XCTAssertGreaterThan(items, 0)

    await first.close()
    let lost = await eventually { model.link.phase == .lost }
    XCTAssertTrue(lost)
    XCTAssertFalse(model.canSend)
    XCTAssertEqual(model.state.items.count, items)

    model.reconnect()
    let redialed = await eventually { dialer.spawns.count == 2 }
    XCTAssertTrue(redialed)
    XCTAssertEqual(model.state.items.count, items, "the old transcript stays up while the replay runs")
    second.push(ACPFixture.log())
    let again = await settled(model)
    XCTAssertTrue(again)
    XCTAssertEqual(model.state.items.count, items)
    model.leave()
  }

  func test_a_failed_dial_is_lost_with_a_note_and_a_second_try_works() async throws {
    let stream = ScriptedByteStream()
    let dialer = Dialer([])
    let model = model(dialer)
    await model.connect()
    XCTAssertEqual(model.link.phase, .lost)
    XCTAssertNotNil(model.notice)
    dialer.streams = [stream]
    model.sceneBecameActive()
    stream.push(ACPFixture.log())
    let live = await settled(model)
    XCTAssertTrue(live)
    XCTAssertNil(model.notice)
    model.leave()
  }

  func test_a_prompt_that_cannot_be_written_lands_in_the_outbox_and_retries() async throws {
    let inner = ScriptedByteStream()
    let broken = FailingWriteStream(inner: inner)
    let good = ScriptedByteStream()
    let dialer = Dialer([broken, good])
    let model = model(dialer)
    Task { await model.connect() }
    inner.push(ACPFixture.log())
    let live = await settled(model)
    XCTAssertTrue(live)
    let itemsBefore = model.state.items.count

    XCTAssertTrue(model.send("hello"))
    let failed = await eventually { !model.outbox.failed.isEmpty }
    XCTAssertTrue(failed)
    XCTAssertEqual(model.outbox.failed.map(\.text), ["hello"])
    let removed = await eventually { model.state.items.count == itemsBefore && model.state.turn == .idle }
    XCTAssertTrue(removed, "an undelivered prompt must not stay in the transcript")

    await inner.close()
    _ = await eventually { model.link.phase == .lost }
    model.reconnect()
    good.push(ACPFixture.log())
    let again = await settled(model)
    XCTAssertTrue(again)
    XCTAssertEqual(model.state.items.count, itemsBefore, "the failed prompt must not reappear on replay")
    let id = try XCTUnwrap(model.outbox.failed.first?.id)
    model.retry(id)
    let sent = await eventually { good.writtenText.contains("\"text\":\"hello\"") }
    XCTAssertTrue(sent)
    XCTAssertTrue(model.outbox.failed.isEmpty)
    model.leave()
  }

  func test_send_and_approve_are_refused_until_the_replay_settles_and_in_read_only_chats() async throws {
    let stream = ScriptedByteStream()
    let dialer = Dialer([stream])
    let model = model(dialer, readOnly: true)
    Task { await model.connect() }
    XCTAssertFalse(model.send("too early"))
    stream.push(ACPFixture.log())
    let live = await settled(model)
    XCTAssertTrue(live)
    XCTAssertFalse(model.send("read only"))
    XCTAssertEqual(stream.writtenText, "")
    model.leave()
  }

  func test_entering_the_background_drops_the_socket_and_the_return_redials() async throws {
    let first = ScriptedByteStream()
    let second = ScriptedByteStream()
    let dialer = Dialer([first, second])
    let model = model(dialer)
    Task { await model.connect() }
    first.push(ACPFixture.log())
    let live = await settled(model)
    XCTAssertTrue(live)
    model.sceneEnteredBackground()
    XCTAssertEqual(model.link.phase, .lost)
    let closed = await eventually { first.closed }
    XCTAssertTrue(closed)
    model.sceneBecameActive()
    let redialed = await eventually { dialer.spawns.count == 2 }
    XCTAssertTrue(redialed)
    model.leave()
  }

  func test_the_list_model_parses_deletes_and_resolves_the_home_folder() async throws {
    var commands: [String] = []
    let listModel = ChatListModel(hostName: "h") { command in
      commands.append(command)
      if command == ACPHostCommand.list { return "chat-a\trunning\t1\t/srv/api\t5\tx\n" }
      if command == ACPHostCommand.home { return "/home/sam" }
      return ""
    }
    await listModel.refresh()
    XCTAssertEqual(listModel.load, .loaded)
    XCTAssertEqual(listModel.chats.map(\.title), ["api"])
    XCTAssertEqual(listModel.route(for: listModel.chats[0]), ChatRoute(name: "chat-a", cwd: "/srv/api", readOnly: true))

    let route = await listModel.newRoute(cwdText: "~/code")
    XCTAssertEqual(route?.cwd, "/home/sam/code")
    XCTAssertEqual(route?.readOnly, false)
    XCTAssertTrue(route?.name.hasPrefix("chat-") == true)

    await listModel.delete(listModel.chats[0])
    XCTAssertTrue(commands.contains(ACPHostCommand.kill(name: "chat-a")))
    XCTAssertTrue(listModel.chats.isEmpty)
  }

  func test_a_missing_tether_notify_is_explained() async {
    let listModel = ChatListModel(hostName: "h") { _ in "zsh: command not found: tether-notify\n" }
    await listModel.refresh()
    guard case let .failed(message) = listModel.load else { return XCTFail() }
    XCTAssertTrue(message.contains("missing or too old"))
  }
}
