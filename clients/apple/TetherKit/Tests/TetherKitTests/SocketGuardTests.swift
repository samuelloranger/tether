import Darwin
import XCTest
@testable import TetherKit

/// Another thread may cut a blocked socket loose, but never after its owner
/// closed it: the descriptor number may already belong to a new connection.
final class SocketGuardTests: XCTestCase {
  private func pair() -> (Int32, Int32) {
    var fds: [Int32] = [-1, -1]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
    return (fds[0], fds[1])
  }

  func test_shutdown_wakes_a_blocked_reader_with_end_of_file() {
    let (mine, peer) = pair()
    defer { close(peer) }
    let socketGuard = SocketGuard()
    _ = socketGuard.adopt(mine)
    let returned = expectation(description: "blocked read returned")
    Thread {
      var byte: UInt8 = 0
      _ = read(mine, &byte, 1)
      returned.fulfill()
    }.start()

    Thread.sleep(forTimeInterval: 0.1)
    socketGuard.shutdown()

    wait(for: [returned], timeout: 2)
    socketGuard.close()
  }

  func test_shutdown_after_close_leaves_a_reused_descriptor_alone() {
    let (mine, peer) = pair()
    close(peer)
    let socketGuard = SocketGuard()
    _ = socketGuard.adopt(mine)
    socketGuard.close()

    let (reused, reusedPeer) = pair()
    defer { close(reused); close(reusedPeer) }
    socketGuard.shutdown()

    var byte: UInt8 = 7
    XCTAssertEqual(write(reused, &byte, 1), 1, "a stale shutdown must not reach the new socket")
  }

  /// shutdown() does nothing to a socket that is not connected yet, so a cut
  /// that lands before the dial must stop the dial from adopting a socket at all.
  func test_a_guard_cut_before_the_dial_refuses_the_socket() {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    defer { close(fd) }
    let socketGuard = SocketGuard()
    socketGuard.shutdown()

    XCTAssertFalse(socketGuard.adopt(fd))
    XCTAssertTrue(socketGuard.isCut)
  }
}
