import XCTest
@testable import TetherKit

final class ChatCardTests: XCTestCase {
  func test_a_card_for_a_queued_prompt_follows_that_prompt() throws {
    var builder = ChatTranscriptBuilder()
    builder.apply(.userPrompt(text: "First request", atOffset: 0, requestId: .int(1)))
    builder.apply(.userPrompt(text: "Show weather", atOffset: 0, requestId: .int(2)))
    try builder.feed(Data("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"stopReason\":\"end_turn\"}}\n".utf8))
    try builder.feed(line(try fixtures()[0]))
    let user = try XCTUnwrap(builder.state.items.firstIndex { if case .user("Show weather", _, _, _) = $0.kind { return true }; return false })
    let card = try XCTUnwrap(builder.state.items.firstIndex { if case .card = $0.kind { return true }; return false })
    XCTAssertGreaterThan(card, user)
  }
  func test_captured_claude_and_codex_tool_results_render_cards_and_images() throws {
    let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/chat-card-adapter-results.json")
    let fixtures = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: [String: Any]])
    for (name, update) in fixtures {
      let data = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "method": "session/update", "params": ["sessionId": "s", "update": update]])
      guard case let .scopedUpdate(.toolCallUpdate(fields), _) = ACPDecoder.decode(data), let card = fields.card else { return XCTFail("No card for \(name)") }
      XCTAssertEqual(card.kind, name.split(separator: "-").last.map(String.init), name)
      if card.kind == "image" { XCTAssertEqual(card.image?.pixelWidth, 1, name) }
    }
  }
  func test_pending_actions_survive_state_restore_and_finish_with_their_prompt() throws {
    let fixture = try fixtures()[1]
    var builder = ChatTranscriptBuilder()
    try builder.feed(line(fixture))
    let card = try XCTUnwrap(cards(builder.state).first)
    let container = try XCTUnwrap(card.payload.containers?.first)
    let request = try XCTUnwrap(card.request("restart", container: container))
    builder.apply(.userPrompt(text: request, atOffset: builder.consumedOffset, requestId: .int(7)))
    XCTAssertTrue(builder.state.cardActionPending(card.id))
    let restored = try JSONDecoder().decode(ChatState.self, from: JSONEncoder().encode(builder.state))
    XCTAssertTrue(restored.cardActionPending(card.id))
    try builder.feed(Data("{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"stopReason\":\"end_turn\"}}\n".utf8))
    XCTAssertFalse(builder.state.cardActionPending(card.id))
    XCTAssertFalse(request.contains("cardId"))
  }
  private func fixtures() throws -> [[String: Any]] {
    let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/chat-cards.json")
    return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [[String: Any]])
  }

  private func line(_ card: [String: Any], image: Bool = false, publisher: Bool = true, id: String? = nil) throws -> Data {
    let text = ChatCard.marker + String(decoding: try JSONSerialization.data(withJSONObject: card), as: UTF8.self)
    let content: [[String: Any]] = image ? [["type": "content", "content": ["type": "image", "mimeType": "image/png",
      "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1cAAAAASUVORK5CYII="]]] : []
    var update: [String: Any] = [
      "sessionUpdate": "tool_call_update", "toolCallId": id ?? "publish-\(card["id"]!)", "status": "completed",
      "rawOutput": ["content": [["type": "text", "text": text]]], "content": content]
    if publisher { update["_meta"] = ["tether": ["card": true]] }
    return try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "method": "session/update", "params": ["sessionId": "s", "update": update]]) + Data([10])
  }

  func test_a_card_in_another_tools_output_is_not_rendered() throws {
    var builder = ChatTranscriptBuilder()
    let start = #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"bash-1","title":"cat page.html","kind":"execute","status":"pending"}}}"#
    try builder.feed(Data((start + "\n").utf8))
    try builder.feed(line(try fixtures()[1], publisher: false, id: "bash-1"))
    XCTAssertTrue(cards(builder.state).isEmpty)
  }

  func test_a_codex_call_named_by_its_title_renders_its_card() throws {
    var builder = ChatTranscriptBuilder()
    let start = #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"mcp-1","title":"mcp.tether-cards.tether_publish_card","kind":"execute","status":"pending"}}}"#
    try builder.feed(Data((start + "\n").utf8))
    try builder.feed(line(try fixtures()[0], publisher: false, id: "mcp-1"))
    XCTAssertEqual(cards(builder.state).count, 1)
  }

  private func cards(_ state: ChatState) -> [ChatCard] {
    state.items.compactMap { if case let .card(card) = $0.kind { return card }; return nil }
  }

  func test_all_cards_decode_and_an_image_is_stored_as_a_reference() throws {
    let fixtures = try fixtures()
    var builder = ChatTranscriptBuilder()
    for (index, fixture) in fixtures.enumerated() { try builder.feed(line(fixture, image: index == 2)) }
    let found = cards(builder.state)
    XCTAssertEqual(found.map(\.kind), ["weather", "docker", "image"])
    XCTAssertEqual(found[2].image?.pixelWidth, 1)
    XCTAssertNil(found[1].payload.containers?[1].cpuPercent)
    let snapshot = try JSONEncoder().encode(builder.state)
    XCTAssertEqual(try JSONDecoder().decode(ChatState.self, from: snapshot), builder.state)
  }

  func test_revisions_keep_position_and_chunked_replay_matches_live() throws {
    var fixtures = try fixtures()
    var log = Data()
    for fixture in fixtures { log.append(try line(fixture)) }
    fixtures[0]["revision"] = 2
    fixtures[0]["title"] = "Updated weather"
    log.append(try line(fixtures[0]))
    fixtures[0]["revision"] = 1
    log.append(try line(fixtures[0]))
    let expected = try ChatTranscriptBuilder.replay(log: log, journal: ChatJournal())
    XCTAssertEqual(cards(expected).map(\.revision), [2, 1, 1])
    XCTAssertEqual(cards(expected).first?.title, "Updated weather")
    var builder = ChatTranscriptBuilder()
    for byte in log { try builder.feed(Data([byte])) }
    XCTAssertEqual(builder.state, expected)
  }

  func test_unknown_versions_use_fallback_and_bad_payloads_are_ignored() throws {
    var fixture = try fixtures()[0]
    fixture["version"] = 99
    var builder = ChatTranscriptBuilder()
    try builder.feed(line(fixture))
    XCTAssertEqual(cards(builder.state).count, 1)
    XCTAssertFalse(try XCTUnwrap(cards(builder.state).first).supported)
    fixture["revision"] = -1
    try builder.feed(line(fixture))
    XCTAssertEqual(cards(builder.state).count, 1)
    fixture["version"] = 1
    fixture["revision"] = 3
    fixture["payload"] = ["location": "missing required observations"]
    try builder.feed(line(fixture))
    XCTAssertEqual(cards(builder.state).first?.revision, 1)
  }
}
