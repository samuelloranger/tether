import Foundation
@testable import TetherKit

/// The recorded agent turn: `< ` lines are agent to client, `> ` the reverse.
enum ACPFixture {
  static let agentLines: [String] = lines(prefix: "< ")
  static let clientLines: [String] = lines(prefix: "> ")

  private static func lines(prefix: String, file: String = "acp-turn-write.log") -> [String] {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("Fixtures/\(file)")
    let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    return text.split(separator: "\n").filter { $0.hasPrefix(prefix) }.map { String($0.dropFirst(prefix.count)) }
  }

  /// The recorded controls session: config options, mode changes and a `/context` prompt.
  enum Controls {
    static let agentLines: [String] = ACPFixture.lines(prefix: "< ", file: "acp-controls.log")

    static func line(containing needle: String, after: Int = -1) -> Int {
      agentLines.indices.first { $0 > after && agentLines[$0].contains(needle) } ?? -1
    }

    static func log(_ range: Range<Int>) -> Data {
      Data((agentLines[range].joined(separator: "\n") + "\n").utf8)
    }
  }

  static func index(containing needle: String) -> Int {
    agentLines.firstIndex { $0.contains(needle) } ?? -1
  }

  /// The first `count` agent lines as the holder's byte log would hold them.
  static func log(_ count: Int? = nil, extra: [String] = []) -> Data {
    let selected = Array(agentLines.prefix(count ?? agentLines.count)) + extra
    return Data((selected.joined(separator: "\n") + "\n").utf8)
  }

  static func offset(after lineCount: Int) -> Int {
    agentLines.prefix(lineCount).reduce(0) { $0 + $1.utf8.count + 1 }
  }

  static let promptText = "Read hello.txt, then create out.txt containing the word hi. Keep your reply to one short sentence."
  /// The prompt goes out after `session/new` answers.
  static var promptOffset: Int { offset(after: index(containing: "\"sessionId\":\"sess-1\",\"modes\"") + 1) }
  /// The answer goes out after the permission request arrives.
  static var answerOffset: Int { offset(after: index(containing: "session/request_permission") + 1) }

  static var journal: ChatJournal {
    var journal = ChatJournal()
    journal.sessionId = "sess-1"
    journal.entries = [
      .init(kind: .prompt, offset: promptOffset, text: promptText),
      .init(kind: .answer, offset: answerOffset, requestId: .int(0), optionId: "allow-once"),
    ]
    return journal
  }
}

struct SeededGenerator: RandomNumberGenerator {
  private var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}

/// Reads pass through; writes fail while `failing` is set, as a socket the host dropped would.
final class SwitchableWriteStream: TerminalByteStream, @unchecked Sendable {
  private let inner: ScriptedByteStream
  private let flag = LockedBox(true)
  init(_ inner: ScriptedByteStream, failing: Bool = true) {
    self.inner = inner
    flag.value = failing
  }
  var failing: Bool {
    get { flag.value }
    set { flag.value = newValue }
  }
  func read() async throws -> Data? { try await inner.read() }
  func write(_ bytes: Data) async throws {
    if failing { throw SSHConnectError.transport("closed") }
    try await inner.write(bytes)
  }
  func close() async { await inner.close() }
}
