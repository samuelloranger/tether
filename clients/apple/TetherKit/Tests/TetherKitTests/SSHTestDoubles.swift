import Foundation
@testable import TetherKit

/// Shared in-memory doubles for the SSH store/vault tests. Pairs with the
/// module's `InMemorySSHSecrets` for the secret side.
final class InMemoryKV: SSHKeyValueStore {
  var items: [String: Data] = [:]
  func data(forKey key: String) -> Data? { items[key] }
  func set(_ data: Data?, forKey key: String) { items[key] = data }
}

final class InMemoryHostKeyStore: HostKeyStore, @unchecked Sendable {
  private let lock = NSLock()
  private var pins: [String: String] = [:]

  func pinnedFingerprint(host: String, port: Int) -> String? {
    lock.lock(); defer { lock.unlock() }
    return pins["\(host):\(port)"]
  }

  func pin(_ fingerprint: String, host: String, port: Int) {
    lock.lock(); pins["\(host):\(port)"] = fingerprint; lock.unlock()
  }
}

private struct NullByteStream: TerminalByteStream {
  func read() async throws -> Data? { nil }
  func write(_ bytes: Data) async throws {}
  func close() async {}
}

final class FakeOps: SSHConnectionOps, @unchecked Sendable {
  enum Step: Equatable { case connect, fingerprint, auth(SSHCredential), openPTY, teardown }

  var calls: [Step] = []
  var handshakes = 0
  var auths = 0
  var teardowns = 0
  var commands: [String] = []
  var fingerprint = "FP:NEW"
  var accepts: (SSHCredential) -> Bool = { _ in true }
  var connectError: Error?
  var openError: Error?
  /// Lets a test stall inside the handshake to prove two dials cannot overlap.
  var onConnect: () -> Void = {}
  /// Lets a test fail the first exec, to drive the stale-session retry.
  var execResult: (String) throws -> String = { "ran: \($0)" }

  private let lock = NSLock()
  private var inFlight = 0
  private(set) var maxConcurrentExecs = 0

  func connectAndHandshake() throws {
    onConnect()
    calls.append(.connect)
    handshakes += 1
    if let connectError { throw connectError }
  }

  func hostKeyFingerprint() throws -> String {
    calls.append(.fingerprint)
    return fingerprint
  }

  func authenticate(_ credential: SSHCredential) throws -> Bool {
    calls.append(.auth(credential))
    auths += 1
    return accepts(credential)
  }

  func openPTYChannel(cols: Int, rows: Int) throws -> any TerminalByteStream {
    calls.append(.openPTY)
    if let openError { throw openError }
    return NullByteStream()
  }

  func exec(_ command: String) throws -> String {
    lock.lock(); inFlight += 1; maxConcurrentExecs = max(maxConcurrentExecs, inFlight); lock.unlock()
    defer { lock.lock(); inFlight -= 1; lock.unlock() }
    let result = try execResult(command)
    commands.append(command)
    return result
  }

  func teardown() {
    calls.append(.teardown)
    teardowns += 1
  }
}
