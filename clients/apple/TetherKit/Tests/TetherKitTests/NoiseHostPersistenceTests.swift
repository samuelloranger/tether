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

/// Covers the Noise-host create path (`SessionStore.createNoiseHost`). No UI here —
/// pure logic + the storage doubles.
final class NoiseHostPersistenceTests: XCTestCase {
  // MARK: - Password-less create path

  @MainActor
  func testCreateNoiseHostPersistsWithoutPasswordAndDerivesNoiseMode() async throws {
    let hostStore = HostStoreAdapter(storage: InMemoryHostStorage())
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

    // Keys migrated onto the profile id; the throwaway pairing id was cleared.
    XCTAssertEqual(try noiseKeys.loadDevicePrivateKey(hostId: profile.id), device.private)
    XCTAssertEqual(try noiseKeys.loadServerPublicKey(hostId: profile.id), server.public)
    XCTAssertNil(try noiseKeys.loadDevicePrivateKey(hostId: pairId))
    XCTAssertNil(try noiseKeys.loadServerPublicKey(hostId: pairId))
  }

  @MainActor
  func testCreateNoiseHostThrowsAndPersistsNothingWhenKeysMissing() async throws {
    let hostStore = HostStoreAdapter(storage: InMemoryHostStorage())
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
    // No orphan profile was left behind.
    XCTAssertTrue(store.hosts.isEmpty)
  }

  // MARK: - Address parsing feeding the create path

  func testHostAndPortSplitsTypedAddress() {
    XCTAssertTrue(PairDeviceView.hostAndPort(from: "192.168.1.9:8443")! == ("192.168.1.9", "8443"))
    XCTAssertTrue(PairDeviceView.hostAndPort(from: "https://box:9000")! == ("box", "9000"))
    // Missing port defaults to the plaintext listener.
    XCTAssertTrue(PairDeviceView.hostAndPort(from: "box")! == ("box", "8085"))
    XCTAssertNil(PairDeviceView.hostAndPort(from: "   "))
  }
}
