import XCTest
@testable import TetherKit

final class ChatHermesTests: XCTestCase {
  func test_persistent_conversation_is_scoped_to_host() {
    XCTAssertEqual(ChatHermes.conversationName(scope: "server:22"), ChatHermes.conversationName(scope: "server:22"))
    XCTAssertNotEqual(ChatHermes.conversationName(scope: "server:22"), ChatHermes.conversationName(scope: "server:2222"))
    XCTAssertTrue(ChatHermes.conversationName(scope: "server:22").hasPrefix("hermes-"))
  }

  func test_modules_preserve_dynamic_commands_and_arguments() {
    XCTAssertEqual(ChatHermes.module(for: .init(name: "new", description: "Fresh")), .fresh)
    XCTAssertEqual(ChatHermes.module(for: .init(name: "model", description: "Model")), .model)
    XCTAssertEqual(ChatHermes.module(for: .init(name: "compress", description: "Summarize")), .compact)
    let plugin = ACPCommand(name: "home-lights", description: "A dynamically advertised plugin", hint: "room")
    XCTAssertEqual(ChatHermes.module(for: plugin), .command)
    XCTAssertEqual(ChatHermes.commandText(plugin, argument: " living room "), "/home-lights living room")
    XCTAssertTrue(ChatHermes.isFresh(" /new "))
    XCTAssertTrue(ChatHermes.isFresh("/reset now"))
    XCTAssertFalse(ChatHermes.isFresh("/newer"))
    XCTAssertFalse(ChatHermes.isFresh("Please use /new"))
  }

  func test_hermes_uses_the_host_bridge_and_does_not_require_node() {
    XCTAssertEqual(ChatAgents.profile(forSpawn: "tether hermes"), ChatAgents.hermes)
    XCTAssertFalse(ChatAgents.hermes.needsNode)
    XCTAssertTrue(ACPHostCheck.relevant([.nodeMissing, .hermesMissing], for: ChatAgents.claude).contains(.nodeMissing))
    XCTAssertEqual(ACPHostCheck.relevant([.nodeMissing, .hermesMissing], for: ChatAgents.hermes), [.hermesMissing])
  }

  func test_opening_hermes_reuses_existing_conversation() async {
    let result = await ChatRoute.start(cwdText: "~", host: "server", agent: ChatAgents.hermes) { command in
      if command == ACPHostCheck.command { return "hermes=ok\nversion={\"name\":\"tether\",\"protocol\":2}" }
      if command.contains("tether hermes --prepare") { return #"{"name":"hermes-existing","cwd":"/home/sam","fresh":false}"# }
      XCTFail("Existing Hermes must not create another conversation")
      return ""
    }
    guard case let .ready(route) = result else { return XCTFail("Expected existing Hermes") }
    XCTAssertEqual(route.name, "hermes-existing")
    XCTAssertEqual(route.agentKey, "hermes")
    XCTAssertTrue(route.multiClient)
    XCTAssertFalse(route.startedHere)
  }

  func test_revived_holder_starts_with_a_clean_local_replay_identity() async {
    let name = "hermes-test-" + UUID().uuidString
    let store = UserDefaultsChatJournalStore(name: name)
    var old = ChatJournal()
    old.sessionId = "old-session"
    store.save(old)
    defer { store.save(ChatJournal()) }
    let result = await ChatRoute.start(cwdText: "~", host: "server", agent: ChatAgents.hermes) { command in
      if command == ACPHostCheck.command { return "hermes=ok" }
      return "{\"name\":\"\(name)\",\"cwd\":\"/home/sam\",\"fresh\":true}"
    }
    guard case let .ready(route) = result else { return XCTFail("Expected revived Hermes") }
    XCTAssertEqual(route.name, name)
    XCTAssertTrue(route.startedHere)
    XCTAssertFalse(route.join)
    XCTAssertNil(store.load().sessionId)
  }

  func test_refused_preparation_never_creates_a_replacement_chat() async {
    let result = await ChatRoute.start(cwdText: "~", host: "server", agent: ChatAgents.hermes) { command in
      command == ACPHostCheck.command ? "hermes=ok" : "the holder could not start"
    }
    guard case .failed = result else { return XCTFail("A failed prepare must remain an explicit failure") }
  }

}
