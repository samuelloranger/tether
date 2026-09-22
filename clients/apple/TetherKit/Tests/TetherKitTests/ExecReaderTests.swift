import XCTest
@testable import TetherKit

/// A quiet command is not a dead one, a dead one is not an empty answer, and a
/// command that never finishes cannot hold the connection forever.
final class ExecReaderTests: XCTestCase {
  private enum Step { case bytes(String), rc(Int) }

  private func run(
    _ steps: [Step], eofAfter: Bool = true, clock: [TimeInterval]? = nil, deadline: TimeInterval? = nil
  ) throws -> String {
    var steps = steps
    var ticks = clock ?? []
    var output = ""
    try ExecReader.run(
      read: { buffer in
        guard !steps.isEmpty else { return 0 }
        switch steps.removeFirst() {
        case let .bytes(text):
          let bytes = Array(text.utf8)
          for (index, byte) in bytes.enumerated() { buffer[index] = CChar(bitPattern: byte) }
          return bytes.count
        case let .rc(rc):
          return rc
        }
      },
      isEOF: { steps.isEmpty && eofAfter },
      now: { ticks.isEmpty ? 0 : ticks.removeFirst() },
      deadline: deadline,
      onChunk: { output += String(decoding: $0, as: UTF8.self); return true })
    return output
  }

  func test_output_split_by_quiet_stretches_is_returned_whole() throws {
    XCTAssertEqual(try run([.bytes("a"), .rc(LibSSH2Const.timeout), .bytes("b"), .rc(LibSSH2Const.eagain), .bytes("c")]), "abc")
  }

  func test_a_transport_error_mid_command_throws_instead_of_returning_partial_output() {
    XCTAssertThrowsError(try run([.bytes("sess"), .rc(-43)])) { error in
      XCTAssertEqual(error as? LibSSH2OpsError, .readFailed(-43))
    }
  }

  func test_zero_bytes_before_end_of_file_keeps_reading() throws {
    XCTAssertEqual(try run([.rc(0), .bytes("late")]), "late")
  }

  func test_a_command_quiet_past_its_deadline_times_out() {
    let quiet = [Step](repeating: .rc(LibSSH2Const.timeout), count: 5)
    XCTAssertThrowsError(try run(quiet, eofAfter: false, clock: [0, 30, 60, 91, 120, 150], deadline: 90)) { error in
      XCTAssertEqual(error as? SSHConnectError, .commandTimedOut)
    }
  }

  func test_without_a_deadline_a_quiet_stream_just_keeps_waiting() throws {
    let quiet = [Step](repeating: .rc(LibSSH2Const.timeout), count: 5) + [.bytes("done")]
    XCTAssertEqual(try run(quiet, clock: [0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000]), "done")
  }

  func test_a_consumer_that_says_stop_ends_the_read() throws {
    var chunks = 0
    try ExecReader.run(
      read: { buffer in buffer[0] = 65; return 1 },
      isEOF: { false },
      now: { 0 },
      deadline: nil,
      onChunk: { _ in chunks += 1; return chunks < 3 })
    XCTAssertEqual(chunks, 3)
  }
}
