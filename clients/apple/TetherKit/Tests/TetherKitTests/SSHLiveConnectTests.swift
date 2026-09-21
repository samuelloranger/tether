import Foundation
import XCTest
@testable import TetherKit

/// Live end-to-end proof of the real connector against a real host. Skipped
/// unless the environment supplies a target and credential, so it never runs in
/// CI. Exercises the shipping API — `SSHConnector.connect` → `TerminalByteStream`
/// — not throwaway probe code.
///
/// Required env: TETHER_SSH_HOST, TETHER_SSH_USER, and one of TETHER_SSH_PASSWORD
/// or TETHER_SSH_KEY_PEM. Optional: TETHER_SSH_PORT (default 22),
/// TETHER_SSH_ATTACH (zmx session name; when set, the connector attaches to it).
final class SSHLiveConnectTests: XCTestCase {
  func test_live_connector_reaches_a_shell_and_runs_a_command() async throws {
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

    let marker = "TETHER_SSH_LIVE_\(Int.random(in: 1000...9999))"
    if let attach = env["TETHER_SSH_ATTACH"] {
      try await stream.write(Data("~/.local/bin/zmx attach \(attach)\n".utf8))
    }
    try await stream.write(Data("printf '%s\\n' \(marker)\n".utf8))

    let deadline = Date().addingTimeInterval(15)
    var seen = ""
    while Date() < deadline {
      guard let chunk = try await stream.read() else { break }
      seen += String(decoding: chunk, as: UTF8.self)
      if seen.contains(marker) { break }
    }
    await stream.close()

    XCTAssertTrue(seen.contains(marker), "did not observe the echoed marker over the live PTY")
  }
}
