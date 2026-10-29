#if DEBUG
import Foundation
import SwiftUI

/// The real terminal screen over canned host answers, so the session drawer can be shot without a host:
/// `TETHER_DEBUG_DRAWER=open|pick|chat|chat-open|newchat|agents-open` (`TETHER_DEBUG_THEME=<terminal theme id>` picks the theme) (see `SSHTerminalView.applyDebugDrawerMode`).
public struct DrawerFixtureRoot: View {
  @State private var controller: SSHTerminalController
  @State private var preferences = AppPreferences()

  public init() {
    let config = SSHConnectionConfig(host: "drawer.fixture", port: 22, username: "dev", credentials: [.password("fixture")])
    let store = FixtureHostKeys()
    let now = Int(Date().timeIntervalSince1970)
    if let theme = ProcessInfo.processInfo.environment["TETHER_DEBUG_THEME"] {
      MainActor.assumeIsolated { ChromeTheme.shared.apply(TerminalTheme.named(theme)) }
    }
    DrawerFixtureRoot.seedAgentOptions(config: config)
    let titles = ChatTitleStore(config: config)
    titles.set("Add retry with backoff to fetchJSON", for: "chat-a1b2c3")
    titles.clear("chat-d4e5f6")
    let ops = FixtureOps(now: now)
    let created = SSHTerminalController(
      title: "devbox", config: config, hostKeyStore: store, attach: "api",
      picked: ProcessInfo.processInfo.environment["TETHER_DEBUG_DRAWER"] != "pick",
      dial: { _, _ in FixtureTerminal() },
      control: ControlConnection(config: config, store: store) { ops })
    created.debugChatModel = { _ in ChatFixture.longModel() }
    _controller = State(initialValue: created)
  }

  /// The New chat sheet's Options row reads the stored defaults and the cached choices; Claude and Codex
  /// have some, opencode has none yet (the first-time note).
  private static func seedAgentOptions(config: SSHConnectionConfig) {
    guard ProcessInfo.processInfo.environment["TETHER_DEBUG_DRAWER"]?.hasPrefix("newchat") == true else { return }
    func choices(_ names: [(String, String)]) -> [ACPConfigChoice] {
      names.map { ACPConfigChoice(value: $0.0, name: $0.1, description: "") }
    }
    func option(_ id: String, _ name: String, current: String, _ list: [(String, String)]) -> ACPConfigOption {
      ACPConfigOption(id: id, name: name, description: "", category: id, currentValue: current, choices: choices(list))
    }
    let cache = ChatOptionsCache(config: config)
    cache.clear(agent: ChatAgents.opencode.key)
    cache.save(
      [
        option("model", "Model", current: "opus", [("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")]),
        option("effort", "Effort", current: "high", [("low", "Low"), ("medium", "Medium"), ("high", "High")]),
        option("mode", "Mode", current: "auto", [("default", "Manual"), ("plan", "Plan"), ("auto", "Auto")]),
      ], agent: ChatAgents.claude)
    cache.save(
      [
        option("model", "Model", current: "gpt-6-sol", [("gpt-6-sol", "gpt-6-sol"), ("gpt-6-mini", "gpt-6-mini")]),
        option("reasoning_effort", "Reasoning effort", current: "medium", [("low", "Low"), ("medium", "Medium"), ("high", "High")]),
        option("mode", "Mode", current: "agent", [("read-only", "Read only"), ("agent", "Agent")]),
      ], agent: ChatAgents.codex)
    let stored = ChatOptionDefaultsStore()
    for (id, value) in [("model", "opus"), ("effort", "high"), ("mode", "auto")] { stored.remember(agent: "claude", id: id, value: value) }
    for (id, value) in [("model", "gpt-6-sol"), ("reasoning_effort", "medium"), ("mode", "agent")] { stored.remember(agent: "codex", id: id, value: value) }
  }

  public var body: some View {
    SSHTerminalView(controller: controller, preferences: preferences, onHome: {})
      .tint(TetherColors.accent)
      .preferredColorScheme(ChromeTheme.shared.isLight ? .light : .dark)
  }
}

private final class FixtureHostKeys: HostKeyStore, @unchecked Sendable {
  func pinnedFingerprint(host: String, port: Int) -> String? { "FP:FIXTURE" }
  func pin(_ fingerprint: String, host: String, port: Int) {}
}

private struct FixtureTerminal: TerminalByteStream {
  private let sent = FixtureOnce()
  func read() async throws -> Data? {
    if sent.take() { return Data("dev@devbox:~/projects/api-server$ \u{1B}[32mgit status\u{1B}[0m\r\n".utf8) }
    try await Task.sleep(nanoseconds: 3_600_000_000_000)
    return nil
  }
  func write(_ bytes: Data) async throws {}
  func close() async {}
}

private final class FixtureOnce: @unchecked Sendable {
  private let lock = NSLock()
  private var done = false
  func take() -> Bool { lock.lock(); defer { lock.unlock() }; defer { done = true }; return !done }
}

private final class FixtureOps: SSHConnectionOps, @unchecked Sendable {
  let now: Int
  init(now: Int) { self.now = now }

  func connectAndHandshake() throws {}
  func hostKeyFingerprint() throws -> String { "FP:FIXTURE" }
  func authenticate(_ credential: SSHCredential) throws -> Bool { true }
  func openPTYChannel(cols: Int, rows: Int) throws -> any TerminalByteStream { FixtureTerminal() }
  func openExecChannel(command: String) throws -> any TerminalByteStream { FixtureTerminal() }
  func teardown() {}

  func exec(_ command: String) throws -> String {
    let env = ProcessInfo.processInfo.environment
    if command.contains("acp status") {
      if env["TETHER_DEBUG_CHAT_STATUS"] == "legacy" { return "tether: unknown acp command \"status\"" }
      func line(
        _ name: String, _ state: String, _ turn: String, _ title: String, _ cwd: String, _ age: Int,
        spawn: String? = nil, tasks: Int = 0
      ) -> String {
        var object: [String: Any] = [
          "name": name, "state": state, "turn": turn, "title": title, "cwd": cwd, "created": now - age,
          "logBytes": 48213, "endedReason": "",
        ]
        if let spawn { object["spawn"] = spawn }
        if tasks > 0 { object["tasks"] = tasks }
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        return String(decoding: data, as: UTF8.self)
      }
      if env["TETHER_DEBUG_DRAWER"]?.hasPrefix("agents") == true {
        return [
          line("chat-a1", "running", "working", "Release 6.3.1", "/home/dev/sites/tether", 600, spawn: ChatAgents.claude.spawn),
          line("chat-b2", "running", "waiting", "Fix the season-pack cleanup", "/home/dev/sites/rawkoon", 1800, spawn: ChatAgents.codex.spawn),
          line("chat-c3", "running", "idle", "Tidy the README", "/home/dev/sites/labby", 3600, spawn: ChatAgents.opencode.spawn, tasks: 1),
          line("chat-d4", "running", "idle", "Chat access across devices", "/home/dev/sites/tether", 7200, spawn: ChatAgents.claude.spawn),
          line("chat-e5", "ended", "idle", "Review PR 303", "/home/dev/sites/tether", 86400, spawn: ChatAgents.codex.spawn),
          line("chat-f6", "ended", "idle", "Draft the changelog", "/home/dev/sites/labby", 172800, spawn: ChatAgents.claude.spawn),
        ].joined(separator: "\n")
      }
      return [
        line("chat-a1b2c3", "running", "working", "", "/home/dev/projects/api-server", 600),
        line("chat-g7h8i9", "running", "waiting", "Migrate the docs site to the new theme", "/home/dev/projects/docs-site", 1800),
        line("chat-j0k1l2", "running", "idle", "Review the release checklist", "/home/dev/projects/tether", 3600),
        line("chat-d4e5f6", "ended", "idle", "", "/home/dev/projects/mobile-app", 86400),
      ].joined(separator: "\n")
    }
    if command.contains("acp sessions") {
      switch env["TETHER_DEBUG_DRAWER"] {
      case "newchat-continue-empty": return ""
      case "newchat-continue-error": return "tether: agent exited before listing sessions"
      default:
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        func entry(_ id: String, _ title: String, _ ago: Int) -> String {
          "{\"sessionId\":\"\(id)\",\"title\":\"\(title)\",\"updatedAt\":\"\(iso.string(from: Date(timeIntervalSince1970: TimeInterval(now - ago))))\",\"cwd\":\"/home/dev/projects/api-server\"}"
        }
        return [
          entry("s-1", "Add retry with backoff to fetchJSON", env["TETHER_DEBUG_DRAWER"] == "newchat-continue-recent" ? 240 : 7200),
          entry("s-2", "Fix flaky pagination test", 86400 * 2),
          entry("s-3", "", 86400 * 9),
          entry("s-4", "Explain the cache invalidation path", 86400 * 30),
        ].joined(separator: "\n")
      }
    }
    if command.contains("acp ls") {
      return [
        "chat-a1b2c3\trunning\t48213\t/home/dev/projects/api-server\t\(now - 600)\tclaude",
        "chat-d4e5f6\tended\t9120\t/home/dev/projects/mobile-app\t\(now - 86400)\tclaude",
      ].joined(separator: "\n")
    }
    if command.contains("zmx") && command.hasSuffix(" ls") {
      return [
        ("api", "/home/dev/projects/api-server", 1), ("default", "/home/dev", 0),
        ("tether", "/home/dev/projects/tether", 0),
      ].map { "name=\($0.0)\tpid=1\tclients=\($0.2)\tcreated=\(now - 9000)\tcwd=file://devbox\($0.1)" }
        .joined(separator: "\n")
    }
    if command.contains("status") {
      return """
        [{"session":"api","agent":"claude","state":"working","since":\(now - 120),"updated":\(now)},
        {"session":"tether","agent":"claude","state":"waiting","since":\(now - 300),"updated":\(now - 300)}]
        """
    }
    return ""
  }
}
#endif
