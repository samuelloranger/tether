import Darwin
import XCTest
@testable import TetherKit

/// Every socket must carry its own liveness and never raise SIGPIPE, and a dial
/// into a path that swallows packets must give up on time instead of hanging.
final class SocketDialerTests: XCTestCase {
  private func option(_ fd: Int32, _ level: Int32, _ name: Int32) -> Int32 {
    var value: Int32 = 0
    var len = socklen_t(MemoryLayout<Int32>.size)
    XCTAssertEqual(getsockopt(fd, level, name, &value, &len), 0)
    return value
  }

  func test_tuning_arms_keepalive_retransmit_drop_nodelay_and_no_sigpipe() {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    defer { close(fd) }

    SocketDialer.tune(fd)

    XCTAssertNotEqual(option(fd, SOL_SOCKET, SO_NOSIGPIPE), 0)
    XCTAssertNotEqual(option(fd, SOL_SOCKET, SO_KEEPALIVE), 0)
    XCTAssertNotEqual(option(fd, IPPROTO_TCP, TCP_NODELAY), 0)
    XCTAssertEqual(option(fd, IPPROTO_TCP, TCP_KEEPALIVE), SSHTimeouts.tcpKeepIdleSeconds)
    XCTAssertEqual(option(fd, IPPROTO_TCP, TCP_KEEPINTVL), SSHTimeouts.tcpKeepIntervalSeconds)
    XCTAssertEqual(option(fd, IPPROTO_TCP, TCP_KEEPCNT), SSHTimeouts.tcpKeepCount)
    XCTAssertEqual(option(fd, IPPROTO_TCP, TCP_RXT_CONNDROPTIME), SSHTimeouts.retransmitDropSeconds)
  }

  func test_a_listening_port_connects() throws {
    let listener = try LocalListener()
    defer { listener.close() }

    let fd = try SocketDialer.open(host: "127.0.0.1", port: listener.port)
    defer { close(fd) }

    XCTAssertGreaterThanOrEqual(fd, 0)
    XCTAssertNotEqual(option(fd, SOL_SOCKET, SO_KEEPALIVE), 0, "the returned socket is the tuned one")
  }

  func test_a_refused_port_fails_fast() throws {
    let port = try LocalListener.unusedPort()
    let start = Date()

    XCTAssertThrowsError(try SocketDialer.open(host: "127.0.0.1", port: port))
    XCTAssertLessThan(Date().timeIntervalSince(start), 1)
  }

  func test_a_path_that_swallows_packets_gives_up_at_the_connect_deadline() {
    // TEST-NET-1 (RFC 5737) is never routed: SYNs vanish like on a dead path.
    // Where the host has no route at all this fails instantly, which also passes.
    let start = Date()

    XCTAssertThrowsError(try SocketDialer.open(host: "192.0.2.1", port: 22, connectTimeout: 1))
    XCTAssertLessThan(Date().timeIntervalSince(start), 4)
  }
}
