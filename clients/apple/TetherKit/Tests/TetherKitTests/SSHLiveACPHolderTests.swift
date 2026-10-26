import Foundation
import XCTest
@testable import TetherKit

/// Skipped unless the live SSH variables of `SSHLiveConnectTests` are set. The host also needs a
/// `tether` with `acp` on its PATH or in ~/.local/bin; no real agent is started.
final class SSHLiveACPHolderTests: XCTestCase {
  /// A stand-in agent: answers each stdin line with one JSON line.
  private static let fakeAgent = #"sh -c 'while IFS= read -r line; do printf "{\"echo\":\"%s\"}\n" "$line"; done'"#

  private func reply(_ word: String) -> Data { Data("{\"echo\":\"\(word)\"}\n".utf8) }

  private func read(_ stream: any TerminalByteStream, count: Int, within seconds: TimeInterval = 15) async throws -> Data {
    let watchdog = Task {
      try await Task.sleep(for: .seconds(seconds))
      await stream.close()
    }
    defer { watchdog.cancel() }
    var received = Data()
    while received.count < count, let chunk = try await stream.read() { received.append(chunk) }
    return received
  }

  /// Bytes that arrive within `seconds`; none is the expected answer once everything was delivered.
  private func quiet(_ stream: any TerminalByteStream, for seconds: TimeInterval) async -> Data {
    let watchdog = Task {
      try? await Task.sleep(for: .seconds(seconds))
      await stream.close()
    }
    defer { watchdog.cancel() }
    var extra = Data()
    while let chunk = try? await stream.read() { extra.append(chunk) }
    return extra
  }

  func test_live_a_reattach_from_the_offset_delivers_every_line_exactly_once() async throws {
    let (config, store) = try SSHLiveConnectTests.liveConfig()
    let name = "chat-live" + String((0..<6).map { _ in "abcdefghijklmnopqrstuvwxyz0123456789".randomElement()! })
    addTeardownBlock {
      _ = try? await ControlConnection(config: config, store: store).exec(ACPHostCommand.kill(name: name))
    }

    let first = try await SSHConnector.connectExec(
      config: config, store: store,
      command: ACPHostCommand.attach(name: name, cwd: "/tmp", spawn: true, spawnCommand: Self.fakeAgent))
    try await first.write(Data("one\n".utf8))
    try await first.write(Data("two\n".utf8))
    let head = reply("one") + reply("two")
    let got = try await read(first, count: head.count)
    XCTAssertEqual(got, head)
    await first.close()

    let second = try await SSHConnector.connectExec(
      config: config, store: store,
      command: ACPHostCommand.attach(name: name, cwd: "/tmp", spawn: false, from: head.count))
    try await second.write(Data("three\n".utf8))
    let third = try await read(second, count: reply("three").count)
    XCTAssertEqual(third, reply("three"), "the log resumes exactly at the offset: no gap, no repeat")
    let extra = await quiet(second, for: 1)
    XCTAssertTrue(extra.isEmpty, "nothing is delivered twice")
    await second.close()

    let full = try await SSHConnector.connectExec(
      config: config, store: store,
      command: ACPHostCommand.attach(name: name, cwd: "/tmp", spawn: false, from: 0))
    let everything = try await read(full, count: head.count + reply("three").count)
    XCTAssertEqual(everything, head + reply("three"))
    await full.close()
  }
}
