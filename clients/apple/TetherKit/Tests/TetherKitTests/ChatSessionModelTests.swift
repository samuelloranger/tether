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
    private(set) var offsets: [Int] = []
    init(_ streams: [any TerminalByteStream]) { self.streams = streams }
    func dial(spawn: Bool, from: Int = 0) throws -> any TerminalByteStream {
      spawns.append(spawn)
      offsets.append(from)
      guard !streams.isEmpty else { throw SSHConnectError.transport("no route") }
      return streams.removeFirst()
    }
  }

  private func model(
    _ dialer: Dialer, journal: ChatJournal = ACPFixture.journal, readOnly: Bool = false
  ) -> ChatSessionModel {
    ChatSessionModel(
      chatName: "chat-t", cwd: "/work/project", readOnly: readOnly, store: InMemoryChatJournalStore(journal)
    ) { try dialer.dial(spawn: $0, from: $1) }
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

  func test_the_latest_title_is_stored_for_the_chat_list() async throws {
    let defaults = UserDefaults(suiteName: "chat-title-\(UUID().uuidString)")!
    let titles = ChatTitleStore(scope: "h:22", defaults: defaults)
    let stream = ScriptedByteStream()
    let model = ChatSessionModel(
      chatName: "chat-t", cwd: "/work/project", readOnly: false,
      store: InMemoryChatJournalStore(ACPFixture.journal), titleStore: titles
    ) { _, _ in stream }
    Task { await model.connect() }
    stream.push(ACPFixture.log())
    let live = await settled(model)
    XCTAssertTrue(live)
    XCTAssertEqual(titles.title(for: "chat-t"), "Hello.txt to out.txt")
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

  private var unansweredJournal: ChatJournal {
    var journal = ACPFixture.journal
    journal.entries.removeLast()
    return journal
  }

  private var permissionCut: Int { ACPFixture.index(containing: "session/request_permission") + 1 }

  func test_answers_the_host_took_resolve_the_replayed_permission() async throws {
    let stream = ScriptedByteStream()
    let model = ChatSessionModel(
      chatName: "chat-t", cwd: "/work/project", readOnly: false,
      store: InMemoryChatJournalStore(unansweredJournal), hostAnswers: { "{\"0\":\"allow-once\"}\n" }
    ) { _, _ in stream }
    Task { await model.connect() }
    stream.push(ACPFixture.log(permissionCut))
    let live = await settled(model)
    XCTAssertTrue(live)
    XCTAssertTrue(model.state.pendingPermissions.isEmpty)
    model.leave()
  }

  func test_a_host_without_answers_or_with_garbage_leaves_the_permission_pending() async throws {
    for output in [nil, "", "Usage: acp answers <name>", "{\"0\": 3}"] as [String?] {
      let stream = ScriptedByteStream()
      let model = ChatSessionModel(
        chatName: "chat-t", cwd: "/work/project", readOnly: false,
        store: InMemoryChatJournalStore(unansweredJournal), hostAnswers: { output }
      ) { _, _ in stream }
      Task { await model.connect() }
      stream.push(ACPFixture.log(permissionCut))
      let live = await settled(model)
      XCTAssertTrue(live, output ?? "nil")
      XCTAssertEqual(model.state.pendingPermissions.map(\.requestId), [.int(0)], output ?? "nil")
      model.leave()
    }
  }

  func test_an_in_app_answer_the_host_already_has_resolves_quietly() async throws {
    let stream = ScriptedByteStream()
    let hostSays = LockedBox<String?>(nil)
    let model = ChatSessionModel(
      chatName: "chat-t", cwd: "/work/project", readOnly: false,
      store: InMemoryChatJournalStore(unansweredJournal), hostAnswers: { hostSays.value }
    ) { _, _ in WriteFailingStream(stream) }
    Task { await model.connect() }
    stream.push(ACPFixture.log(permissionCut))
    let live = await settled(model)
    XCTAssertTrue(live)
    let permission = try XCTUnwrap(model.state.pendingPermissions.first)
    hostSays.value = "{\"0\":\"reject\"}"
    model.approve(permission, option: try XCTUnwrap(permission.options.first))
    let resolved = await eventually { model.state.pendingPermissions.isEmpty }
    XCTAssertTrue(resolved)
    XCTAssertNil(model.notice)
    model.leave()
  }

  func test_an_in_app_answer_that_fails_without_a_host_answer_reports_it() async throws {
    let stream = ScriptedByteStream()
    let model = ChatSessionModel(
      chatName: "chat-t", cwd: "/work/project", readOnly: false,
      store: InMemoryChatJournalStore(unansweredJournal), hostAnswers: { "{}" }
    ) { _, _ in WriteFailingStream(stream) }
    Task { await model.connect() }
    stream.push(ACPFixture.log(permissionCut))
    let live = await settled(model)
    XCTAssertTrue(live)
    let permission = try XCTUnwrap(model.state.pendingPermissions.first)
    model.approve(permission, option: try XCTUnwrap(permission.options.first))
    let reported = await eventually { model.answerFailures.contains(permission.requestId) }
    XCTAssertTrue(reported)
    XCTAssertEqual(model.state.pendingPermissions.map(\.requestId), [permission.requestId], "the card stays answerable")
    XCTAssertNil(model.notice, "a quiet retry state, not a banner")
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
      if command == ACPHostCommand.listWithErrors { return "chat-a\trunning\t1\t/srv/api\t5\tx\n" }
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
    let listModel = ChatListModel(hostName: "h") { _ in "zsh: command not found: tether\n" }
    await listModel.refresh()
    guard case let .failed(message) = listModel.load else { return XCTFail() }
    XCTAssertTrue(message.contains("missing or too old"))
    XCTAssertTrue(message.contains("Update tether on h"))
  }

  func test_a_failed_image_prompt_keeps_its_attachments_and_retries_with_them() async throws {
    let inner = ScriptedByteStream()
    let broken = FailingWriteStream(inner: inner)
    let good = ScriptedByteStream()
    let dialer = Dialer([broken, good])
    let model = model(dialer)
    Task { await model.connect() }
    inner.push(ACPFixture.log())
    let live = await settled(model)
    XCTAssertTrue(live)
    let image = ChatImageAttachment(mimeType: "image/png", data: "AAAA")
    XCTAssertFalse(model.send(text: "  ", images: []))
    XCTAssertTrue(model.send(text: "see this", images: [image]))
    let failed = await eventually { !model.outbox.failed.isEmpty }
    XCTAssertTrue(failed)
    XCTAssertEqual(model.outbox.failed.first?.images, [image])

    await inner.close()
    _ = await eventually { model.link.phase == .lost }
    model.reconnect()
    good.push(ACPFixture.log())
    let again = await settled(model)
    XCTAssertTrue(again)
    let id = try XCTUnwrap(model.outbox.failed.first?.id)
    model.retry(id)
    let sent = await eventually { good.writtenText.contains("\"data\":\"AAAA\"") && good.writtenText.contains("see this") }
    XCTAssertTrue(sent)
    XCTAssertTrue(model.outbox.failed.isEmpty)
    model.leave()
  }

  func test_an_image_only_prompt_is_allowed() async throws {
    let stream = ScriptedByteStream()
    let model = model(Dialer([stream]))
    Task { await model.connect() }
    stream.push(ACPFixture.log())
    let live = await settled(model)
    XCTAssertTrue(live)
    XCTAssertTrue(model.send(text: "", images: [ChatImageAttachment(mimeType: "image/jpeg", data: "QQ==")]))
    let sent = await eventually { stream.writtenText.contains("\"mimeType\":\"image/jpeg\"") }
    XCTAssertTrue(sent)
    model.leave()
  }

  private func controlsModel(_ stream: ScriptedByteStream) -> ChatSessionModel {
    var journal = ChatJournal()
    journal.sessionId = "sess-2"
    journal.nextRequestId = 3
    return model(Dialer([stream]), journal: journal)
  }

  func test_set_option_is_pending_until_the_agent_confirms_then_shows_the_new_value() async throws {
    let stream = ScriptedByteStream()
    let model = controlsModel(stream)
    Task { await model.connect() }
    stream.push(ACPFixture.Controls.log(1..<2))
    let live = await settled(model)
    XCTAssertTrue(live)
    XCTAssertEqual(model.state.currentChoice(of: "model"), "Sonnet 5.5")

    model.setOption(id: "model", value: "haiku")
    XCTAssertEqual(model.optionChanges["model"], .pending(value: "haiku"))
    let sent = await eventually { stream.writtenText.contains("session/set_config_option") }
    XCTAssertTrue(sent)
    XCTAssertEqual(model.state.currentChoice(of: "model"), "Sonnet 5.5")
    stream.push(ACPFixture.Controls.log(2..<3))
    let done = await eventually { model.optionChanges["model"] == nil && model.state.currentChoice(of: "model") == "Haiku 5.5" }
    XCTAssertTrue(done)
    model.leave()
  }

  func test_a_refused_option_change_is_recorded_as_failed_and_can_be_dismissed() async throws {
    let stream = ScriptedByteStream()
    let model = controlsModel(stream)
    Task { await model.connect() }
    stream.push(ACPFixture.Controls.log(1..<2))
    let live = await settled(model)
    XCTAssertTrue(live)
    model.setOption(id: "effort", value: "max")
    _ = await eventually { stream.writtenText.contains("session/set_config_option") }
    stream.push(Data("{\"jsonrpc\":\"2.0\",\"id\":3,\"error\":{\"code\":-32602,\"message\":\"unsupported\"}}\n".utf8))
    let failed = await eventually { model.optionChanges["effort"] != nil && model.optionChanges["effort"] != .pending(value: "max") }
    XCTAssertTrue(failed)
    XCTAssertEqual(model.optionChanges["effort"], .failed(value: "max", message: "unsupported"))
    XCTAssertEqual(model.state.currentChoice(of: "effort"), "Medium")
    XCTAssertTrue(model.state.items.isEmpty)
    model.dismissOptionFailure(id: "effort")
    XCTAssertNil(model.optionChanges["effort"])
    model.leave()
  }

  private func defaultsStore(_ stored: [String: String] = [:]) -> ChatOptionDefaultsStore {
    let store = ChatOptionDefaultsStore(defaults: UserDefaults(suiteName: "tether.test.\(UUID().uuidString)")!)
    for (id, value) in stored { store.remember(agent: ACPHostCommand.agentKey, id: id, value: value) }
    return store
  }

  private func optionModel(
    _ stream: ScriptedByteStream, journal: ChatJournal, join: Bool = false, defaults: ChatOptionDefaultsStore
  ) -> ChatSessionModel {
    ChatSessionModel(
      chatName: "chat-t", cwd: "/work/project", readOnly: false, join: join,
      store: InMemoryChatJournalStore(journal), optionDefaults: defaults
    ) { _, _ in stream }
  }

  private func handshake(_ stream: ScriptedByteStream) async {
    _ = await eventually { stream.writtenText.contains("\"method\":\"initialize\"") }
    stream.push(ACPFixture.Controls.log(0..<1))
    _ = await eventually { stream.writtenText.contains("session/new") }
    stream.push(ACPFixture.Controls.log(1..<2))
  }

  private func setCalls(_ stream: ScriptedByteStream) -> Int {
    stream.writtenText.components(separatedBy: "session/set_config_option").count - 1
  }

  func test_a_new_chat_sends_the_stored_defaults_that_are_offered_and_differ() async throws {
    let stream = ScriptedByteStream()
    let defaults = defaultsStore(["model": "haiku", "effort": "medium", "mode": "gone"])
    let model = optionModel(stream, journal: ChatJournal(), defaults: defaults)
    Task { await model.connect() }
    await handshake(stream)
    let sent = await eventually { stream.writtenText.contains("session/set_config_option") }
    XCTAssertTrue(sent)
    XCTAssertTrue(stream.writtenText.contains("\"configId\":\"model\""))
    stream.push(ACPFixture.Controls.log(2..<3))
    let done = await eventually { model.state.currentChoice(of: "model") == "Haiku 5.5" }
    XCTAssertTrue(done)
    XCTAssertEqual(setCalls(stream), 1)
    XCTAssertTrue(model.optionChanges.isEmpty)
    model.leave()
  }

  func test_a_refused_default_is_not_shown_and_stays_stored() async throws {
    let stream = ScriptedByteStream()
    let defaults = defaultsStore(["model": "haiku"])
    let model = optionModel(stream, journal: ChatJournal(), defaults: defaults)
    Task { await model.connect() }
    await handshake(stream)
    _ = await eventually { stream.writtenText.contains("session/set_config_option") }
    stream.push(Data("{\"jsonrpc\":\"2.0\",\"id\":3,\"error\":{\"code\":-32602,\"message\":\"no\"}}\n".utf8))
    let live = await settled(model)
    XCTAssertTrue(live)
    XCTAssertTrue(model.optionChanges.isEmpty)
    XCTAssertNil(model.notice)
    XCTAssertEqual(defaults.stored(agent: ACPHostCommand.agentKey), ["model": "haiku"])
    model.leave()
  }

  private func optionsResult(id: Int, model: String, effort: String, efforts: [String], mode: String = "default") -> Data {
    func select(_ id: String, _ current: String, _ values: [String]) -> String {
      let choices = values.map { "{\"value\":\"\($0)\",\"name\":\"\($0)\"}" }.joined(separator: ",")
      return "{\"id\":\"\(id)\",\"name\":\"\(id)\",\"type\":\"select\",\"currentValue\":\"\(current)\",\"options\":[\(choices)]}"
    }
    let options = [
      select("mode", mode, ["default", "acceptEdits", "plan"]), select("model", model, ["sonnet", "opus"]),
      select("effort", effort, efforts),
    ].joined(separator: ",")
    return Data("{\"jsonrpc\":\"2.0\",\"id\":\(id),\"result\":{\"configOptions\":[\(options)]}}\n".utf8)
  }

  func test_effort_is_chosen_from_the_options_the_new_model_offers() async throws {
    let stream = ScriptedByteStream()
    let defaults = defaultsStore(["model": "opus", "effort": "xhigh"])
    let model = optionModel(stream, journal: ChatJournal(), defaults: defaults)
    Task { await model.connect() }
    await handshake(stream)
    _ = await eventually { setCalls(stream) == 1 }
    XCTAssertEqual(setCalls(stream), 1)
    stream.push(optionsResult(id: 3, model: "opus", effort: "medium", efforts: ["low", "medium", "xhigh"]))
    let second = await eventually { setCalls(stream) == 2 }
    XCTAssertTrue(second)
    XCTAssertTrue(stream.writtenText.contains("\"configId\":\"effort\""))
    XCTAssertTrue(stream.writtenText.contains("\"value\":\"xhigh\""))
    model.leave()
  }

  func test_a_choice_made_during_the_chain_is_not_overwritten_by_a_default() async throws {
    let stream = ScriptedByteStream()
    let defaults = defaultsStore(["model": "opus", "mode": "plan"])
    let model = optionModel(stream, journal: ChatJournal(), defaults: defaults)
    Task { await model.connect() }
    await handshake(stream)
    _ = await eventually { setCalls(stream) == 1 }
    let interactive = await settled(model)
    XCTAssertTrue(interactive)
    model.setOption(id: "mode", value: "acceptEdits")
    _ = await eventually { setCalls(stream) == 2 }
    stream.push(optionsResult(id: 3, model: "opus", effort: "medium", efforts: ["low", "medium"]))
    stream.push(optionsResult(id: 4, model: "opus", effort: "medium", efforts: ["low", "medium"], mode: "acceptEdits"))
    let done = await eventually { model.state.currentChoice(of: "mode") == "acceptEdits" && model.optionChanges.isEmpty }
    XCTAssertTrue(done)
    try await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertEqual(setCalls(stream), 2)
    XCTAssertFalse(stream.writtenText.contains("\"value\":\"plan\""))
    model.leave()
  }

  func test_a_resumed_or_joined_chat_sends_no_defaults() async throws {
    let defaults = defaultsStore(["model": "haiku"])
    let resumed = ScriptedByteStream()
    var journal = ChatJournal()
    journal.sessionId = "sess-2"
    journal.nextRequestId = 3
    let resumedModel = optionModel(resumed, journal: journal, defaults: defaults)
    Task { await resumedModel.connect() }
    resumed.push(ACPFixture.Controls.log(1..<2))
    let live = await settled(resumedModel)
    XCTAssertTrue(live)
    XCTAssertEqual(setCalls(resumed), 0)
    resumedModel.leave()

    let joined = ScriptedByteStream()
    let joinedModel = optionModel(joined, journal: ChatJournal(), join: true, defaults: defaults)
    Task { await joinedModel.connect() }
    joined.push(ACPFixture.Controls.log(1..<2))
    let joinedLive = await eventually { joinedModel.state.currentChoice(of: "model") == "Sonnet 5.5" }
    XCTAssertTrue(joinedLive)
    XCTAssertEqual(setCalls(joined), 0)
    XCTAssertFalse(joined.writtenText.contains("session/new"))
    joinedModel.leave()
  }

  func test_a_confirmed_user_change_is_stored_and_a_refused_one_is_not() async throws {
    let stream = ScriptedByteStream()
    let defaults = defaultsStore()
    var journal = ChatJournal()
    journal.sessionId = "sess-2"
    journal.nextRequestId = 3
    let model = optionModel(stream, journal: journal, defaults: defaults)
    Task { await model.connect() }
    stream.push(ACPFixture.Controls.log(1..<2))
    let live = await settled(model)
    XCTAssertTrue(live)
    model.setOption(id: "model", value: "haiku")
    _ = await eventually { stream.writtenText.contains("session/set_config_option") }
    XCTAssertTrue(defaults.stored(agent: ACPHostCommand.agentKey).isEmpty)
    stream.push(ACPFixture.Controls.log(2..<3))
    let stored = await eventually { defaults.stored(agent: ACPHostCommand.agentKey)["model"] == "haiku" }
    XCTAssertTrue(stored)
    model.setOption(id: "effort", value: "max")
    stream.push(Data("{\"jsonrpc\":\"2.0\",\"id\":4,\"error\":{\"code\":-32602,\"message\":\"unsupported\"}}\n".utf8))
    _ = await eventually { model.optionChanges["effort"] != nil && model.optionChanges["effort"] != .pending(value: "max") }
    XCTAssertEqual(defaults.stored(agent: ACPHostCommand.agentKey), ["model": "haiku"])
    model.leave()
  }
}

/// Reads pass through; every write fails, as a socket the host already dropped would.
final class WriteFailingStream: TerminalByteStream, @unchecked Sendable {
  private let inner: ScriptedByteStream
  init(_ inner: ScriptedByteStream) { self.inner = inner }
  func read() async throws -> Data? { try await inner.read() }
  func write(_ bytes: Data) async throws { throw SSHConnectError.transport("closed") }
  func close() async { await inner.close() }
}
