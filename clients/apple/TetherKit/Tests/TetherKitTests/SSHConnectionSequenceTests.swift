import Foundation
import XCTest
@testable import TetherKit

private struct NullByteStream: TerminalByteStream {
  func read() async throws -> Data? { nil }
  func write(_ bytes: Data) async throws {}
  func close() async {}
}

private final class MemoryHostKeyStore: HostKeyStore {
  var pins: [String: String] = [:]
  func pinnedFingerprint(host: String, port: Int) -> String? { pins["\(host):\(port)"] }
  func pin(_ fingerprint: String, host: String, port: Int) { pins["\(host):\(port)"] = fingerprint }
}

/// Records the call sequence and lets each step be scripted.
private final class FakeOps: SSHConnectionOps {
  enum Step: Equatable { case connect, fingerprint, auth(SSHCredential), openPTY, teardown }
  var calls: [Step] = []
  var fingerprint = "FP:NEW"
  var accepts: (SSHCredential) -> Bool = { _ in true }
  var connectError: Error?
  var openError: Error?

  func connectAndHandshake() throws {
    calls.append(.connect)
    if let connectError { throw connectError }
  }
  func hostKeyFingerprint() throws -> String {
    calls.append(.fingerprint)
    return fingerprint
  }
  func authenticate(_ credential: SSHCredential) throws -> Bool {
    calls.append(.auth(credential))
    return accepts(credential)
  }
  func openPTYChannel(cols: Int, rows: Int) throws -> any TerminalByteStream {
    calls.append(.openPTY)
    if let openError { throw openError }
    return NullByteStream()
  }
  func exec(_ command: String) throws -> String { "" }
  func teardown() { calls.append(.teardown) }
}

final class SSHConnectionSequenceTests: XCTestCase {
  private let pw = SSHCredential.password("pw")
  private let key = SSHCredential.privateKey(pem: "A", passphrase: nil)

  private func config(_ creds: [SSHCredential]) -> SSHConnectionConfig {
    SSHConnectionConfig(host: "h", port: 22, username: "u", credentials: creds, cols: 80, rows: 24)
  }

  func test_happy_path_pins_new_key_authenticates_and_opens_the_pty() throws {
    let ops = FakeOps()
    let store = MemoryHostKeyStore()
    _ = try SSHConnectionSequence.run(config: config([pw]), ops: ops, store: store)
    XCTAssertEqual(ops.calls, [.connect, .fingerprint, .auth(pw), .openPTY])
    XCTAssertEqual(store.pinnedFingerprint(host: "h", port: 22), "FP:NEW")
  }

  func test_host_key_mismatch_aborts_before_auth_and_tears_down() {
    let ops = FakeOps()
    ops.fingerprint = "FP:EVIL"
    let store = MemoryHostKeyStore()
    store.pin("FP:GOOD", host: "h", port: 22)
    XCTAssertThrowsError(try SSHConnectionSequence.run(config: config([pw]), ops: ops, store: store)) { error in
      XCTAssertEqual(error as? SSHConnectError, .hostKeyMismatch(expected: "FP:GOOD", got: "FP:EVIL"))
    }
    XCTAssertEqual(ops.calls, [.connect, .fingerprint, .teardown])
  }

  func test_all_credentials_rejected_reports_auth_failure_and_tears_down() {
    let ops = FakeOps()
    ops.accepts = { _ in false }
    XCTAssertThrowsError(try SSHConnectionSequence.run(config: config([key, pw]), ops: ops, store: MemoryHostKeyStore())) { error in
      XCTAssertEqual(error as? SSHConnectError, .auth(.allFailed(detail: nil)))
    }
    XCTAssertEqual(ops.calls, [.connect, .fingerprint, .auth(key), .auth(pw), .teardown])
  }

  func test_transport_failure_during_connect_tears_down_and_reports_transport() {
    struct Boom: Error {}
    let ops = FakeOps()
    ops.connectError = Boom()
    XCTAssertThrowsError(try SSHConnectionSequence.run(config: config([pw]), ops: ops, store: MemoryHostKeyStore())) { error in
      guard case .transport = (error as? SSHConnectError) else { return XCTFail("expected .transport, got \(error)") }
    }
    XCTAssertEqual(ops.calls, [.connect, .teardown])
  }

  /// A transfer dials its own connection, and that dial can lose a race it has
  /// no part in — the app is suspended mid-handshake, the radio changes. One
  /// retry turns those into a sent file instead of "authentication failed".
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
}
