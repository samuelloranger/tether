import XCTest
@testable import TetherKit

final class ZZDebugStopTests: XCTestCase {
  func test_debug() async throws {
    var journal = ChatJournal()
    journal.sessionId = "sess-1"
    journal.nextRequestId = 4
    journal.entries = [.init(kind: .prompt, offset: ACPFixture.promptOffset, text: ACPFixture.promptText)]
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream, store: InMemoryChatJournalStore(journal))
    await client.startReading()
    stream.push(ACPFixture.log(ACPFixture.index(containing: "session/request_permission")))
    try await Task.sleep(nanoseconds: 500_000_000)
    var s = await client.state
    print("DBG A turn=\(s.turn) items=\(s.items.map { "\($0.kind)".prefix(20) })")
    try await client.prompt(text: "tidy")
    s = await client.state
    print("DBG B turn=\(s.turn) queued=\(s.queuedTexts)")
    _ = try await client.cancel()
    s = await client.state
    print("DBG C turn=\(s.turn) items=\(s.items.map { "\($0.kind)".prefix(20) })")
  }
}
