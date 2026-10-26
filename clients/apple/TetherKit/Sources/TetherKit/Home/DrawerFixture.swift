#if DEBUG
import Foundation
import SwiftUI

/// The real terminal screen over canned host answers, so the session drawer can be shot without a host:
/// `TETHER_DEBUG_DRAWER=open|chat|chat-open|newchat` (see `SSHTerminalView.applyDebugDrawerMode`).
public struct DrawerFixtureRoot: View {
  @State private var controller: SSHTerminalController
  @State private var preferences = AppPreferences()

  public init() {
    let config = SSHConnectionConfig(host: "drawer.fixture", port: 22, username: "dev", credentials: [.password("fixture")])
    let store = FixtureHostKeys()
    let now = Int(Date().timeIntervalSince1970)
    let titles = ChatTitleStore(config: config)
    titles.set("Add retry with backoff to fetchJSON", for: "chat-a1b2c3")
    titles.clear("chat-d4e5f6")
    let ops = FixtureOps(now: now)
    let created = SSHTerminalController(
      title: "devbox", config: config, hostKeyStore: store, attach: "api",
      choosesInitialSession: false,
      dial: { _, _ in FixtureTerminal() },
      control: ControlConnection(config: config, store: store) { ops })
    created.debugChatModel = { _ in ChatFixture.longModel() }
    _controller = State(initialValue: created)
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
      if env["TETHER_DEBUG_CHAT_STATUS"] == "legacy" { return "tether-notify: unknown acp command \"status\"" }
      func line(_ name: String, _ state: String, _ turn: String, _ title: String, _ cwd: String, _ age: Int) -> String {
        "{\"name\":\"\(name)\",\"state\":\"\(state)\",\"turn\":\"\(turn)\",\"title\":\"\(title)\",\"cwd\":\"\(cwd)\",\"created\":\(now - age),\"logBytes\":48213,\"endedReason\":\"\"}"
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
      case "newchat-continue-error": return "tether-notify: agent exited before listing sessions"
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
        {"session":"tether","agent":"claude","state":"done","since":\(now - 25200),"updated":\(now - 25200)}]
        """
    }
    return ""
  }
}
#endif
