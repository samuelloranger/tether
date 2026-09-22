import Foundation
import XCTest
@testable import TetherKit

final class SSHConnectionSequenceTests: XCTestCase {
  private let pw = SSHCredential.password("pw")
  private let key = SSHCredential.privateKey(pem: "A", passphrase: nil)

  private func config(_ creds: [SSHCredential]) -> SSHConnectionConfig {
    SSHConnectionConfig(host: "h", port: 22, username: "u", credentials: creds, cols: 80, rows: 24)
  }

  func test_happy_path_pins_new_key_authenticates_and_opens_the_pty() throws {
    let ops = FakeOps()
    let store = InMemoryHostKeyStore()
    _ = try SSHConnectionSequence.run(config: config([pw]), ops: ops, store: store)
    XCTAssertEqual(ops.calls, [.connect, .fingerprint, .auth(pw), .openPTY])
    XCTAssertEqual(store.pinnedFingerprint(host: "h", port: 22), "FP:NEW")
  }

  func test_host_key_mismatch_aborts_before_auth_and_tears_down() {
    let ops = FakeOps()
    ops.fingerprint = "FP:EVIL"
    let store = InMemoryHostKeyStore()
    store.pin("FP:GOOD", host: "h", port: 22)
    XCTAssertThrowsError(try SSHConnectionSequence.run(config: config([pw]), ops: ops, store: store)) { error in
      XCTAssertEqual(error as? SSHConnectError, .hostKeyMismatch(expected: "FP:GOOD", got: "FP:EVIL"))
    }
    XCTAssertEqual(ops.calls, [.connect, .fingerprint, .teardown])
  }

  func test_all_credentials_rejected_reports_auth_failure_and_tears_down() {
    let ops = FakeOps()
    ops.accepts = { _ in false }
    XCTAssertThrowsError(try SSHConnectionSequence.run(config: config([key, pw]), ops: ops, store: InMemoryHostKeyStore())) { error in
      XCTAssertEqual(error as? SSHConnectError, .auth(.allFailed(detail: nil)))
    }
    XCTAssertEqual(ops.calls, [.connect, .fingerprint, .auth(key), .auth(pw), .teardown])
  }

  func test_transport_failure_during_connect_tears_down_and_reports_transport() {
    struct Boom: Error {}
    let ops = FakeOps()
    ops.connectError = Boom()
    XCTAssertThrowsError(try SSHConnectionSequence.run(config: config([pw]), ops: ops, store: InMemoryHostKeyStore())) { error in
      guard case .transport = (error as? SSHConnectError) else { return XCTFail("expected .transport, got \(error)") }
    }
    XCTAssertEqual(ops.calls, [.connect, .teardown])
  }

  func test_an_answer_the_host_already_gave_is_not_asked_twice() {
    XCTAssertFalse(SSHConnectError.hostKeyMismatch(expected: "a", got: "b").isTransient)
    XCTAssertFalse(SSHConnectError.auth(.allFailed(detail: nil)).isTransient)
    XCTAssertFalse(SSHConnectError.missingCredential(name: "host").isTransient)
  }

  func test_a_connection_that_went_away_is_worth_one_more_try() {
    XCTAssertTrue(SSHConnectError.transport("socket closed").isTransient)
  }

  /// Two sessions signing at once intermittently fails with libssh2 -19, so
  /// handshake and auth are mutually exclusive across the app.
  func test_two_connections_never_authenticate_at_the_same_time() {
    let tracker = ConcurrencyTracker()
    let store = InMemoryHostKeyStore()
    let config = SSHConnectionConfig(
      host: "example.internal", port: 22, username: "sam", credentials: [.password("pw")])

    let group = DispatchGroup()
    for _ in 0..<8 {
      DispatchQueue.global().async(group: group) {
        let ops = FakeOps()
        // The tracked window is the credential signing itself: that is the
        // libssh2 race the lock exists for, and the only thing serialized.
        ops.accepts = { _ in
          tracker.enter()
          Thread.sleep(forTimeInterval: 0.02)
          tracker.leave()
          return true
        }
        try? SSHConnectionSequence.authenticate(config: config, ops: ops, store: store)
      }
    }
    XCTAssertEqual(group.wait(timeout: .now() + 10), .success, "the gate deadlocked")
    XCTAssertEqual(tracker.peak, 1, "two sessions authenticated at once")
    XCTAssertEqual(tracker.completed, 8, "every caller should still get through")
  }
}

private final class ConcurrencyTracker: @unchecked Sendable {
  private let lock = NSLock()
  private var inFlight = 0
  private(set) var peak = 0
  private(set) var completed = 0

  func enter() {
    lock.lock(); inFlight += 1; peak = max(peak, inFlight); lock.unlock()
  }

  func leave() {
    lock.lock(); inFlight -= 1; completed += 1; lock.unlock()
  }

  func test_a_slow_handshake_does_not_block_a_dial_to_another_host() {
    // The lock used to span connectAndHandshake and was process-wide, so one
    // unreachable host stalled every other dial for its whole timeout.
    let store = InMemoryHostKeyStore()
    let slow = SSHConnectionSequence.self
    let tracker = ConcurrencyTracker()
    let group = DispatchGroup()
    for index in 0..<2 {
      let config = SSHConnectionConfig(
        host: "host\(index).internal", port: 22, username: "sam", credentials: [.password("pw")])
      DispatchQueue.global().async(group: group) {
        let ops = FakeOps()
        ops.onConnect = {
          tracker.enter()
          Thread.sleep(forTimeInterval: 0.05)
          tracker.leave()
        }
        try? slow.authenticate(config: config, ops: ops, store: store)
      }
    }
    XCTAssertEqual(group.wait(timeout: .now() + 10), .success)
    XCTAssertEqual(tracker.peak, 2, "handshakes to different hosts should overlap")
  }
}
