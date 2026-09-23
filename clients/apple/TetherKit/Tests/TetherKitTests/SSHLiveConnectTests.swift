import Foundation
import XCTest
@testable import TetherKit

/// Skipped unless TETHER_SSH_HOST, TETHER_SSH_USER and TETHER_SSH_PASSWORD or _KEY_PEM are set.
/// Optional: TETHER_SSH_PORT, TETHER_SSH_ATTACH (zmx session to attach).
final class SSHLiveConnectTests: XCTestCase {
  func test_live_connector_reaches_a_shell_and_runs_a_command() async throws {
    let stream = try await connectLive()
    let marker = "TETHER_SSH_LIVE_\(Int.random(in: 1000...9999))"
    try await stream.write(Data("printf '%s\\n' \(marker)\n".utf8))
    try await drain(stream, until: marker, timeout: 15)
    await stream.close()
  }

  /// Each probe sleeps first so the pump is idle when input arrives; the line's own echo carries
  /// the marker, so this times keys → host → screen.
  func test_live_idle_keystroke_round_trip_is_not_held_by_the_pump() async throws {
    let stream = try await connectLive()
    let ready = "TETHER_READY_\(Int.random(in: 1000...9999))"
    try await stream.write(Data("printf '%s\\n' \(ready)\n".utf8))
    try await drain(stream, until: ready, timeout: 15)

    var worst: TimeInterval = 0
    for probe in 0..<5 {
      try await Task.sleep(nanoseconds: 1_500_000_000)
      let marker = "TETHER_RTT_\(probe)_\(Int.random(in: 1000...9999))"
      let start = Date()
      try await stream.write(Data("printf '%s\\n' \(marker)\n".utf8))
      try await drain(stream, until: marker, timeout: 5)
      worst = max(worst, Date().timeIntervalSince(start))
    }
    await stream.close()
    XCTAssertLessThan(worst, 0.4, "worst idle round trip \(worst)s")
  }

  private func connectLive() async throws -> any TerminalByteStream {
    let env = ProcessInfo.processInfo.environment
    guard let host = env["TETHER_SSH_HOST"], let user = env["TETHER_SSH_USER"] else {
      throw XCTSkip("Set TETHER_SSH_HOST/USER (+ password or key) to run the live SSH proof.")
    }
    let port = env["TETHER_SSH_PORT"].flatMap(Int.init) ?? 22
    let credential: SSHCredential
    if let pw = env["TETHER_SSH_PASSWORD"] {
      credential = .password(pw)
    } else if let pem = env["TETHER_SSH_KEY_PEM"] {
      credential = .privateKey(pem: pem, passphrase: env["TETHER_SSH_KEY_PASSPHRASE"])
    } else if let b64 = env["TETHER_SSH_KEY_PEM_B64"],
              let data = Data(base64Encoded: b64),
              let pem = String(data: data, encoding: .utf8) {
      // A base64 wrapper so a multiline PEM survives command-line env injection.
      credential = .privateKey(pem: pem, passphrase: env["TETHER_SSH_KEY_PASSPHRASE"])
    } else {
      throw XCTSkip("Set TETHER_SSH_PASSWORD or TETHER_SSH_KEY_PEM for the live SSH proof.")
    }
    let config = SSHConnectionConfig(
      host: host, port: port, username: user, credentials: [credential], cols: 80, rows: 24
    )
    // A throwaway store so the first-connect TOFU pin never touches real defaults.
    let store = UserDefaultsHostKeyStore(defaults: UserDefaults(suiteName: "ssh.live.\(UUID().uuidString)")!)
    let stream = try await SSHConnector.connect(config: config, store: store)
    if let attach = env["TETHER_SSH_ATTACH"] {
      try await stream.write(Data("~/.local/bin/zmx attach \(attach)\n".utf8))
    }
    return stream
  }

  private func drain(_ stream: any TerminalByteStream, until needle: String, timeout: TimeInterval) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    var seen = ""
    while Date() < deadline {
      guard let chunk = try await stream.read() else { break }
      seen += String(decoding: chunk, as: UTF8.self)
      if seen.contains(needle) { return }
    }
    XCTFail("did not observe \(needle) within \(timeout)s over the live PTY")
  }
}
