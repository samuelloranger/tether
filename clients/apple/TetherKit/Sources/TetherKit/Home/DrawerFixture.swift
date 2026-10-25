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
