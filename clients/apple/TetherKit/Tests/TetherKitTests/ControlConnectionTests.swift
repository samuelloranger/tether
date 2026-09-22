import Foundation
import XCTest
@testable import TetherKit

/// The control connection exists so an app action costs one round trip instead
/// of a fresh dial, handshake and authentication. These prove the session is
/// actually reused, that a dropped one recovers by itself, and that a changed
/// host key still stops everything.
final class ControlConnectionTests: XCTestCase {
  private func makeConfig() -> SSHConnectionConfig {
    SSHConnectionConfig(
      host: "example.internal", port: 22, username: "sam",
      credentials: [.password("hunter2")])
  }

  func test_the_first_command_authenticates_and_runs() async throws {
    let ops = FakeControlOps()
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeys()) { ops }

    let output = try await control.exec("zmx ls")

    XCTAssertEqual(output, "ran: zmx ls")
    XCTAssertEqual(ops.handshakes, 1)
    XCTAssertEqual(ops.auths, 1)
  }

  func test_later_commands_reuse_the_open_session() async throws {
    let ops = FakeControlOps()
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeys()) { ops }

    _ = try await control.exec("zmx ls")
    _ = try await control.exec("zmx history default")
    _ = try await control.exec("git -C /tmp diff")

    // The whole point: three commands, one handshake.
    XCTAssertEqual(ops.handshakes, 1)
    XCTAssertEqual(ops.auths, 1)
    XCTAssertEqual(ops.commands, ["zmx ls", "zmx history default", "git -C /tmp diff"])
  }

  func test_a_dropped_session_is_redialed_once_and_the_command_still_lands() async throws {
    let dead = FakeControlOps()
    dead.failNextExec = true
    let fresh = FakeControlOps()
    var queue = [dead, fresh]
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeys()) { queue.removeFirst() }

    let output = try await control.exec("zmx ls")

    XCTAssertEqual(output, "ran: zmx ls")
    XCTAssertEqual(dead.teardowns, 1, "the dead session must be torn down, not leaked")
    XCTAssertEqual(fresh.handshakes, 1)
  }

  func test_a_failure_on_the_fresh_session_too_is_reported() async {
    let first = FakeControlOps()
    first.failNextExec = true
    let second = FakeControlOps()
    second.failNextExec = true
    var queue = [first, second]
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeys()) { queue.removeFirst() }

    do {
      _ = try await control.exec("zmx ls")
      XCTFail("expected the second failure to surface")
    } catch {
      XCTAssertTrue(queue.isEmpty, "it must retry exactly once, not loop")
    }
  }

  // A changed host key is the one failure that must never be retried, here as
  // much as on the terminal's own connection.
  func test_a_host_key_mismatch_fails_loudly_and_is_never_redialed() async {
    let store = InMemoryHostKeys()
    store.pin("aa:aa:aa", host: "example.internal", port: 22)
    let ops = FakeControlOps()
    ops.fingerprint = "bb:bb:bb"
    var made = 0
    let control = ControlConnection(config: makeConfig(), store: store) { made += 1; return ops }

    do {
      _ = try await control.exec("zmx ls")
      XCTFail("expected a host-key mismatch")
    } catch let error as SSHConnectError {
      guard case .hostKeyMismatch = error else { return XCTFail("wrong error: \(error)") }
      XCTAssertEqual(made, 1, "a mismatch must not be retried with a second dial")
      XCTAssertEqual(ops.commands, [], "nothing may run on an unverified host")
    } catch {
      XCTFail("wrong error: \(error)")
    }
  }

  func test_closing_ends_the_session_and_the_next_command_opens_a_new_one() async throws {
    let first = FakeControlOps()
    let second = FakeControlOps()
    var queue = [first, second]
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeys()) { queue.removeFirst() }

    _ = try await control.exec("zmx ls")
    await control.close()
    XCTAssertEqual(first.teardowns, 1)

    _ = try await control.exec("zmx ls")
    XCTAssertEqual(second.handshakes, 1)
  }

  func test_commands_issued_at_once_are_serialized_onto_the_one_session() async throws {
    let ops = FakeControlOps()
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeys()) { ops }

    // The git screen fires several of these together; libssh2 tolerates that
    // only because they are queued, never concurrent.
    async let a = control.exec("git diff")
    async let b = control.exec("git branch")
    async let c = control.exec("git log")
    _ = try await [a, b, c]

    XCTAssertEqual(ops.handshakes, 1)
    XCTAssertEqual(ops.commands.count, 3)
    XCTAssertEqual(ops.maxConcurrentExecs, 1, "two commands must never be in flight on one session")
  }
}

// MARK: - doubles

private final class FakeControlOps: SSHConnectionOps, @unchecked Sendable {
  var handshakes = 0
  var auths = 0
  var teardowns = 0
  var commands: [String] = []
  var fingerprint = "aa:aa:aa"
  var failNextExec = false
  private(set) var maxConcurrentExecs = 0
  private var inFlight = 0
  private let lock = NSLock()

  func connectAndHandshake() throws { handshakes += 1 }
  func hostKeyFingerprint() throws -> String { fingerprint }
  func authenticate(_ credential: SSHCredential) throws -> Bool { auths += 1; return true }

  func openPTYChannel(cols: Int, rows: Int) throws -> any TerminalByteStream {
    throw SSHConnectError.transport("the control connection never opens a PTY")
  }

  func exec(_ command: String) throws -> String {
    lock.lock(); inFlight += 1; maxConcurrentExecs = max(maxConcurrentExecs, inFlight); lock.unlock()
    defer { lock.lock(); inFlight -= 1; lock.unlock() }
    if failNextExec {
      failNextExec = false
      throw SSHConnectError.transport("channel closed")
    }
    commands.append(command)
    return "ran: \(command)"
  }

  func teardown() { teardowns += 1 }
}

private final class InMemoryHostKeys: HostKeyStore, @unchecked Sendable {
  private var pinned: [String: String] = [:]
  func pinnedFingerprint(host: String, port: Int) -> String? { pinned["\(host):\(port)"] }
  func pin(_ fingerprint: String, host: String, port: Int) { pinned["\(host):\(port)"] = fingerprint }
}
