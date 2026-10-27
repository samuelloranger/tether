import XCTest
@testable import TetherKit

final class ACPQuestionClientTests: XCTestCase {
  private let answer: [String: ChatQuestionValue] = ["question_0": .text("red"), "question_0_custom": .text("a note")]

  private func waitUntil(_ client: ACPClient, _ predicate: @escaping (ChatState) -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(3)
    while Date() < end {
      if predicate(await client.state) { return true }
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return false
  }

  private func written(_ stream: ScriptedByteStream) -> [NSDictionary] {
    stream.writtenText.split(separator: "\n").compactMap {
      (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? NSDictionary
    }
  }

  private func replies(_ stream: ScriptedByteStream) -> [NSDictionary] {
    written(stream).filter { $0["method"] == nil && $0["id"] as? Int == 0 }
  }

  /// A client holding the recorded request, still unanswered.
  private func pending(
    store: InMemoryChatJournalStore = InMemoryChatJournalStore(ACPFixture.Elicitation.journal())
  ) async throws -> (ACPClient, ScriptedByteStream, InMemoryChatJournalStore) {
    let inner = ScriptedByteStream()
    let client = ACPClient(stream: inner, store: store)
    await client.startReading()
    inner.push(ACPFixture.Elicitation.log(ACPFixture.Elicitation.requestLine + 1))
    let seen = await waitUntil(client) { !$0.pendingQuestions.isEmpty }
    XCTAssertTrue(seen)
    return (client, inner, store)
  }

  func test_new_chats_advertise_the_form_elicitation_capability() async throws {
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream)
    await client.startReading()
    Task { _ = try? await client.initialize() }
    let sent = await eventually { stream.writtenText.contains("\"method\":\"initialize\"") }
    XCTAssertTrue(sent)
    let params = try XCTUnwrap(written(stream).first?["params"] as? NSDictionary)
    let capabilities = try XCTUnwrap(params["clientCapabilities"] as? NSDictionary)
    XCTAssertEqual(capabilities["elicitation"] as? NSDictionary, ["form": [:]] as NSDictionary)
    XCTAssertEqual(capabilities["terminal"] as? Bool, false)
  }

  func test_new_chats_advertise_notices_compaction_and_terminal_output_but_not_air() async throws {
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream)
    await client.startReading()
    Task { _ = try? await client.initialize() }
    let sent = await eventually { stream.writtenText.contains("\"method\":\"initialize\"") }
    XCTAssertTrue(sent)
    let params = try XCTUnwrap(written(stream).first?["params"] as? NSDictionary)
    let capabilities = try XCTUnwrap(params["clientCapabilities"] as? NSDictionary)
    XCTAssertEqual(capabilities["session"] as? NSDictionary, ["notices": [:], "compaction": [:]] as NSDictionary)
    XCTAssertEqual(capabilities["_meta"] as? NSDictionary, ["terminal_output": true] as NSDictionary)
    XCTAssertFalse(stream.writtenText.contains("jetbrains"))
  }

  func test_an_accepted_answer_is_written_journaled_and_equals_a_replay() async throws {
    let (client, stream, store) = try await pending()
    try await client.answerQuestion(requestId: .int(0), action: .accept, content: answer)

    let reply = try XCTUnwrap(replies(stream).first)
    let result = try XCTUnwrap(reply["result"] as? NSDictionary)
    XCTAssertEqual(result["action"] as? String, "accept")
    XCTAssertEqual(result["content"] as? NSDictionary, ["question_0": "red", "question_0_custom": "a note"] as NSDictionary)
    let entry = try XCTUnwrap(store.load().entries.last)
    XCTAssertEqual(entry.kind, .questionAnswer)
    XCTAssertEqual(entry.content, answer)
    XCTAssertEqual(entry.offset, ACPFixture.Elicitation.answerOffset)

    let live = await client.state
    XCTAssertTrue(live.pendingQuestions.isEmpty)
    XCTAssertEqual(
      live, try ChatTranscriptBuilder.replay(log: ACPFixture.Elicitation.log(ACPFixture.Elicitation.requestLine + 1), journal: store.load()))

    try await client.answerQuestion(requestId: .int(0), action: .decline)
    XCTAssertEqual(replies(stream).count, 1, "an answered question ignores a second answer")
  }

  func test_a_multi_select_answer_is_sent_as_an_array_and_decline_sends_no_content() async throws {
    let (client, stream, _) = try await pending()
    try await client.answerQuestion(requestId: .int(0), action: .decline, content: answer)
    let result = try XCTUnwrap(replies(stream).first?["result"] as? NSDictionary)
    XCTAssertEqual(result, ["action": "decline"] as NSDictionary)
    XCTAssertEqual(
      ChatQuestionValue.list(["a", "b"]).json as? [String], ["a", "b"])
    XCTAssertEqual(ChatQuestionValue.flag(true).json as? Bool, true)
  }

  func test_an_answer_that_cannot_be_written_is_taken_back_and_can_be_retried() async throws {
    let inner = ScriptedByteStream()
    let stream = SwitchableWriteStream(inner)
    let store = InMemoryChatJournalStore(ACPFixture.Elicitation.journal())
    let client = ACPClient(stream: stream, store: store)
    await client.startReading()
    inner.push(ACPFixture.Elicitation.log(ACPFixture.Elicitation.requestLine + 1))
    let seen = await waitUntil(client) { !$0.pendingQuestions.isEmpty }
    XCTAssertTrue(seen)

    do {
      try await client.answerQuestion(requestId: .int(0), action: .accept, content: answer)
      XCTFail("the write was refused")
    } catch {}
    let after = await client.state
    XCTAssertEqual(after.pendingQuestions.map(\.requestId), [.int(0)], "the card reopens")
    XCTAssertFalse(store.load().entries.contains { $0.kind == .questionAnswer })

    stream.failing = false
    try await client.answerQuestion(requestId: .int(0), action: .accept, content: answer)
    let answered = await client.state
    XCTAssertTrue(answered.pendingQuestions.isEmpty)
    XCTAssertEqual(store.load().entries.filter { $0.kind == .questionAnswer }.count, 1)
    XCTAssertEqual(replies(inner).count, 1)
  }

  func test_cancelling_the_turn_cancels_the_pending_question() async throws {
    let (client, stream, store) = try await pending()
    try await client.cancel()
    XCTAssertTrue(written(stream).contains { $0["method"] as? String == "session/cancel" })
    let result = try XCTUnwrap(replies(stream).first?["result"] as? NSDictionary)
    XCTAssertEqual(result, ["action": "cancel"] as NSDictionary)
    let state = await client.state
    XCTAssertTrue(state.pendingQuestions.isEmpty)
    guard case let .question(question)? = state.items.first(where: { if case .question = $0.kind { true } else { false } })?.kind
    else { return XCTFail() }
    XCTAssertEqual(question.state, .cancelled)
    XCTAssertEqual(store.load().entries.last?.optionId, "cancel")
  }

  func test_the_end_of_the_turn_clears_a_question_nobody_answered() async throws {
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream, store: InMemoryChatJournalStore(ACPFixture.Elicitation.journal()))
    await client.startReading()
    stream.push(ACPFixture.Elicitation.log())
    let done = await waitUntil(client) { $0.lastStopReason == "end_turn" }
    XCTAssertTrue(done)
    let state = await client.state
    XCTAssertTrue(state.pendingQuestions.isEmpty)
    XCTAssertEqual(
      state, try ChatTranscriptBuilder.replay(log: ACPFixture.Elicitation.log(), journal: ACPFixture.Elicitation.journal()))
  }

  func test_host_answers_for_a_question_are_journaled_and_resolve_it_like_a_replay() async throws {
    let (client, _, store) = try await pending()
    await client.adoptHostAnswers([.int(0): "green"])
    let state = await client.state
    guard case let .question(question)? = state.items.first(where: { if case .question = $0.kind { true } else { false } })?.kind
    else { return XCTFail() }
    XCTAssertEqual(question.state, .answered(["question_0": .text("green")]))
    XCTAssertEqual(store.load().entries.last?.kind, .hostAnswer)
    XCTAssertEqual(
      state, try ChatTranscriptBuilder.replay(log: ACPFixture.Elicitation.log(ACPFixture.Elicitation.requestLine + 1), journal: store.load()))

    let declined = try await pending()
    await declined.0.adoptHostAnswers([.int(0): "declined"])
    let declinedState = await declined.0.state
    XCTAssertTrue(declinedState.pendingQuestions.isEmpty)
  }

  func test_a_resumed_client_with_a_journaled_answer_shows_the_question_resolved() async throws {
    let journal = ACPFixture.Elicitation.journal(answer: answer)
    let stream = ScriptedByteStream()
    let client = ACPClient(stream: stream, store: InMemoryChatJournalStore(journal))
    try await client.start(cwd: "/work/project")
    XCTAssertEqual(stream.writtenText, "", "no handshake on resume")
    stream.push(ACPFixture.Elicitation.log(ACPFixture.Elicitation.requestLine + 1))
    let seen = await waitUntil(client) { state in
      state.items.contains { if case .question = $0.kind { true } else { false } }
    }
    XCTAssertTrue(seen)
    let state = await client.state
    XCTAssertTrue(state.pendingQuestions.isEmpty)
    XCTAssertEqual(stream.writtenText, "", "a replayed question is not answered again")
  }
}
