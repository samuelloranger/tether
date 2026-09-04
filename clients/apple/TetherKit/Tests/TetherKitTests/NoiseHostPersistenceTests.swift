import Foundation
import XCTest

import TetherFFIBindings
@testable import TetherKit

/// In-memory `HostStorage` double — the host-profile JSON KV the Rust `host_store`
/// drives, without touching `UserDefaults`.
private final class InMemoryHostStorage: HostStorage {
  private var items: [String: String] = [:]
  func getItem(key: String) throws -> String? { items[key] }
  func setItem(key: String, value: String) throws { items[key] = value }
  func removeItem(key: String) throws { items[key] = nil }
}

/// In-memory `SecretStore` double — the per-host password store, so a test can
/// assert a host was persisted WITHOUT a password.
private final class InMemorySecretStore: SecretStore {
  private var secrets: [String: String] = [:]
  private var legacy: String?
  func get(hostId: String) throws -> String? { secrets[hostId] }
  func set(hostId: String, password: String) throws { secrets[hostId] = password }
  func clear(hostId: String) throws { secrets[hostId] = nil }
  func getLegacy() throws -> String? { legacy }
  func clearLegacy() throws { legacy = nil }

  /// Test-only visibility into whether any password was ever stored.
  var storedHostIds: [String] { Array(secrets.keys) }
}

/// Covers the Noise-host interim auth scheme: the DERIVED auth-mode helper and
/// the password-less create path (`SessionStore.createNoiseHost`). No UI here —
/// pure logic + the storage doubles.
final class NoiseHostPersistenceTests: XCTestCase {
  // MARK: - Auth-mode derivation (pure)

  func testResolveNoiseWhenBothKeysAndNoPassword() {
    XCTAssertEqual(
      HostAuthModeResolver.resolve(hasPinnedNoiseKey: true, hasDeviceKey: true, hasPassword: false),
      .noise
    )
  }

  func testResolvePasswordWhenEitherKeyMissing() {
    // Both Noise keys are required — one alone (a half-finished migration) must
    // fall back to the password path, not classify `.noise` and fail mid-handshake.
    XCTAssertEqual(
      HostAuthModeResolver.resolve(hasPinnedNoiseKey: true, hasDeviceKey: false, hasPassword: false),
      .password
    )
    XCTAssertEqual(
      HostAuthModeResolver.resolve(hasPinnedNoiseKey: false, hasDeviceKey: true, hasPassword: false),
      .password
    )
  }

  func testResolvePasswordWhenPasswordPresent() {
    // A password always wins — even if stale pinned keys also exist.
    XCTAssertEqual(
      HostAuthModeResolver.resolve(hasPinnedNoiseKey: true, hasDeviceKey: true, hasPassword: true),
      .password
    )
    XCTAssertEqual(
      HostAuthModeResolver.resolve(hasPinnedNoiseKey: false, hasDeviceKey: false, hasPassword: true),
      .password
    )
  }

  func testResolvePasswordWhenNeitherPresent() {
    // Neither key nor password → password path, the safe default for every
    // pre-Noise / half-set-up host.
    XCTAssertEqual(
      HostAuthModeResolver.resolve(hasPinnedNoiseKey: false, hasDeviceKey: false, hasPassword: false),
      .password
    )
  }

  // MARK: - Password-less create path

  @MainActor
  func testCreateNoiseHostPersistsWithoutPasswordAndDerivesNoiseMode() async throws {
    let secrets = InMemorySecretStore()
    let hostStore = HostStoreAdapter(storage: InMemoryHostStorage(), secrets: secrets)
    let noiseKeys = FakeNoiseKeyStore()
    let store = SessionStore(hostStore: hostStore, noiseKeyStore: noiseKeys)

    // Pairing already ran: device + server keys sit under the throwaway pairing
    // id, exactly as `PairDeviceView` leaves them.
    let pairId = "pair-\(UUID().uuidString)"
    let device = try noiseGenKeypair()
    let server = try noiseGenKeypair()
    try noiseKeys.saveDevicePrivateKey(device.private, hostId: pairId)
    try noiseKeys.saveServerPublicKey(server.public, hostId: pairId)

    let profile = try store.createNoiseHost(
      name: "",
      host: "192.168.1.9",
      port: "8443",
      pairHostId: pairId
    )

    // Persisted and listed.
    XCTAssertTrue(store.hosts.contains(where: { $0.id == profile.id }))
    XCTAssertEqual(profile.host, "192.168.1.9")
    XCTAssertEqual(profile.port, "8443")
    // Name fell back to the host address (no name typed in the pairing sheet).
    XCTAssertEqual(profile.name, "192.168.1.9")
    // Selected as the active host.
    XCTAssertEqual(store.activeHostId, profile.id)

    // NO password was stored for it — the whole point of the Noise path.
    XCTAssertFalseOrNilPassword(secrets, hostId: profile.id)
    XCTAssertFalse(store.hasPassword(hostId: profile.id))

    // Keys migrated onto the profile id; the throwaway pairing id was cleared.
    XCTAssertEqual(try noiseKeys.loadDevicePrivateKey(hostId: profile.id), device.private)
    XCTAssertEqual(try noiseKeys.loadServerPublicKey(hostId: profile.id), server.public)
    XCTAssertNil(try noiseKeys.loadDevicePrivateKey(hostId: pairId))
    XCTAssertNil(try noiseKeys.loadServerPublicKey(hostId: pairId))

    // And it derives as a Noise host (both keys present, no password).
    XCTAssertEqual(store.authMode(for: profile.id), .noise)
  }

  @MainActor
  func testCreateNoiseHostThrowsAndPersistsNothingWhenKeysMissing() async throws {
    let hostStore = HostStoreAdapter(storage: InMemoryHostStorage(), secrets: InMemorySecretStore())
    let noiseKeys = FakeNoiseKeyStore()
    let store = SessionStore(hostStore: hostStore, noiseKeyStore: noiseKeys)

    // No keys were ever pinned under this pairing id (pairing never completed).
    do {
      _ = try store.createNoiseHost(
        name: "", host: "192.168.1.9", port: "8443", pairHostId: "pair-missing")
      XCTFail("expected createNoiseHost to throw when the paired keys are absent")
    } catch let error as NoiseHostError {
      XCTAssertEqual(error, .missingPairedKeys)
    }
    // No orphan profile was left behind — nothing to reclassify as a password host.
    XCTAssertTrue(store.hosts.isEmpty)
  }

  @MainActor
  func testPasswordHostDerivesPasswordMode() async throws {
    let secrets = InMemorySecretStore()
    let hostStore = HostStoreAdapter(storage: InMemoryHostStorage(), secrets: secrets)
    let store = SessionStore(hostStore: hostStore, noiseKeyStore: FakeNoiseKeyStore())

    // A plain password host, created straight through the pure store (no probe).
    let profile = try hostStore.create(
      name: "box", color: "#89b4fa", host: "box", port: "8085", identityName: "box"
    )
    try hostStore.setPassword("hunter2", for: profile.id)
    store.reloadHosts()

    XCTAssertTrue(store.hasPassword(hostId: profile.id))
    XCTAssertEqual(store.authMode(for: profile.id), .password)
  }

  // MARK: - Address parsing feeding the create path

  func testHostAndPortSplitsTypedAddress() {
    XCTAssertTrue(PairDeviceView.hostAndPort(from: "192.168.1.9:8443")! == ("192.168.1.9", "8443"))
    XCTAssertTrue(PairDeviceView.hostAndPort(from: "https://box:9000")! == ("box", "9000"))
    // Missing port defaults to the Noise TLS port.
    XCTAssertTrue(PairDeviceView.hostAndPort(from: "box")! == ("box", "8443"))
    XCTAssertNil(PairDeviceView.hostAndPort(from: "   "))
  }
}

private func XCTAssertFalseOrNilPassword(
  _ secrets: InMemorySecretStore,
  hostId: String,
  file: StaticString = #filePath,
  line: UInt = #line
) {
  XCTAssertFalse(secrets.storedHostIds.contains(hostId), "expected no stored password", file: file, line: line)
}
