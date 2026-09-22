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
  private let released = DispatchSemaphore(value: 0)
  private var interruptCount = 0
  private var hanging = false

  var interrupts: Int { lock.lock(); defer { lock.unlock() }; return interruptCount }
  var isHanging: Bool { lock.lock(); defer { lock.unlock() }; return hanging }

  func interrupt() {
    lock.lock(); interruptCount += 1; lock.unlock()
    released.signal()
  }

  /// For `execResult`: blocks the way a read on a silently dead socket does,
  /// until `interrupt()` shuts it.
  func hang(_ command: String) throws -> String {
    lock.lock(); hanging = true; lock.unlock()
    released.wait()
    throw SSHConnectError.transport("socket shut down")
  }

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
    // A session whose socket was cut fails every later command, as a real one does.
    lock.lock(); let cut = interruptCount > 0; lock.unlock()
    if cut { throw SSHConnectError.transport("socket shut down") }
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

/// Polls `condition` until it holds or `timeout` passes.
func eventually(timeout: TimeInterval = 2, _ condition: @escaping () -> Bool) async -> Bool {
  let end = Date().addingTimeInterval(timeout)
  while Date() < end {
    if condition() { return true }
    try? await Task.sleep(nanoseconds: 10_000_000)
  }
  return condition()
}

/// A terminal stream a test holds open or ends, recording whether it was closed.
final class ScriptedByteStream: TerminalByteStream, @unchecked Sendable {
  private let lock = NSLock()
  private var isClosed = false
  private var waiter: CheckedContinuation<Data?, Never>?

  var closed: Bool { lock.lock(); defer { lock.unlock() }; return isClosed }

  func read() async throws -> Data? {
    await withCheckedContinuation { continuation in
      lock.lock()
      if isClosed { lock.unlock(); continuation.resume(returning: nil); return }
      waiter = continuation
      lock.unlock()
    }
  }

  func write(_ bytes: Data) async throws {}

  func close() async {
    lock.lock()
    isClosed = true
    let pending = waiter
    waiter = nil
    lock.unlock()
    pending?.resume(returning: nil)
  }
}

/// Hands out scripted streams to `SSHTerminalController`'s dialer, optionally
/// holding each dial until the test opens the gate.
final class DialScript: @unchecked Sendable {
  private let lock = NSLock()
  private var streams: [ScriptedByteStream]
  private var gateOpen: Bool
  private var gateWaiters: [CheckedContinuation<Void, Never>] = []
  private var dialCount = 0
  private var entered = false

  init(_ streams: [ScriptedByteStream], held: Bool = false) {
    self.streams = streams
    self.gateOpen = !held
  }

  var dials: Int { lock.lock(); defer { lock.unlock() }; return dialCount }
  var hasEntered: Bool { lock.lock(); defer { lock.unlock() }; return entered }

  func open() {
    lock.lock()
    gateOpen = true
    let waiting = gateWaiters
    gateWaiters = []
    lock.unlock()
    waiting.forEach { $0.resume() }
  }

  func dial(_ config: SSHConnectionConfig, _ store: HostKeyStore) async throws -> any TerminalByteStream {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      lock.lock()
      entered = true
      if gateOpen { lock.unlock(); continuation.resume(); return }
      gateWaiters.append(continuation)
      lock.unlock()
    }
    lock.lock()
    defer { lock.unlock() }
    dialCount += 1
    return streams.isEmpty ? ScriptedByteStream() : streams.removeFirst()
  }
}
