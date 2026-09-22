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

  func test_a_transfer_retries_a_transport_failure_once() {
    XCTAssertTrue(SSHTerminalController.shouldRetryTransfer(after: SSHConnectError.transport("socket closed")))
    XCTAssertTrue(SSHTerminalController.shouldRetryTransfer(after: SSHConnectError.auth(.allFailed(detail: "Unable to sign"))))
  }

  func test_a_transfer_never_retries_a_changed_host_key() {
    XCTAssertFalse(SSHTerminalController.shouldRetryTransfer(
      after: SSHConnectError.hostKeyMismatch(expected: "aa", got: "bb")))
  }

  func test_a_transfer_does_not_retry_a_missing_credential() {
    XCTAssertFalse(SSHTerminalController.shouldRetryTransfer(after: SSHConnectError.missingCredential(name: "homelab")))
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
        ops.onConnect = tracker.enter
        ops.accepts = { _ in
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
}
