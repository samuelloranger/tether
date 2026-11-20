import XCTest
@testable import TetherKit

final class ChatSessionAccessTests: XCTestCase {
  private static let allCapabilities = #"{"loadSession":true,"sessionCapabilities":{"fork":{},"resume":{},"delete":{},"additionalDirectories":{}},"mcpCapabilities":{"http":true,"sse":true}}"#

  private func written(_ stream: ScriptedByteStream) -> [NSDictionary] {
    stream.writtenText.split(separator: "\n").compactMap {
      (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? NSDictionary
    }
  }

  private func request(_ stream: ScriptedByteStream, _ method: String) -> NSDictionary? {
    written(stream).first { $0["method"] as? String == method }
  }

  private func answer(_ stream: ScriptedByteStream, id: Int, result: String) {
    stream.push(Data(#"{"jsonrpc":"2.0","id":\#(id),"result":\#(result)}"#.utf8 + [0x0A]))
  }

  private func waitFor(_ stream: ScriptedByteStream, _ method: String) async -> Bool {
    await eventually { stream.writtenText.contains("\"method\":\"\(method)\"") }
  }

  /// Answers `initialize` with `capabilities`, then lets `steps` drive the rest.
  private func start(
    journal: ChatJournal, capabilities: String = allCapabilities, resuming: Bool = false,
    servers: [ChatMCPServer] = [], steps: (ScriptedByteStream) async -> Void
  ) async throws -> (InMemoryChatJournalStore, ScriptedByteStream) {
    let store = InMemoryChatJournalStore()
    store.save(journal)
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream, store: store, mcpServers: servers)
    let started = Task { try await client.start(cwd: "/work", resuming: resuming) }
    let sentInit = await waitFor(stream, "initialize")
    XCTAssertTrue(sentInit)
    answer(stream, id: journal.nextRequestId, result: #"{"protocolVersion":1,"agentCapabilities":\#(capabilities)}"#)
    await steps(stream)
    _ = try await started.value
    return (store, stream)
  }

  private func forkJournal(messageId: String? = "msg_9") -> ChatJournal {
    var journal = ChatJournal()
    journal.fork = ChatForkSource(sessionId: "parent", messageId: messageId)
    journal.branchSeed = "Earlier conversation…"
    return journal
  }

  func test_capabilities_are_read_from_key_presence() {
    let parsed = ACPAgentCapabilities(agentCapabilities: [
      "sessionCapabilities": ["fork": [String: Any](), "list": [String: Any]()], "mcpCapabilities": ["http": true],
    ])
    XCTAssertEqual(parsed, ACPAgentCapabilities(fork: true, mcpHttp: true))
    XCTAssertEqual(ACPAgentCapabilities(agentCapabilities: [:]), ACPAgentCapabilities())
  }

  func test_a_branch_forks_the_agent_session_at_the_last_reply_and_drops_the_seed() async throws {
    let (store, stream) = try await start(journal: forkJournal()) { stream in
      let sent = await self.waitFor(stream, "session/fork")
      XCTAssertTrue(sent)
      self.answer(stream, id: 2, result: #"{"sessionId":"forked"}"#)
    }
    let fork = request(stream, "session/fork")?["params"] as? NSDictionary
    XCTAssertEqual(fork?["sessionId"] as? String, "parent")
    XCTAssertEqual(fork?["cwd"] as? String, "/work")
    XCTAssertEqual(
      fork?.value(forKeyPath: "_meta.jetbrains.air.fork") as? NSDictionary,
      ["version": 1, "messageId": "msg_9"] as NSDictionary)
    XCTAssertNil(request(stream, "session/new"))
    XCTAssertEqual(store.load().sessionId, "forked")
    XCTAssertNil(store.load().branchSeed)
    XCTAssertEqual(store.load().capabilities?.fork, true)
  }

  func test_a_fork_without_a_message_id_copies_the_whole_session() {
    XCTAssertNil(ChatForkSource(sessionId: "s").params["_meta"])
  }

  func test_a_refused_fork_falls_back_to_a_new_session_with_the_seed() async throws {
    let (store, stream) = try await start(journal: forkJournal()) { stream in
      let sent = await self.waitFor(stream, "session/fork")
      XCTAssertTrue(sent)
      stream.push(Data(#"{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"Fork point not found"}}"#.utf8 + [0x0A]))
      let fresh = await self.waitFor(stream, "session/new")
      XCTAssertTrue(fresh)
      self.answer(stream, id: 3, result: #"{"sessionId":"new"}"#)
    }
    XCTAssertNotNil(request(stream, "session/new"))
    XCTAssertEqual(store.load().sessionId, "new")
    XCTAssertEqual(store.load().branchSeed, "Earlier conversation…")
  }

  func test_an_agent_that_cannot_fork_gets_a_new_session() async throws {
    let (_, stream) = try await start(journal: forkJournal(), capabilities: "{}") { stream in
      let fresh = await self.waitFor(stream, "session/new")
      XCTAssertTrue(fresh)
      self.answer(stream, id: 2, result: #"{"sessionId":"new"}"#)
    }
    XCTAssertNil(request(stream, "session/fork"))
  }

  func test_resuming_an_ended_chat_sends_session_resume_without_a_new_session() async throws {
    var journal = ChatJournal()
    journal.sessionId = "s1"
    journal.nextRequestId = 7
    let (_, stream) = try await start(journal: journal, resuming: true) { stream in
      let sent = await self.waitFor(stream, "session/resume")
      XCTAssertTrue(sent)
      self.answer(stream, id: 8, result: "{}")
    }
    XCTAssertEqual(request(stream, "session/resume")?["params"] as? NSDictionary,
      ["sessionId": "s1", "cwd": "/work", "mcpServers": [Any]()] as NSDictionary)
    XCTAssertNil(request(stream, "session/new"))
    XCTAssertNil(request(stream, "session/load"))
  }

  func test_extra_folders_and_mcp_servers_go_only_to_an_agent_that_takes_them() async throws {
    var journal = ChatJournal()
    journal.extraDirectories = ["/work/api"]
    let server = ChatMCPServer(name: "docs", url: "https://mcp.example.com/mcp", headers: [.init(name: "Authorization", value: "Bearer t")])
    let (_, full) = try await start(journal: journal, servers: [server]) { stream in
      _ = await self.waitFor(stream, "session/new")
      self.answer(stream, id: 2, result: #"{"sessionId":"a"}"#)
    }
    let params = request(full, "session/new")?["params"] as? NSDictionary
    XCTAssertEqual(params?["additionalDirectories"] as? [String], ["/work/api"])
    XCTAssertEqual(params?["mcpServers"] as? [NSDictionary], [[
      "type": "http", "name": "docs", "url": "https://mcp.example.com/mcp",
      "headers": [["name": "Authorization", "value": "Bearer t"]],
    ] as NSDictionary])

    let (_, bare) = try await start(journal: journal, capabilities: "{}", servers: [server]) { stream in
      _ = await self.waitFor(stream, "session/new")
      self.answer(stream, id: 2, result: #"{"sessionId":"b"}"#)
    }
    XCTAssertEqual(request(bare, "session/new")?["params"] as? NSDictionary, ["cwd": "/work", "mcpServers": [Any]()] as NSDictionary)
  }

  func test_the_fork_point_is_the_last_reply_before_the_prompt() {
    let items: [ChatItem] = [
      .init(id: 1, kind: .user(text: "a", offset: 0)),
      .init(id: 2, kind: .assistant(text: "one", messageId: "m1")),
      .init(id: 3, kind: .assistant(text: "two", messageId: "m2")),
      .init(id: 4, kind: .user(text: "b", offset: 0)),
      .init(id: 5, kind: .assistant(text: "three", messageId: nil)),
      .init(id: 6, kind: .user(text: "c", offset: 0)),
    ]
    XCTAssertEqual(ChatForkSource.before(items: items, at: 4, sessionId: "s"), ChatForkSource(sessionId: "s", messageId: "m2"))
    XCTAssertNil(ChatForkSource.before(items: items, at: 1, sessionId: "s"), "nothing before the first prompt")
    XCTAssertNil(ChatForkSource.before(items: items, at: 6, sessionId: "s"), "a reply without an id can't be a fork point")
    XCTAssertNil(ChatForkSource.before(items: items, at: 4, sessionId: nil))
    let point = ChatBranching.point(items: items, at: 4, sessionId: "s", canFork: true)
    XCTAssertEqual(point?.fork?.messageId, "m2")
    XCTAssertNil(ChatBranching.point(items: items, at: 4, sessionId: "s")?.fork)
  }

  func test_mcp_server_headers_and_validation() {
    XCTAssertEqual(ChatMCPServer.headers(from: "Authorization: Bearer a:b\n\nX-Team:  core "),
      [.init(name: "Authorization", value: "Bearer a:b"), .init(name: "X-Team", value: "core")])
    XCTAssertNil(ChatMCPServer.headers(from: "no colon here"))
    let saved = [ChatMCPServer(name: "docs", url: "https://a.example")]
    XCTAssertNotNil(ChatMCPServer(name: " ", url: "https://a.example").problem(among: []))
    XCTAssertNotNil(ChatMCPServer(name: "docs", url: "https://b.example").problem(among: saved))
    XCTAssertNotNil(ChatMCPServer(name: "x", url: "ftp://b.example").problem(among: saved))
    XCTAssertNotNil(ChatMCPServer(name: "x", url: "https://").problem(among: saved))
    XCTAssertNil(ChatMCPServer(name: "x", url: "http://10.0.0.2:8080/mcp").problem(among: saved))
  }

  func test_saved_servers_round_trip_and_resolve_by_name() {
    final class Secrets: SSHSecretStore {
      var values: [String: String] = [:]
      func setSecret(_ value: String?, forKey key: String) { values[key] = value }
      func secret(forKey key: String) -> String? { values[key] }
    }
    let secrets = Secrets()
    let store = ChatMCPServerStore(scope: "h:22", secrets: secrets)
    store.servers = [ChatMCPServer(name: "a", url: "https://a.example"), ChatMCPServer(name: "b", url: "https://b.example")]
    XCTAssertEqual(store.resolve(["b", "gone", "a"]).map(\.name), ["b", "a"])
    store.servers = []
    XCTAssertTrue(secrets.values.isEmpty)
  }

  func test_host_commands_for_revive_and_delete() {
    XCTAssertTrue(ACPHostCommand.attach(name: "c", cwd: "/w", spawn: true, revive: true).hasSuffix(" --revive"))
    XCTAssertFalse(ACPHostCommand.attach(name: "c", cwd: "/w", spawn: false, revive: true).contains("--revive"))
    XCTAssertEqual(
      ACPHostCommand.deleteSession(cwd: "/w p", sessionId: "abc"),
      "PATH=\"$HOME/.local/bin:$PATH\" tether acp sessions '/w p' --delete 'abc' 2>&1")
    XCTAssertTrue(ACPHostCommand.deleteSession(cwd: "/w", sessionId: "abc", agent: ChatAgents.codex).contains("--agent-cmd"))
    XCTAssertNil(ACPHostCommand.deleteFailure(#"{"deleted":"abc"}"# + "\n"))
    XCTAssertEqual(ACPHostCommand.deleteFailure("flag provided but not defined: -delete\nusage: …"),
      "Update tether on the host to delete conversations.")
    XCTAssertEqual(ACPHostCommand.deleteFailure("tether: this agent can't delete saved conversations"),
      "this agent can't delete saved conversations")
  }
}
