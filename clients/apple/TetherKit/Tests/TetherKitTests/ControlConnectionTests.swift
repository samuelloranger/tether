import Foundation
import XCTest
@testable import TetherKit

/// The session is reused across commands, a dropped one recovers by itself, and
/// a changed host key still stops everything.
final class ControlConnectionTests: XCTestCase {
  private func makeConfig() -> SSHConnectionConfig {
    SSHConnectionConfig(
      host: "example.internal", port: 22, username: "sam",
      credentials: [.password("hunter2")])
  }

  func test_the_first_command_authenticates_and_runs() async throws {
    let ops = FakeOps()
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeyStore()) { ops }

    let output = try await control.exec("zmx ls")

    XCTAssertEqual(output, "ran: zmx ls")
    XCTAssertEqual(ops.handshakes, 1)
    XCTAssertEqual(ops.auths, 1)
  }

  func test_later_commands_reuse_the_open_session() async throws {
    let ops = FakeOps()
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeyStore()) { ops }

    _ = try await control.exec("zmx ls")
    _ = try await control.exec("zmx history default")
    _ = try await control.exec("git -C /tmp diff")

    XCTAssertEqual(ops.handshakes, 1)
    XCTAssertEqual(ops.auths, 1)
    XCTAssertEqual(ops.commands, ["zmx ls", "zmx history default", "git -C /tmp diff"])
  }

  func test_a_dropped_session_is_redialed_once_and_the_command_still_lands() async throws {
    let dead = FakeOps()
    let fresh = FakeOps()
    var queue = [dead, fresh]
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeyStore()) { queue.removeFirst() }

    _ = try await control.exec("zmx ls")
    // The connection sat idle and was reaped; the next command finds out.
    dead.execResult = { _ in throw SSHConnectError.transport("channel closed") }

    let output = try await control.exec("zmx ls")

    XCTAssertEqual(output, "ran: zmx ls")
    XCTAssertEqual(dead.teardowns, 1, "the dead session must be torn down, not leaked")
    XCTAssertEqual(fresh.handshakes, 1)
  }

  func test_a_failure_on_the_fresh_session_too_is_reported() async throws {
    let first = FakeOps()
    let second = FakeOps()
    second.execResult = { _ in throw SSHConnectError.transport("channel closed") }
    var queue = [first, second]
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeyStore()) { queue.removeFirst() }

    _ = try await control.exec("zmx ls")
    first.execResult = { _ in throw SSHConnectError.transport("channel closed") }

    do {
      _ = try await control.exec("zmx ls")
      XCTFail("expected the second failure to surface")
    } catch {
      XCTAssertTrue(queue.isEmpty, "it must retry exactly once, not loop")
    }
  }

  /// Dialling again on a cold failure would double how long every genuine
  /// failure takes.
  func test_a_command_that_fails_on_a_brand_new_session_is_not_retried() async {
    let ops = FakeOps()
    ops.execResult = { _ in throw SSHConnectError.transport("channel closed") }
    var made = 0
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeyStore()) { made += 1; return ops }

    do {
      _ = try await control.exec("zmx ls")
      XCTFail("expected the failure to surface")
    } catch {
      XCTAssertEqual(made, 1, "a cold session must not be redialed")
    }
  }

  func test_a_host_key_mismatch_fails_loudly_and_is_never_redialed() async {
    let store = InMemoryHostKeyStore()
    store.pin("aa:aa:aa", host: "example.internal", port: 22)
    let ops = FakeOps()
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
    let first = FakeOps()
    let second = FakeOps()
    var queue = [first, second]
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeyStore()) { queue.removeFirst() }

    _ = try await control.exec("zmx ls")
    await control.close()
    XCTAssertEqual(first.teardowns, 1)

    _ = try await control.exec("zmx ls")
    XCTAssertEqual(second.handshakes, 1)
  }

  func test_commands_issued_at_once_are_serialized_onto_the_one_session() async throws {
    let ops = FakeOps()
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeyStore()) { ops }

    // The git screen fires several of these together.
    async let a = control.exec("git diff")
    async let b = control.exec("git branch")
    async let c = control.exec("git log")
    _ = try await [a, b, c]

    XCTAssertEqual(ops.handshakes, 1)
    XCTAssertEqual(ops.commands.count, 3)
    XCTAssertEqual(ops.maxConcurrentExecs, 1, "two commands must never be in flight on one session")
  }

  func test_reset_cuts_a_hung_command_loose_and_the_next_command_dials_fresh() async throws {
    let hung = FakeOps()
    hung.execResult = { [unowned hung] in try hung.hang($0) }
    let fresh = FakeOps()
    var queue = [hung, fresh]
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeyStore()) { queue.removeFirst() }
    let slow = Task { try await control.exec("git fetch") }
    let hanging = await eventually { hung.isHanging }
    XCTAssertTrue(hanging)

    control.reset()

    do {
      _ = try await slow.value
      XCTFail("a command on a cut socket must not report success")
    } catch {}
    let output = try await control.exec("zmx ls")
    XCTAssertEqual(output, "ran: zmx ls")
    XCTAssertEqual(hung.teardowns, 1)
    XCTAssertEqual(fresh.handshakes, 1)
  }

  func test_reset_on_an_idle_session_makes_the_next_command_redial() async throws {
    let first = FakeOps()
    let second = FakeOps()
    var queue = [first, second]
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeyStore()) { queue.removeFirst() }
    _ = try await control.exec("zmx ls")

    control.reset()
    let output = try await control.exec("zmx ls")

    XCTAssertEqual(first.interrupts, 1)
    XCTAssertEqual(output, "ran: zmx ls")
    XCTAssertEqual(second.handshakes, 1)
  }

  func test_close_does_not_wait_behind_a_hung_command() async throws {
    let hung = FakeOps()
    hung.execResult = { [unowned hung] in try hung.hang($0) }
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeyStore()) { hung }
    let slow = Task { try? await control.exec("gh pr checks 1") }
    let hanging = await eventually { hung.isHanging }
    XCTAssertTrue(hanging)

    let start = Date()
    await control.close()

    XCTAssertLessThan(Date().timeIntervalSince(start), 1)
    _ = await slow.value
    XCTAssertEqual(hung.teardowns, 1)
  }

  func test_reset_before_anything_is_open_is_harmless() async throws {
    let ops = FakeOps()
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeyStore()) { ops }

    control.reset()

    let output = try await control.exec("zmx ls")
    XCTAssertEqual(output, "ran: zmx ls")
    XCTAssertEqual(ops.interrupts, 0)
  }

  /// A reset is a decision to give up on what is running. Re-running it on a
  /// fresh connection could merge a pull request or kill a session twice.
  func test_a_command_cut_by_reset_is_not_run_again() async throws {
    let first = FakeOps()
    let second = FakeOps()
    var made = 0
    let control = ControlConnection(config: makeConfig(), store: InMemoryHostKeyStore()) {
      made += 1
      return made == 1 ? first : second
    }
    _ = try await control.exec("zmx ls")
    first.execResult = { [unowned first] in try first.hang($0) }
    let merge = Task { try await control.exec("gh pr merge 7 --squash") }
    let hanging = await eventually { first.isHanging }
    XCTAssertTrue(hanging)

    control.reset()

    do {
      _ = try await merge.value
      XCTFail("a cut command must fail, not be retried")
    } catch {}
    XCTAssertEqual(made, 1, "no fresh connection may be dialed to re-run it")
    XCTAssertEqual(second.commands, [])
  }
}
