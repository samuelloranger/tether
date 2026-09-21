import XCTest
@testable import TetherKit

final class HostKeyVerifierTests: XCTestCase {
  private final class MemoryHostKeyStore: HostKeyStore {
    var pins: [String: String] = [:]
    private func key(_ host: String, _ port: Int) -> String { "\(host):\(port)" }
    func pinnedFingerprint(host: String, port: Int) -> String? { pins[key(host, port)] }
    func pin(_ fingerprint: String, host: String, port: Int) { pins[key(host, port)] = fingerprint }
  }

  func test_first_connection_pins_the_fingerprint_and_accepts() {
    let store = MemoryHostKeyStore()
    let decision = HostKeyVerifier.verify(fingerprint: "AA:BB", host: "h", port: 22, store: store)
    XCTAssertEqual(decision, .pinnedNew)
    XCTAssertEqual(store.pinnedFingerprint(host: "h", port: 22), "AA:BB")
  }

  func test_matching_fingerprint_accepts_without_repinning() {
    let store = MemoryHostKeyStore()
    store.pin("AA:BB", host: "h", port: 22)
    let decision = HostKeyVerifier.verify(fingerprint: "AA:BB", host: "h", port: 22, store: store)
    XCTAssertEqual(decision, .matched)
  }

  func test_changed_fingerprint_is_rejected_and_pin_is_left_untouched() {
    let store = MemoryHostKeyStore()
    store.pin("AA:BB", host: "h", port: 22)
    let decision = HostKeyVerifier.verify(fingerprint: "CC:DD", host: "h", port: 22, store: store)
    XCTAssertEqual(decision, .mismatch(expected: "AA:BB", got: "CC:DD"))
    // A rejected key must never overwrite the trusted pin.
    XCTAssertEqual(store.pinnedFingerprint(host: "h", port: 22), "AA:BB")
  }

  func test_pins_are_scoped_per_host_and_port() {
    let store = MemoryHostKeyStore()
    store.pin("AA:BB", host: "h", port: 22)
    // Same host, different port is a different endpoint: unknown, so it pins fresh.
    let decision = HostKeyVerifier.verify(fingerprint: "ZZ:ZZ", host: "h", port: 2222, store: store)
    XCTAssertEqual(decision, .pinnedNew)
    XCTAssertEqual(store.pinnedFingerprint(host: "h", port: 22), "AA:BB")
    XCTAssertEqual(store.pinnedFingerprint(host: "h", port: 2222), "ZZ:ZZ")
  }
}
