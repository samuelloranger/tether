import XCTest
@testable import TetherKit

final class HostKeyVerifierTests: XCTestCase {
  func test_first_connection_pins_the_fingerprint_and_accepts() {
    let store = InMemoryHostKeyStore()
    let decision = HostKeyVerifier.verify(fingerprint: "AA:BB", host: "h", port: 22, store: store)
    XCTAssertEqual(decision, .pinnedNew)
    XCTAssertEqual(store.pinnedFingerprint(host: "h", port: 22), "AA:BB")
  }

  func test_matching_fingerprint_accepts_without_repinning() {
    let store = InMemoryHostKeyStore()
    store.pin("AA:BB", host: "h", port: 22)
    let decision = HostKeyVerifier.verify(fingerprint: "AA:BB", host: "h", port: 22, store: store)
    XCTAssertEqual(decision, .matched)
  }

  func test_changed_fingerprint_is_rejected_and_pin_is_left_untouched() {
    let store = InMemoryHostKeyStore()
    store.pin("AA:BB", host: "h", port: 22)
    let decision = HostKeyVerifier.verify(fingerprint: "CC:DD", host: "h", port: 22, store: store)
    XCTAssertEqual(decision, .mismatch(expected: "AA:BB", got: "CC:DD"))
    // A rejected key must never overwrite the trusted pin.
    XCTAssertEqual(store.pinnedFingerprint(host: "h", port: 22), "AA:BB")
  }

  func test_pins_are_scoped_per_host_and_port() {
    let store = InMemoryHostKeyStore()
    store.pin("AA:BB", host: "h", port: 22)
    // Same host, different port is a different endpoint: unknown, so it pins fresh.
    let decision = HostKeyVerifier.verify(fingerprint: "ZZ:ZZ", host: "h", port: 2222, store: store)
    XCTAssertEqual(decision, .pinnedNew)
    XCTAssertEqual(store.pinnedFingerprint(host: "h", port: 22), "AA:BB")
    XCTAssertEqual(store.pinnedFingerprint(host: "h", port: 2222), "ZZ:ZZ")
  }
}
