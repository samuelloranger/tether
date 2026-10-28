import Foundation
import XCTest
@testable import TetherKit

/// Session switching against a real sshd + zmx host. Skipped unless TETHER_SSH_HOST,
/// TETHER_SSH_USER and TETHER_SSH_KEY_PEM_B64 are set (optional TETHER_SSH_PORT). Use a
/// throwaway host: the test creates and switches between its own sessions there.
@MainActor
final class SSHLiveSessionSwitchTests: XCTestCase {
  private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func increment() { lock.lock(); value += 1; lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
  }

  private func liveConfig() throws -> SSHConnectionConfig {
    let env = ProcessInfo.processInfo.environment
    guard let host = env["TETHER_SSH_HOST"], let user = env["TETHER_SSH_USER"],
          let b64 = env["TETHER_SSH_KEY_PEM_B64"], let data = Data(base64Encoded: b64),
          let pem = String(data: data, encoding: .utf8)
    else { throw XCTSkip("Set TETHER_SSH_HOST/USER/KEY_PEM_B64 to run the live switch test.") }
    let port = env["TETHER_SSH_PORT"].flatMap(Int.init) ?? 22
    return SSHConnectionConfig(host: host, port: port, username: user, credentials: [.privateKey(pem: pem, passphrase: nil)])
  }

  private func waitUntil(_ timeout: TimeInterval, _ condition: () async -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if await condition() { return true }
      try? await Task.sleep(nanoseconds: 200_000_000)
    }
    return await condition()
  }

  /// Taps in the session list as fast as a thumb goes: each switch must be typed into the
  /// connection already open, land in the login shell rather than inside a session, and
  /// leave only the last session attached.
  func test_rapid_switches_type_into_the_open_connection_and_never_redial() async throws {
    let config = try liveConfig()
    let store = UserDefaultsHostKeyStore(defaults: UserDefaults(suiteName: "ssh.live.\(UUID().uuidString)")!)
    let dials = Counter()
    let controller = SSHTerminalController(
      title: "live", config: config, hostKeyStore: store, attach: "sw-a",
      dial: { config, store in
        dials.increment()
        return try await SSHConnector.connect(config: config, store: store)
      })
      .creating("sw-a", "sw-b", "sw-c")
    await controller.connect()
    XCTAssertEqual(controller.status, .connected)
    let attachedFirst = await waitUntil(10) {
      await controller.refreshSessions()
      return controller.sessions.first { $0.name == "sw-a" }?.clients == 1
    }
    XCTAssertTrue(attachedFirst, "the first attach never registered")

    // Anything that takes the terminal off `.connected` is what makes a switch redial.
    var drops: [String] = []
    let watcher = Task { @MainActor in
      while !Task.isCancelled {
        if controller.status != .connected { drops.append("\(controller.status)") }
        try? await Task.sleep(nanoseconds: 10_000_000)
      }
    }
    for gap: UInt64 in [40, 120, 260] {
      let targets = ["sw-b", "sw-c", "sw-a", "sw-b", "sw-c"]
      var taps: [Task<Void, Never>] = []
      for name in targets {
        taps.append(Task { await controller.switchSession(to: name) })
        try await Task.sleep(nanoseconds: gap * 1_000_000)
      }
      for tap in taps { await tap.value }
      let settled = await waitUntil(10) {
        await controller.refreshSessions()
        return controller.sessions.filter { $0.clients > 0 }.map(\.name) == ["sw-c"]
      }
      let attached = controller.sessions.filter { $0.clients > 0 }.map { "\($0.name)×\($0.clients)" }
      XCTAssertTrue(settled, "\(gap) ms taps: attached afterwards \(attached), wanted only sw-c")
      XCTAssertEqual(controller.attach, "sw-c")
      // Back to a known start for the next round.
      await controller.switchSession(to: "sw-a")
      _ = await waitUntil(10) {
        await controller.refreshSessions()
        return controller.sessions.filter { $0.clients > 0 }.map(\.name) == ["sw-a"]
      }
    }
    watcher.cancel()
    XCTAssertEqual(dials.count, 1, "the switches redialed instead of typing into the open connection")
    XCTAssertEqual(drops, [], "the terminal left .connected during the switches")
    XCTAssertEqual(controller.status, .connected)

    // A switch typed while a session still held the keyboard lands inside that session.
    let control = ControlConnection(config: config, store: store)
    for session in controller.sessions {
      let history = (try? await control.exec("\(SSHTerminalController.zmx) history \(shellQuote(session.name))")) ?? ""
      XCTAssertFalse(history.contains("zmx attach"), "a switch was typed into session \(session.name):\n\(history.suffix(400))")
    }
    await control.close()
    await controller.leave()
  }
}
