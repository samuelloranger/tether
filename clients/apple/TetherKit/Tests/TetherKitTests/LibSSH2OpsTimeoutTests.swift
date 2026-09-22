import XCTest
@testable import TetherKit

/// A host that completes TCP and then says nothing, which is what a silently
/// dead path looks like mid-dial, must fail the handshake, not hang it.
final class LibSSH2OpsTimeoutTests: XCTestCase {
  private func silentHost(_ listener: LocalListener) -> SSHConnectionConfig {
    SSHConnectionConfig(host: "127.0.0.1", port: listener.port, username: "sam", credentials: [.password("pw")])
  }

  func test_a_silent_host_fails_the_handshake_within_the_operation_timeout() throws {
    let listener = try LocalListener()
    defer { listener.close() }
    let ops = LibSSH2Ops(config: silentHost(listener), operationTimeoutMs: 500)
    let failed = expectation(description: "handshake failed")

    Thread {
      do { try ops.connectAndHandshake(); XCTFail("a silent host cannot complete a handshake") }
      catch { failed.fulfill() }
      ops.teardown()
    }.start()

    wait(for: [failed], timeout: 5)
  }

  func test_interrupt_cuts_a_blocked_handshake_loose() throws {
    let listener = try LocalListener()
    defer { listener.close() }
    let ops = LibSSH2Ops(config: silentHost(listener), operationTimeoutMs: 60_000)
    let failed = expectation(description: "handshake failed")

    Thread {
      do { try ops.connectAndHandshake(); XCTFail("a silent host cannot complete a handshake") }
      catch { failed.fulfill() }
      ops.teardown()
    }.start()
    Thread.sleep(forTimeInterval: 0.3)
    ops.interrupt()

    wait(for: [failed], timeout: 3)
  }
}
