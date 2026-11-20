import XCTest
@testable import TetherKit

final class ChatManagedAgentsTests: XCTestCase {
  func test_versions_parse_supported_unsupported_and_unknown() {
    let output = """
      {"kind":"adapter","agent":"claude","package":"p","version":"0.95.0","managed":false,"engine":"Claude Code 2.1.309","latest":"0.109.0","checkedAt":1,"updateAvailable":true}
      {"kind":"adapter","agent":"codex","package":"q","version":"2.8.0","managed":true,"previous":"2.3.0","updateAvailable":false,"error":"offline"}
      {"kind":"cli","agent":"claude","version":"2.1.327","latest":"2.1.329","updateAvailable":true,"command":"claude update","runnable":true}
      {"kind":"cli","agent":"codex","version":"0.120.0","latest":"0.171.0","updateAvailable":true,"command":"npm install -g @openai/codex@latest","runnable":false}
      """
    guard case let .supported(all)? = ACPAgentVersions.parse(output) else { return XCTFail("supported") }
    XCTAssertEqual(all["adapter:claude"]?.notice(label: "Claude"), "Claude adapter 0.109.0 available · you have 0.95.0 (Claude Code 2.1.309)")
    XCTAssertEqual(all["adapter:codex"]?.previous, "2.3.0")
    XCTAssertEqual(all["adapter:codex"]?.updateAvailable, false)
    XCTAssertEqual(all["cli:claude"]?.notice(label: "Claude"), "Claude Code CLI 2.1.329 available · you have 2.1.327")
    XCTAssertEqual(all["cli:codex"]?.runnable, false)
    XCTAssertEqual(all["cli:codex"]?.command, "npm install -g @openai/codex@latest")
    XCTAssertEqual(ACPHostCommand.update(all["cli:claude"]!), "PATH=\"$HOME/.local/bin:$PATH\" tether acp update 'claude' --cli 2>&1")
    XCTAssertEqual(ACPHostCommand.update(all["adapter:codex"]!), "PATH=\"$HOME/.local/bin:$PATH\" tether acp update 'codex' 2>&1")
    XCTAssertEqual(ACPAgentVersions.parse("tether: unknown acp command \"versions\""), .unsupported)
    XCTAssertNil(ACPAgentVersions.parse("ssh: connection reset"))
  }

  func test_spawn_follows_the_host_and_managed_spawns_are_recognised() {
    XCTAssertEqual(ChatAgents.codex.command(managed: true), "tether acp agent codex")
    XCTAssertEqual(ChatAgents.codex.command(managed: false), ChatAgents.codex.spawn)
    XCTAssertEqual(ChatAgents.opencode.command(managed: true), ChatAgents.opencode.spawn)
    XCTAssertEqual(ChatAgents.profile(forSpawn: "tether acp agent codex"), ChatAgents.codex)
    XCTAssertEqual(ChatAgents.profile(forSpawn: "tether acp agent claude"), ChatAgents.claude)
    XCTAssertEqual(ChatAgents.profile(forSpawn: ChatAgents.codex.spawn), ChatAgents.codex, "the old pinned command still maps")
    XCTAssertNil(ChatAgents.profile(forSpawn: "tether acp agent hermes"))
    XCTAssertTrue(ACPHostCommand.sessions(cwd: "/w", limit: 5, agent: ChatAgents.codex, managed: true)
      .contains("--agent-cmd 'tether acp agent codex'"))
    XCTAssertEqual(ACPHostCommand.options(cwd: "/w", agent: ChatAgents.claude, managed: true),
      "PATH=\"$HOME/.local/bin:$PATH\" tether acp options '/w' --agent-cmd 'tether acp agent claude' 2>&1")
  }

  func test_not_now_hides_one_version_and_the_store_follows_the_host() {
    let defaults = UserDefaults(suiteName: "managed-\(UUID().uuidString)")!
    let store = ChatManagedAgentsStore(scope: "h:22", defaults: defaults)
    var version = ACPAgentVersion(agent: "codex", version: "2.3.0", managed: false, engine: "", previous: "", latest: "2.8.0",
      updateAvailable: true, error: "")
    XCTAssertFalse(store.isDismissed(version))
    store.dismiss(version)
    XCTAssertTrue(store.isDismissed(version))
    version.latest = "2.9.0"
    XCTAssertFalse(store.isDismissed(version), "a newer version shows again")
    var cli = version
    cli.kind = .cli
    cli.latest = "2.8.0"
    XCTAssertFalse(store.isDismissed(cli), "the CLI and the adapter are put off separately")
    store.record(.supported([:]))
    XCTAssertTrue(store.supported)
    store.record(.unsupported)
    XCTAssertFalse(store.supported)
  }

  func test_update_and_options_answers() {
    XCTAssertNil(ACPHostCommand.updateFailure(#"{"agent":"codex","from":"2.3.0","to":"2.8.0"}"# + "\n"))
    XCTAssertEqual(ACPHostCommand.updateFailure("tether: codex 2.9.0 did not start, kept 2.8.0: boom"),
      "codex 2.9.0 did not start, kept 2.8.0: boom")
    let options = ACPHostCommand.parseOptions(
      #"{"configOptions":[{"id":"model","name":"Model","type":"select","currentValue":"a","options":[{"value":"a","name":"A"},{"value":"b","name":"B"}]}]}"#)
    XCTAssertEqual(options?.first?.id, "model")
    XCTAssertEqual(options?.first?.choices.map(\.value), ["a", "b"])
    XCTAssertNil(ACPHostCommand.parseOptions("tether: agent exited before starting a session"))
  }
}
