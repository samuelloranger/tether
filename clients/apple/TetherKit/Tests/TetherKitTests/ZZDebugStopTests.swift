import XCTest
@testable import TetherKit

final class ZZDebugStopTests: XCTestCase {
  func test_debug() {
    var s = ChatReducer.reduce(ChatState(), .userPrompt(text: "first", atOffset: 0, requestId: nil))
    s = ChatReducer.reduce(s, .userPrompt(text: "tidy", atOffset: 0, requestId: .int(4)))
    print("DBG before turn=\(s.turn) queued=\(s.queuedTexts)")
    s = ChatReducer.reduce(s, .cancelRequested)
    print("DBG after turn=\(s.turn) items=\(s.items.map { "\($0.kind)".prefix(30) })")
  }
}
