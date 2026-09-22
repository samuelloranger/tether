import XCTest
@testable import TetherKit

/// A watch command that never exits must stop when its screen does, instead of
/// holding a connection and a thread until the host command ends.
final class SSHConnectorStreamTests: XCTestCase {
  func test_cancelling_a_stream_shuts_its_socket_and_returns() async {
    let ops = FakeOps()
    ops.execResult = { [unowned ops] in try ops.hang($0) }
    let config = SSHConnectionConfig(host: "example.internal", port: 22, username: "sam", credentials: [.password("pw")])
    let watching = Task {
      try await SSHConnector.execStream(
        config: config, store: InMemoryHostKeyStore(), command: "gh pr checks 1 --watch", ops: ops
      ) { _ in true }
    }
    let hanging = await eventually { ops.isHanging }
    XCTAssertTrue(hanging)

    watching.cancel()
    let cut = await eventually(timeout: 1) { ops.interrupts > 0 }

    XCTAssertTrue(cut, "cancelling must shut the stream's socket")
    // Unsticks a regressed build so it fails here instead of hanging the suite.
    if !cut { ops.interrupt() }
    _ = try? await watching.value
    XCTAssertEqual(ops.interrupts, 1)
    XCTAssertGreaterThanOrEqual(ops.teardowns, 1)
  }
}
