import XCTest
@testable import TetherKit

/// Two clients on one holder that takes several: each sees the other's prompts through the
/// `_tether/client` echoes, and its own echo adds nothing.
final class ACPMultiClientTests: XCTestCase {
  private func echo(_ client: String, _ line: String) -> String {
    #"{"jsonrpc":"2.0","method":"_tether/client","params":{"client":"\#(client)","message":\#(line)}}"# + "\n"
  }

  private func users(_ state: ChatState) -> [String] {
    state.items.compactMap { if case let .user(text, _, _, _) = $0.kind { text } else { nil } }
  }

  private let phonePrompt =
    #"{"jsonrpc":"2.0","id":"ph-3","method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"text","text":"from the phone"}]}}"#

  private func poll(_ condition: () async -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(3)
    while Date() < end {
      if await condition() { return true }
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return false
  }

  private func named(_ id: String) -> InMemoryChatJournalStore {
    var journal = ChatJournal()
    journal.clientId = id
    return InMemoryChatJournalStore(journal)
  }

  func test_another_clients_lines_become_its_prompts_answers_and_stop_and_ours_are_skipped() {
    var journal = ChatJournal()
    journal.clientId = "me"
    var builder = ChatTranscriptBuilder(journal: journal)
    let log =
      echo("ph", phonePrompt)
      + echo("me", #"{"jsonrpc":"2.0","id":"me-1","method":"session/prompt","params":{"sessionId":"s1","prompt":[]}}"#)
      + #"{"jsonrpc":"2.0","id":"ph-3","result":{"stopReason":"end_turn"}}"# + "\n"
    XCTAssertNoThrow(try builder.feed(Data(log.utf8)))
    XCTAssertEqual(users(builder.state), ["from the phone"])
    XCTAssertEqual(builder.state.turn, .idle)

    let answer = ACPDecoder.decode(
      Data(echo("ph", #"{"jsonrpc":"2.0","id":7,"result":{"outcome":{"outcome":"selected","optionId":"allow"}}}"#).utf8))
    XCTAssertEqual(answer, .clientEcho(client: "ph", line: .permissionAnswer(id: .int(7), optionId: "allow")))
    let question = ACPDecoder.decode(
      Data(echo("ph", #"{"jsonrpc":"2.0","id":2,"result":{"action":"accept","content":{"c":"green","ok":true,"m":["a"]}}}"#).utf8))
    XCTAssertEqual(
      question,
      .clientEcho(
        client: "ph",
        line: .questionAnswer(id: .int(2), action: .accept, content: ["c": .text("green"), "ok": .flag(true), "m": .list(["a"])])))
    let stop = ACPDecoder.decode(
      Data(echo("ph", #"{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s1"}}"#).utf8))
    XCTAssertEqual(stop, .clientEcho(client: "ph", line: .cancel))
  }

  func test_a_joining_client_learns_the_session_from_the_log_and_sends_its_own_ids() async throws {
    let stream = ScriptedByteStream()
    let store = named("me")
    let client = ACPClient(stream: stream, store: store)
    await client.startJoining()
    stream.push(Data((#"{"jsonrpc":"2.0","id":"ph-2","result":{"sessionId":"s1"}}"# + "\n" + echo("ph", phonePrompt)).utf8))
    let learned = await poll { await client.sessionId == "s1" }
    XCTAssertTrue(learned)
    XCTAssertEqual(stream.writtenText, "", "no handshake of its own")
    try await client.prompt(text: "from the mac")
    let sent = try XCTUnwrap(
      (try? JSONSerialization.jsonObject(with: Data(stream.writtenText.utf8))) as? NSDictionary)
    XCTAssertEqual(sent["id"] as? String, "me-1")
    XCTAssertEqual((sent["params"] as? NSDictionary)?["sessionId"] as? String, "s1")
    let state = await client.state
    XCTAssertEqual(users(state), ["from the phone", "from the mac"])
    XCTAssertEqual(store.load().sessionId, "s1", "the next open resumes")
  }

  func test_an_unnamed_client_keeps_number_ids_and_does_not_join() async throws {
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream, store: InMemoryChatJournalStore())
    await client.startReading()
    stream.push(Data(echo("ph", phonePrompt).utf8))
    let shown = await poll { self.users(await client.state) == ["from the phone"] }
    XCTAssertTrue(shown)
    let session = await client.sessionId
    XCTAssertNil(session)
  }
}
