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
      name: "E2E box", host: url.host ?? "", port: "\(url.port ?? 8443)",
      pairHostId: pairId, scheme: "https")

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
  /// #175 regression: after A→B→A the reused live socket must still reach A's PTY.
  @MainActor
  func testSwitchBackToPriorTerminalStillAcceptsInput() async throws {
    let (client, store, profile, url) = try await liveSetup()
    let suffix = UUID().uuidString.prefix(8)
    let sidA = "switchback-A-\(suffix)"
    let sidB = "switchback-B-\(suffix)"
    let beforeMarker = "AAAA-before-\(suffix)"
    let afterMarker = "AAAA-after-\(suffix)"

    // Long enough for the handshake to authorize before the next switch cancels it.
    let settle: UInt64 = 5_000_000_000

    await store.selectSession(hostId: profile.id, sessionId: sidA)
    try await Task.sleep(nanoseconds: settle)
    store.sendInput("echo \(beforeMarker)\n")
    try await Task.sleep(nanoseconds: 1_000_000_000)

    await store.selectSession(hostId: profile.id, sessionId: sidB)
    try await Task.sleep(nanoseconds: settle)
    store.sendInput("echo BBBB-\(suffix)\n")
    try await Task.sleep(nanoseconds: 1_000_000_000)

    await store.selectSession(hostId: profile.id, sessionId: sidA)
    try await Task.sleep(nanoseconds: settle)
    store.sendInput("echo \(afterMarker)\n")
    try await Task.sleep(nanoseconds: 2_000_000_000)

    let found = try await replayMarkers(
      client, url: url, hostId: profile.id, sessionId: sidA, want: [beforeMarker, afterMarker])
    XCTAssertTrue(found.contains(beforeMarker), "control: input before the switch never reached A's PTY")
    XCTAssertTrue(
      found.contains(afterMarker),
      "REGRESSION: input typed after switching back to A never reached A's PTY")
  }

  /// Isolation: one store terminal, no switching, connects and takes input.
  @MainActor
  func testSingleTerminalViaStoreAcceptsInput() async throws {
    let (client, store, profile, url) = try await liveSetup()
    let suffix = UUID().uuidString.prefix(8)
    let sid = "single-\(suffix)"
    let marker = "SINGLE-\(suffix)"
    await store.selectSession(hostId: profile.id, sessionId: sid)
    try await Task.sleep(nanoseconds: 8_000_000_000)
    store.sendInput("echo \(marker)\n")
    try await Task.sleep(nanoseconds: 2_000_000_000)

    let found = try await replayMarkers(
      client, url: url, hostId: profile.id, sessionId: sid, want: [marker])
    XCTAssertTrue(
      found.contains(marker), "single store terminal never delivered input to its PTY")
  }

  /// #175 dead-socket bug: if A's background socket drops, switch-back must
  /// reconnect (not reuse the corpse) and still take input. The harness restarts
  /// the server during the window once A+B have authorized; holders survive.
  @MainActor
  func testSwitchBackAfterSocketDropStillAcceptsInput() async throws {
    let (client, store, profile, url) = try await liveSetup()
    let suffix = UUID().uuidString.prefix(8)
    let sidA = "drop-A-\(suffix)"
    let sidB = "drop-B-\(suffix)"
    let beforeMarker = "DROP-before-\(suffix)"
    let afterMarker = "DROP-after-\(suffix)"
    let settle: UInt64 = 5_000_000_000

    await store.selectSession(hostId: profile.id, sessionId: sidA)
    try await Task.sleep(nanoseconds: settle)
    store.sendInput("echo \(beforeMarker)\n")
    try await Task.sleep(nanoseconds: 1_000_000_000)

    await store.selectSession(hostId: profile.id, sessionId: sidB)
    try await Task.sleep(nanoseconds: settle)

    // Window for the harness to restart the server, dropping A's socket.
    try await Task.sleep(nanoseconds: 20_000_000_000)

    await store.selectSession(hostId: profile.id, sessionId: sidA)
    try await Task.sleep(nanoseconds: settle)
    store.sendInput("echo \(afterMarker)\n")
    try await Task.sleep(nanoseconds: 2_000_000_000)

    let found = try await replayMarkers(
      client, url: url, hostId: profile.id, sessionId: sidA, want: [beforeMarker, afterMarker])
    XCTAssertTrue(found.contains(beforeMarker), "control: input before the drop never reached A's PTY")
    XCTAssertTrue(
      found.contains(afterMarker),
      "REGRESSION: after a background socket drop, switch-back reused the dead socket "
        + "and the keystroke was lost")
  }

  /// Pairs once per process (argon2 is slow, the code is single-use) and caches
  /// the device identity; later tests reseed those bytes and skip pairing since
  /// the server's registry persists the device. Fresh store + host per test.
  /// `scheme: "https"` so the store dials `wss` — `HostScheme.resolve` maps 8543
  /// to `ws://` otherwise.
  @MainActor
  func liveSetup() async throws -> (
    client: NoiseSessionClient, store: SessionStore, profile: HostProfileModel, url: URL
  ) {
    let env = ProcessInfo.processInfo.environment
    guard let urlStr = env["TETHER_E2E_URL"], let code = env["TETHER_E2E_CODE"],
      let url = URL(string: urlStr)
    else {
      throw XCTSkip("set TETHER_E2E_URL + TETHER_E2E_CODE to run the live E2E")
    }
    let identity = try await Self.pairedKeys.resolve {
      let seedKeys = FakeNoiseKeyStore()
      let seedSession = URLSession(
        configuration: .ephemeral, delegate: InsecureTrustDelegate(), delegateQueue: nil)
      let seedClient = NoiseSessionClient(keyStore: seedKeys, session: seedSession)
      let seedId = "pairseed-\(UUID().uuidString)"
      _ = try await seedClient.pair(hostId: seedId, url: url, code: code)
      guard let device = (try? seedKeys.loadDevicePrivateKey(hostId: seedId)) ?? nil,
        let server = (try? seedKeys.loadServerPublicKey(hostId: seedId)) ?? nil
      else { throw NoiseHostError.missingPairedKeys }
      return DeviceIdentity(device: device, server: server)
    }

    let keys = FakeNoiseKeyStore()
    let pairId = "seeded-\(UUID().uuidString)"
    try keys.saveDevicePrivateKey(identity.device, hostId: pairId)
    try keys.saveServerPublicKey(identity.server, hostId: pairId)
    let urlSession = URLSession(
      configuration: .ephemeral, delegate: InsecureTrustDelegate(), delegateQueue: nil)
    let client = NoiseSessionClient(keyStore: keys, session: urlSession)
    let store = SessionStore(
      hostStore: HostStoreAdapter(storage: LiveInMemoryHostStorage()), noiseKeyStore: keys)
    let profile = try store.createNoiseHost(
      name: "E2E box", host: url.host ?? "", port: "\(url.port ?? 8443)",
      pairHostId: pairId, scheme: "https")
    return (client, store, profile, url)
  }

  /// Rapid round-robin: each keystroke reaches the tab active when typed, never
  /// the one that replaced it. Guards the `key` stamp / `stillCurrent` drop.
  @MainActor
  func testRapidSwitchDeliversInputToActiveSessionOnly() async throws {
    let (client, store, profile, url) = try await liveSetup()
    let suffix = UUID().uuidString.prefix(6)
    let sids = ["rapA", "rapB", "rapC"].map { "\($0)-\(suffix)" }
    for s in sids {
      await store.selectSession(hostId: profile.id, sessionId: s)
      try await Task.sleep(nanoseconds: 5_000_000_000)
    }
    var expected: [String: Set<String>] = [:]
    for round in 0..<6 {
      let s = sids[round % sids.count]
      await store.selectSession(hostId: profile.id, sessionId: s)
      try await Task.sleep(nanoseconds: 3_000_000_000)
      let m = "RAPID-\(round)-\(suffix)"
      store.sendInput("echo \(m)\n")
      expected[s, default: []].insert(m)
      try await Task.sleep(nanoseconds: 800_000_000)
    }
    try await Task.sleep(nanoseconds: 2_000_000_000)
    let all = Set(expected.values.flatMap { $0 })
    for s in sids {
      let mine = expected[s] ?? []
      let found = try await replayMarkers(
        client, url: url, hostId: profile.id, sessionId: s, want: Array(all), timeout: 8)
      XCTAssertTrue(mine.isSubset(of: found), "session \(s) lost its own input: want \(mine) got \(found)")
      let foreign = found.intersection(all.subtracting(mine))
      XCTAssertTrue(foreign.isEmpty, "session \(s) received another session's input: \(foreign)")
    }
  }

  /// A drop that backgrounds MULTIPLE terminals: each reconnects on switch-back.
  @MainActor
  func testMultipleDroppedTerminalsEachReconnect() async throws {
    let (client, store, profile, url) = try await liveSetup()
    let suffix = UUID().uuidString.prefix(6)
    let sids = ["mdropA", "mdropB", "mdropC"].map { "\($0)-\(suffix)" }
    for s in sids {
      await store.selectSession(hostId: profile.id, sessionId: s)
      try await Task.sleep(nanoseconds: 5_000_000_000)
    }
    // Window for the harness to restart the server (all three authorized).
    try await Task.sleep(nanoseconds: 20_000_000_000)
    var markers: [String: String] = [:]
    for s in sids {
      await store.selectSession(hostId: profile.id, sessionId: s)
      try await Task.sleep(nanoseconds: 5_000_000_000)
      let m = "MDROP-\(s)"
      store.sendInput("echo \(m)\n")
      markers[s] = m
      try await Task.sleep(nanoseconds: 1_000_000_000)
    }
    try await Task.sleep(nanoseconds: 2_000_000_000)
    for s in sids {
      let found = try await replayMarkers(
        client, url: url, hostId: profile.id, sessionId: s, want: [markers[s]!], timeout: 10)
      XCTAssertTrue(
        found.contains(markers[s]!),
        "dropped terminal \(s) did not reconnect on switch-back; keystroke lost")
    }
  }

  /// Killing a background session must not disturb input to the active one.
  @MainActor
  func testKillingBackgroundSessionLeavesActiveInputIntact() async throws {
    let (client, store, profile, url) = try await liveSetup()
    let suffix = UUID().uuidString.prefix(6)
    let sidA = "killkeepA-\(suffix)"
    let sidB = "killkeepB-\(suffix)"
    let marker = "KILLKEEP-\(suffix)"
    await store.selectSession(hostId: profile.id, sessionId: sidA)
    try await Task.sleep(nanoseconds: 5_000_000_000)
    await store.selectSession(hostId: profile.id, sessionId: sidB)
    try await Task.sleep(nanoseconds: 5_000_000_000)
    await store.selectSession(hostId: profile.id, sessionId: sidA)
    try await Task.sleep(nanoseconds: 3_000_000_000)
    await store.killSession(id: sidB, hostId: profile.id)
    try await Task.sleep(nanoseconds: 1_000_000_000)
    store.sendInput("echo \(marker)\n")
    try await Task.sleep(nanoseconds: 2_000_000_000)
    let found = try await replayMarkers(
      client, url: url, hostId: profile.id, sessionId: sidA, want: [marker], timeout: 10)
    XCTAssertTrue(
      found.contains(marker), "killing background B broke input to the active session A")
  }

  /// The render half of the bug, end-to-end: A with output → open a NEW terminal
  /// B → switch back to A. The surface (store.terminalSnapshot) must re-publish
  /// A's grid, not stay on B's stale frame. Exercises the real switch path
  /// (newTerminal + selectSession + observe re-bind + setRendering re-emit).
  @MainActor
  func testSwitchBackRepublishesResidentGrid() async throws {
    let (_, store, profile, _) = try await liveSetup()
    let suffix = UUID().uuidString.prefix(6)
    let markerA = "GRIDA-\(suffix)"
    let markerB = "GRIDB-\(suffix)"
    let sidA = "grid-A-\(suffix)"

    await store.selectSession(hostId: profile.id, sessionId: sidA)
    try await Task.sleep(nanoseconds: 5_000_000_000)
    store.sendInput("echo \(markerA)\n")
    try await Task.sleep(nanoseconds: 2_000_000_000)
    XCTAssertTrue(
      gridText(store.terminalSnapshot).contains(markerA), "A's own output should be on screen")

    await store.newTerminal(hostId: profile.id)
    try await Task.sleep(nanoseconds: 5_000_000_000)
    store.sendInput("echo \(markerB)\n")
    try await Task.sleep(nanoseconds: 2_000_000_000)
    XCTAssertTrue(gridText(store.terminalSnapshot).contains(markerB), "B's grid should be showing")

    await store.selectSession(hostId: profile.id, sessionId: sidA)
    try await Task.sleep(nanoseconds: 2_000_000_000)
    let shown = gridText(store.terminalSnapshot)
    XCTAssertTrue(
      shown.contains(markerA),
      "REGRESSION: switch-back did not re-publish A's grid — surface stuck on the previous tab")
    XCTAssertFalse(shown.contains(markerB), "switch-back is still showing B's frame")
  }

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

extension NoiseLiveE2ETests {
  /// Which of `want` appear in the channel's output. Each `receive()` is raced
  /// against the remaining budget so a quiet channel can't hang past `timeout`.
  func scanMarkers(
    on channel: NoiseChannel, want: [String], timeout: TimeInterval
  ) async -> Set<String> {
    var found: Set<String> = []
    let deadline = Date().addingTimeInterval(timeout)
    while found.count < want.count {
      let remaining = deadline.timeIntervalSinceNow
      guard remaining > 0 else { break }
      let msg: NoiseServerMessage? = await withTaskGroup(of: NoiseServerMessage?.self) { group in
        group.addTask { try? await channel.receive() }
        group.addTask {
          try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
          return nil
        }
        let first = await group.next() ?? nil
        group.cancelAll()
        return first
      }
      guard let msg else { break }
      if case let .output(_, chunk) = msg {
        for m in want where chunk.contains(m) { found.insert(m) }
      }
    }
    return found
  }

  /// Visible text of a packed grid snapshot — asserts WHICH session's frame the
  /// surface is showing.
  func gridText(_ data: Data?) -> String {
    guard let data, let (_, cells) = try? GridSnapshotDecoder.decode(data) else { return "" }
    return String(
      String.UnicodeScalarView(
        cells.compactMap { $0.codepoint == 0 ? nil : Unicode.Scalar($0.codepoint) }))
  }

  /// Fresh channel, full replay (`sinceId: 0`) — the independent oracle for "did
  /// input actually reach the PTY", separate from anything the store cached.
  func replayMarkers(
    _ client: NoiseSessionClient, url: URL, hostId: String, sessionId: String,
    want: [String], timeout: TimeInterval = 14
  ) async throws -> Set<String> {
    let channel = try await client.reconnect(hostId: hostId, url: url)
    try await channel.sendStart(id: sessionId, sinceId: 0)
    let found = await scanMarkers(on: channel, want: want, timeout: timeout)
    await channel.close()
    return found
  }
}

struct DeviceIdentity: Sendable {
  let device: Data
  let server: Data
}

/// Memoizes the single pairing per process. Holds the in-flight `Task`, not the
/// value, so concurrent first-callers await the same pairing (actor reentrancy
/// across the `await`); a failure clears it to allow a retry.
actor PairedKeysBox {
  private var task: Task<DeviceIdentity, Error>?
  func resolve(
    _ pairOnce: @Sendable @escaping () async throws -> DeviceIdentity
  ) async throws -> DeviceIdentity {
    if let task { return try await task.value }
    let started = Task { try await pairOnce() }
    task = started
    do {
      return try await started.value
    } catch {
      task = nil
      throw error
    }
  }
}

extension NoiseLiveE2ETests {
  static let pairedKeys = PairedKeysBox()
}

private final class LiveInMemoryHostStorage: HostStorage {
  private var items: [String: String] = [:]
  func getItem(key: String) throws -> String? { items[key] }
  func setItem(key: String, value: String) throws { items[key] = value }
  func removeItem(key: String) throws { items[key] = nil }
}
