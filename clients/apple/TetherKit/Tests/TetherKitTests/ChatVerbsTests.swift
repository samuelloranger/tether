import XCTest
@testable import TetherKit

final class ChatVerbsTests: XCTestCase {
  private let list = #"["Accomplishing","Flamb\xE9ing","Beboppin'","Zigzagging"]"#

  func test_the_official_list_is_read_and_unescaped() {
    XCTAssertEqual(ChatVerbs.parse("\(list)\n--- settings\n"), ["Accomplishing", "Flambéing", "Beboppin'", "Zigzagging"])
  }

  func test_spinner_verbs_append_or_replace_like_claude_code() {
    let append = ChatVerbs.parse(
      "\(list)\n--- settings\n{\"spinnerVerbs\":{\"mode\":\"append\",\"verbs\":[\"Shipping\"]}}")
    XCTAssertEqual(append.count, 5)
    XCTAssertEqual(append.last, "Shipping")
    let replace = ChatVerbs.parse(
      "\(list)\n--- settings\n{\"spinnerVerbs\":{\"mode\":\"replace\",\"verbs\":[\"Shipping\",\"Testing\"]}}")
    XCTAssertEqual(replace, ["Shipping", "Testing"])
    let empty = ChatVerbs.parse("\(list)\n--- settings\n{\"spinnerVerbs\":{\"mode\":\"replace\",\"verbs\":[]}}")
    XCTAssertEqual(empty.count, 4, "an empty replace keeps the default")
  }

  func test_without_claude_on_the_host_tethers_words_stand_in() {
    XCTAssertEqual(ChatVerbs.parse("--- settings\n").count, ChatVerbs.fallback.count)
    XCTAssertEqual(ChatVerbs.parse("").count, ChatVerbs.fallback.count)
  }

  func test_a_turn_keeps_its_word_and_turns_vary() {
    let verbs = (0..<50).map { "V\($0)" }
    XCTAssertEqual(ChatVerbs.pick(verbs, seed: 7), ChatVerbs.pick(verbs, seed: 7))
    XCTAssertGreaterThan(Set((0..<20).map { ChatVerbs.pick(verbs, seed: $0) }).count, 5)
    XCTAssertTrue(ChatVerbs.pick([], seed: -4).hasSuffix("…"))
  }

  func test_the_command_reads_the_installed_claude_and_the_settings() {
    XCTAssertTrue(ChatVerbs.command.hasPrefix("sh -c '"))
    XCTAssertTrue(ChatVerbs.command.contains("command -v claude"))
  }
}
