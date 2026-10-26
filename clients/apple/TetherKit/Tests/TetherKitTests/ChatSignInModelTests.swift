import XCTest
@testable import TetherKit

@MainActor
final class ChatSignInModelTests: XCTestCase {
  private func model(_ stream: ScriptedByteStream, journal: ChatJournal) -> ChatSessionModel {
    ChatSessionModel(
      chatName: "chat-s", cwd: "/work/project", readOnly: false, store: InMemoryChatJournalStore(journal),
      hostLabel: "homelab"
    ) { _, _ in stream }
  }

  private func line(_ json: String) -> Data { Data((json + "\n").utf8) }

  func test_a_signed_out_agent_leaves_a_live_chat_with_the_sign_in_row() async throws {
    let stream = ScriptedByteStream()
    let model = model(stream, journal: ChatJournal())
    Task { await model.connect() }
    _ = await eventually { stream.writtenText.contains("\"method\":\"initialize\"") }
    stream.push(line("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"agentCapabilities\":{\"loadSession\":true}}}"))
    _ = await eventually { stream.writtenText.contains("session/new") }
    stream.push(line("{\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"code\":-32000,\"message\":\"Authentication required\"}}"))
    let shown = await eventually { model.needsSignIn }
    XCTAssertTrue(shown)
    XCTAssertNil(model.notice, "not reported as an unreachable host")
    XCTAssertNotEqual(model.link.phase, .lost)
    XCTAssertEqual(model.hostLabel, "homelab")
    XCTAssertEqual(
      ChatSignInCopy.message(host: "homelab"),
      "Claude isn't signed in on homelab. Open a terminal there and run claude to sign in.")

    _ = await eventually(timeout: 4) { model.link.phase == .live }
    model.retrySignIn()
    XCTAssertEqual(model.signInRetry, .checking)
    let again = await eventually { stream.writtenText.components(separatedBy: "\"method\":\"initialize\"").count == 3 }
    XCTAssertTrue(again, "the handshake repeats on the same connection")
    stream.push(line("{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"agentCapabilities\":{}}}"))
    let asked = await eventually { stream.writtenText.components(separatedBy: "session/new").count == 3 }
    XCTAssertTrue(asked)
    stream.push(line("{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{\"sessionId\":\"sess-n\"}}"))
    let recovered = await eventually { !model.needsSignIn && model.signInRetry == .idle }
    XCTAssertTrue(recovered)
    model.leave()
  }

  func test_a_second_refusal_is_reported_as_still_signed_out() async throws {
    let stream = ScriptedByteStream()
    let model = model(stream, journal: ChatJournal())
    Task { await model.connect() }
    _ = await eventually { stream.writtenText.contains("\"method\":\"initialize\"") }
    stream.push(line("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}"))
    _ = await eventually { stream.writtenText.contains("session/new") }
    stream.push(line("{\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"code\":-32000,\"message\":\"Authentication required\"}}"))
    _ = await eventually { model.needsSignIn }
    _ = await eventually(timeout: 4) { model.link.phase == .live }
    model.retrySignIn()
    stream.push(line("{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{}}"))
    _ = await eventually { stream.writtenText.components(separatedBy: "session/new").count == 3 }
    stream.push(line("{\"jsonrpc\":\"2.0\",\"id\":4,\"error\":{\"code\":-32000,\"message\":\"Authentication required\"}}"))
    let still = await eventually { model.signInRetry == .stillSignedOut }
    XCTAssertTrue(still)
    XCTAssertEqual(model.state.items.filter { $0.kind == .signedOut }.count, 1)
    model.leave()
  }

  func test_a_message_can_be_sent_while_the_agent_works_and_shows_as_queued() async throws {
    var journal = ChatJournal()
    journal.sessionId = "sess-1"
    journal.nextRequestId = 4
    journal.entries = [.init(kind: .prompt, offset: ACPFixture.promptOffset, text: ACPFixture.promptText)]
    let stream = ScriptedByteStream()
    let model = model(stream, journal: journal)
    Task { await model.connect() }
    stream.push(ACPFixture.log(ACPFixture.index(containing: "session/request_permission")))
    let live = await eventually(timeout: 4) { model.link.phase == .live && model.state.turn == .working }
    XCTAssertTrue(live)
    XCTAssertTrue(model.canSend)
    XCTAssertTrue(model.send("and then tidy up"))
    let sent = await eventually { stream.writtenText.contains("and then tidy up") }
    XCTAssertTrue(sent)
    let queued = await eventually { model.state.queuedItemIds.count == 1 }
    XCTAssertTrue(queued)
    XCTAssertEqual(model.state.turn, .working)

    model.cancel()
    let stopped = await eventually { stream.writtenText.contains("session/cancel") }
    XCTAssertTrue(stopped)
    let cleared = await eventually { model.state.queuedItemIds.isEmpty }
    XCTAssertTrue(cleared)
    XCTAssertEqual(model.state.items.last?.kind, .notice("Stopped"))
    model.leave()
  }
}
