import XCTest
@testable import TetherKit

final class ChatSlashTests: XCTestCase {
  private let commands = [
    ACPCommand(name: "review", description: "Review a PR", hint: "<pr>"),
    ACPCommand(name: "compact", description: "Clear history, keep a summary", hint: "<instructions>"),
    ACPCommand(name: "context", description: "Show context usage", hint: nil),
    ACPCommand(name: "config", description: "Open settings", hint: nil),
    ACPCommand(name: "recompute", description: "Redo", hint: nil),
    ACPCommand(name: "model", description: "Switch the model", hint: "<model>"),
    ACPCommand(name: "zebra", description: "Uses the compact path", hint: nil),
  ]

  func test_query_exists_only_while_the_draft_is_a_bare_command_name() {
    XCTAssertEqual(ChatSlash.query(in: "/"), "")
    XCTAssertEqual(ChatSlash.query(in: "/co"), "co")
    XCTAssertNil(ChatSlash.query(in: "/compact now"))
    XCTAssertNil(ChatSlash.query(in: "/compact "))
    XCTAssertNil(ChatSlash.query(in: "/a\nb"))
    XCTAssertNil(ChatSlash.query(in: "hello /co"))
    XCTAssertNil(ChatSlash.query(in: " /co"))
    XCTAssertNil(ChatSlash.query(in: ""))
  }

  func test_matches_rank_prefix_then_name_then_description_case_insensitively() {
    XCTAssertEqual(ChatSlash.matches(query: "co", commands: commands).map(\.name), ["compact", "config", "context", "recompute", "zebra"])
    XCTAssertEqual(ChatSlash.matches(query: "CO", commands: commands).map(\.name), ["compact", "config", "context", "recompute", "zebra"])
    XCTAssertEqual(ChatSlash.matches(query: "sum", commands: commands).map(\.name), ["compact"])
    XCTAssertEqual(ChatSlash.matches(query: "mod", commands: commands).map(\.name), ["model"])
    XCTAssertEqual(ChatSlash.matches(query: "re", commands: commands).map(\.name), ["recompute", "review"])
    XCTAssertEqual(ChatSlash.matches(query: "mp", commands: commands).map(\.name), ["compact", "recompute", "zebra"])
  }

  func test_a_bare_slash_lists_everything_alphabetically_and_limit_applies() {
    XCTAssertEqual(
      ChatSlash.matches(query: "", commands: commands).map(\.name),
      ["compact", "config", "context", "model", "recompute", "review", "zebra"])
    XCTAssertEqual(ChatSlash.matches(query: "", commands: commands, limit: 2).map(\.name), ["compact", "config"])
    XCTAssertTrue(ChatSlash.matches(query: "zzz", commands: commands).isEmpty)
  }

  func test_insertion_adds_a_trailing_space_and_flags_commands_that_take_input() {
    let compact = ChatSlash.insertion(for: commands[1])
    XCTAssertEqual(compact.text, "/compact ")
    XCTAssertTrue(compact.wantsInput)
    let context = ChatSlash.insertion(for: commands[2])
    XCTAssertEqual(context.text, "/context ")
    XCTAssertFalse(context.wantsInput)
  }
}
