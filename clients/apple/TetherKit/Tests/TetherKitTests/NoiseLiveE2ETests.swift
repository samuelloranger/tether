import XCTest

import TetherFFIBindings
@testable import TetherKit

/// Accepts the server's self-signed TLS cert. Trust here is redundant: the Noise
/// handshake authenticates the server by its pinned static key, and TLS is only
/// present to satisfy iOS App Transport Security (which blocks cleartext ws://).
private final class InsecureTrustDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
  private func accept(
    _ challenge: URLAuthenticationChallenge,
    _ completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    if let trust = challenge.protectionSpace.serverTrust {
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
      completionHandler(.performDefaultHandling, nil)
    }
  }
  // Session-level (most challenges) and task-level (URLSessionWebSocketTask
  // delivers the server-trust challenge here) — implement both.
  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) { accept(challenge, completionHandler) }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) { accept(challenge, completionHandler) }
}

/// Live end-to-end test: a real Swift Noise client pairs, reconnects, and runs a
/// shell command against a REAL running tether server over the network.
///
/// Skipped unless `TETHER_E2E_URL` (e.g. http://192.168.50.30:8199) and
/// `TETHER_E2E_CODE` (a fresh `tether pair` code, with the host set to
/// auto-confirm) are both set. This is orchestrated from outside (a server +
/// auto-confirm helper on the host); the test only drives the client side.
final class NoiseLiveE2ETests: XCTestCase {
  func testLivePairReconnectShell() async throws {
    let env = ProcessInfo.processInfo.environment
    guard let urlStr = env["TETHER_E2E_URL"], let code = env["TETHER_E2E_CODE"],
      let url = URL(string: urlStr)
    else {
      throw XCTSkip("set TETHER_E2E_URL + TETHER_E2E_CODE to run the live E2E")
    }

    let hostId = "e2e-\(UUID().uuidString)"
    // TLS (wss) to satisfy ATS; the delegate accepts the self-signed cert.
    let urlSession = URLSession(
      configuration: .ephemeral, delegate: InsecureTrustDelegate(), delegateQueue: nil)
    let client = NoiseSessionClient(keyStore: FakeNoiseKeyStore(), session: urlSession)

    // Pair: XXpsk2 over /api/noise/pair (host auto-confirms out of band).
    let serverPub = try await client.pair(hostId: hostId, url: url, code: code)
    XCTAssertEqual(serverPub.count, 32, "pinned server key should be 32 bytes")

    // Reconnect: IK over /api/noise/session, authorized against the registry.
    let channel = try await client.reconnect(hostId: hostId, url: url)
    let sid = "ios-e2e-session"
    try await channel.sendStart(id: sid)
    try await Task.sleep(nanoseconds: 500_000_000)
    try await channel.sendInput(id: sid, text: "echo hello-ios-e2e-marker\n")

    // Read sealed output frames until the marker shows up.
    let deadline = Date().addingTimeInterval(12)
    var sawMarker = false
    while Date() < deadline {
      let msg = try await channel.receive()
      if case let .output(_, chunk) = msg, chunk.contains("hello-ios-e2e-marker") {
        sawMarker = true
        break
      }
    }
    await channel.close()
    XCTAssertTrue(sawMarker, "never saw the shell output over the Noise session")
  }

  /// Stage-1 live E2E: proves the FULL client chain the app uses — pair under a
  /// throwaway id, PERSIST a real Noise `HostProfile` via `SessionStore`
  /// (migrating the keys onto the profile id), then reconnect BY THE PROFILE ID
  /// and stream a shell marker. Same env gate as above; the `SessionStore` shares
  /// the client's key store so the migrated keys are what reconnect reads.
  @MainActor
  func testLivePairPersistThenStreamOverNoise() async throws {
    let env = ProcessInfo.processInfo.environment
    guard let urlStr = env["TETHER_E2E_URL"], let code = env["TETHER_E2E_CODE"],
      let url = URL(string: urlStr)
    else {
      throw XCTSkip("set TETHER_E2E_URL + TETHER_E2E_CODE to run the live E2E")
    }

    let keys = FakeNoiseKeyStore()
    let urlSession = URLSession(
      configuration: .ephemeral, delegate: InsecureTrustDelegate(), delegateQueue: nil)
    let client = NoiseSessionClient(keyStore: keys, session: urlSession)
    let store = SessionStore(
      hostStore: HostStoreAdapter(storage: LiveInMemoryHostStorage()),
      noiseKeyStore: keys)

    // 1. Pair under a throwaway id — exactly what PairDeviceView leaves behind.
    let pairId = "pair-\(UUID().uuidString)"
    let serverPub = try await client.pair(hostId: pairId, url: url, code: code)
    XCTAssertEqual(serverPub.count, 32, "pinned server key should be 32 bytes")

    // 2. Persist a real Noise HostProfile — migrates the keys onto the profile id.
    let profile = try store.createNoiseHost(
      name: "E2E box", host: url.host ?? "", port: "\(url.port ?? 8443)", pairHostId: pairId)

    // 3. Reconnect BY THE PERSISTED PROFILE ID (proves the migration) and stream.
    let channel = try await client.reconnect(hostId: profile.id, url: url)
    let sid = "ios-stage1-session"
    try await channel.sendStart(id: sid)
    try await Task.sleep(nanoseconds: 500_000_000)
    try await channel.sendInput(id: sid, text: "echo stage1-persist-marker\n")

    let deadline = Date().addingTimeInterval(12)
    var sawMarker = false
    while Date() < deadline {
      let msg = try await channel.receive()
      if case let .output(_, chunk) = msg, chunk.contains("stage1-persist-marker") {
        sawMarker = true
        break
      }
    }
    await channel.close()
    XCTAssertTrue(sawMarker, "never saw shell output after reconnecting by the persisted profile id")
  }
}

extension NoiseLiveE2ETests {
  /// Live device-management E2E: pair, list devices over the authenticated Noise
  /// session (see THIS device with isSelf), revoke it, and prove the revoke took
  /// effect — a fresh reconnect is refused (fail-closed) because the registry no
  /// longer knows the key. Same env gate as the others.
  func testLiveListThenSelfRevoke() async throws {
    let env = ProcessInfo.processInfo.environment
    guard let urlStr = env["TETHER_E2E_URL"], let code = env["TETHER_E2E_CODE"],
      let url = URL(string: urlStr)
    else {
      throw XCTSkip("set TETHER_E2E_URL + TETHER_E2E_CODE to run the live E2E")
    }

    let keys = FakeNoiseKeyStore()
    let urlSession = URLSession(
      configuration: .ephemeral, delegate: InsecureTrustDelegate(), delegateQueue: nil)
    let client = NoiseSessionClient(keyStore: keys, session: urlSession)
    let hostId = "devmgmt-\(UUID().uuidString)"

    _ = try await client.pair(hostId: hostId, url: url, code: code)

    // List over a management session — this device should be present + isSelf.
    let channel = try await client.reconnect(hostId: hostId, url: url)
    try await channel.sendDevicesList()
    var roster: [DeviceInfo] = []
    let listDeadline = Date().addingTimeInterval(8)
    while Date() < listDeadline {
      if case let .devices(items) = try await channel.receive() {
        roster = items
        break
      }
    }
    let mine = roster.first(where: { $0.isSelf })
    XCTAssertNotNil(mine, "devices.list should include this device with isSelf")

    // Revoke this device and confirm the server acks ok.
    try await channel.sendDevicesRevoke(target: mine!.id)
    var revoked = false
    let revDeadline = Date().addingTimeInterval(8)
    while Date() < revDeadline {
      if case let .devicesRevoked(target, ok, _) = try await channel.receive(), target == mine!.id {
        revoked = ok
        break
      }
    }
    await channel.close()
    XCTAssertTrue(revoked, "server should ack the revoke ok")

    // The revoke must have taken effect. The server authorizes AFTER the IK
    // handshake, so a fresh reconnect may hand back a channel — but it can carry
    // no app data: the server drops the now-unknown device before any sealed
    // exchange. So using the channel must fail (fail-closed).
    do {
      let dead = try await client.reconnect(hostId: hostId, url: url)
      try await dead.sendDevicesList()
      _ = try await dead.receive()
      await dead.close()
      XCTFail("a revoked device must not be able to use a Noise session")
    } catch {
      // expected — the unauthorized device's session is dropped
    }
  }
}

/// In-memory `HostStorage` double for the live test (file-scoped; a sibling of
/// the one in NoiseHostPersistenceTests).
private final class LiveInMemoryHostStorage: HostStorage {
  private var items: [String: String] = [:]
  func getItem(key: String) throws -> String? { items[key] }
  func setItem(key: String, value: String) throws { items[key] = value }
  func removeItem(key: String) throws { items[key] = nil }
}
