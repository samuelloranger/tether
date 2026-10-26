import XCTest
@testable import TetherKit

@MainActor
final class ChatMentionTests: XCTestCase {
  func test_a_word_that_starts_with_at_is_a_token_up_to_the_cursor() {
    let token = ChatMention.token(in: "look at @src/ma", cursor: nil)
    XCTAssertEqual(token, .init(range: 8..<15, query: "src/ma"))
    XCTAssertEqual(ChatMention.token(in: "@", cursor: 1), .init(range: 0..<1, query: ""))
    XCTAssertEqual(ChatMention.token(in: "@a b", cursor: 2), .init(range: 0..<2, query: "a"))
  }

  func test_an_email_like_word_or_a_mid_word_at_never_triggers() {
    XCTAssertNil(ChatMention.token(in: "mail me@example.com", cursor: nil))
    XCTAssertNil(ChatMention.token(in: "me@", cursor: nil))
    XCTAssertNil(ChatMention.token(in: "a@b @", cursor: 3))
    XCTAssertNil(ChatMention.token(in: "(@src", cursor: nil))
    XCTAssertNil(ChatMention.token(in: "@a@b", cursor: nil))
  }

  func test_the_token_ends_where_the_cursor_leaves_it() {
    XCTAssertNil(ChatMention.token(in: "@src/main.swift and more", cursor: 17))
    XCTAssertNil(ChatMention.token(in: "@src ", cursor: 5))
    XCTAssertNil(ChatMention.token(in: "hello", cursor: 3))
    XCTAssertNil(ChatMention.token(in: "@src", cursor: 0))
    XCTAssertEqual(ChatMention.token(in: "@src/main end", cursor: 4)?.range, 0..<9)
    XCTAssertEqual(ChatMention.token(in: "@src/main end", cursor: 4)?.query, "src")
  }

  func test_a_cursor_past_the_end_is_clamped_and_a_newline_ends_a_word() {
    XCTAssertEqual(ChatMention.token(in: "x\n@ab", cursor: 99)?.query, "ab")
    XCTAssertNil(ChatMention.token(in: "@ab\n", cursor: 4))
  }

  func test_matching_is_a_case_insensitive_subsequence() {
    let files = ["Sources/App/Main.swift", "README.md", "docs/guide.md"]
    XCTAssertEqual(ChatMention.matches(query: "rdm", files: files).map(\.path), ["README.md"])
    XCTAssertEqual(ChatMention.matches(query: "MAIN", files: files).map(\.path), ["Sources/App/Main.swift"])
    XCTAssertTrue(ChatMention.matches(query: "zzz", files: files).isEmpty)
  }

  func test_a_file_name_match_beats_a_path_match_then_shorter_then_listed_order() {
    let files = [
      "config/app/settings.json",   // path only
      "src/config.swift",           // name prefix, longer
      "config.yml",                 // name prefix, shortest
      "lib/my-config.ts",           // name contains
      "src/c-o-n-f-i-g.txt",        // name scattered
      "src/config.swiftx",          // name prefix, same length class as swift but later
    ]
    XCTAssertEqual(
      ChatMention.matches(query: "config", files: files).map(\.path),
      ["config.yml", "src/config.swift", "src/config.swiftx", "lib/my-config.ts", "src/c-o-n-f-i-g.txt", "config/app/settings.json"])
  }

  func test_equal_matches_keep_the_listed_order() {
    let files = ["b/x.txt", "a/x.txt", "c/x.txt"]
    XCTAssertEqual(ChatMention.matches(query: "x", files: files).map(\.path), files)
  }

  func test_an_empty_query_lists_the_first_entries_as_listed_up_to_the_limit() {
    let files = (0..<10).map { "f\($0).txt" }
    XCTAssertEqual(ChatMention.matches(query: "", files: files, limit: 3).map(\.path), ["f0.txt", "f1.txt", "f2.txt"])
    XCTAssertTrue(ChatMention.matches(query: "", files: files, limit: 0).isEmpty)
  }

  func test_a_match_splits_into_a_name_and_a_folder() {
    let nested = ChatMention.Match(path: "Sources/App/Main.swift")
    XCTAssertEqual(nested.name, "Main.swift")
    XCTAssertEqual(nested.folder, "Sources/App/")
    let top = ChatMention.Match(path: "README.md")
    XCTAssertEqual(top.name, "README.md")
    XCTAssertEqual(top.folder, "")
  }

  func test_picking_replaces_the_token_and_adds_a_trailing_space() {
    let text = "read @sr and fix"
    let token = ChatMention.token(in: text, cursor: 8)!
    let result = ChatMention.insertion(in: text, token: token, path: "src/main.swift")
    XCTAssertEqual(result.text, "read @src/main.swift and fix")
    XCTAssertEqual(result.cursor, "read @src/main.swift ".count)
  }

  func test_picking_at_the_end_leaves_one_trailing_space_and_the_cursor_after_it() {
    let text = "see @RE"
    let token = ChatMention.token(in: text, cursor: nil)!
    let result = ChatMention.insertion(in: text, token: token, path: "README.md")
    XCTAssertEqual(result.text, "see @README.md ")
    XCTAssertEqual(result.cursor, result.text.count)
  }

  func test_picking_replaces_the_rest_of_the_word_after_the_cursor() {
    let text = "@sr/old.txt tail"
    let token = ChatMention.token(in: text, cursor: 3)!
    XCTAssertEqual(ChatMention.insertion(in: text, token: token, path: "src/new.txt").text, "@src/new.txt tail")
  }

  // MARK: file list

  /// What `sh` makes of one single-quoted word, enough to read back what shellQuote wrote.
  private func unquote(_ quoted: String) -> String {
    var out = ""
    var inSingle = false
    var inDouble = false
    for character in quoted {
      if inSingle {
        if character == "'" { inSingle = false } else { out.append(character) }
      } else if inDouble {
        if character == "\"" { inDouble = false } else { out.append(character) }
      } else if character == "'" {
        inSingle = true
      } else if character == "\"" {
        inDouble = true
      } else {
        out.append(character)
      }
    }
    return out
  }

  func test_the_list_command_runs_in_sh_and_a_hostile_folder_stays_one_quoted_word() {
    let hostile = "/tmp/it's; rm -rf ~ $(x) `y`"
    let command = ChatFileList.command(cwd: hostile)
    XCTAssertTrue(command.hasPrefix("sh -c "))
    let script = unquote(String(command.dropFirst("sh -c ".count)))
    XCTAssertTrue(script.hasPrefix("cd " + shellQuote(hostile) + " && ("))
    XCTAssertEqual(unquote(shellQuote(hostile)), hostile)
    XCTAssertTrue(script.contains("git ls-files -co --exclude-standard 2>/dev/null || find . -type f"))
    XCTAssertTrue(script.contains("-not -path '*/node_modules/*'"))
    XCTAssertTrue(script.hasSuffix("| head -3000"))
  }

  func test_parsing_keeps_plain_relative_paths_and_skips_the_rest() {
    let output = "a.txt\nsrc/b.swift\nhas space.txt\ntab\tname\n/abs/path\n../up\nx/../y\n\u{1B}[31mesc\na.txt\n\nnaïve/ünï.md\n"
    XCTAssertEqual(ChatFileList.parse(output), ["a.txt", "src/b.swift", "naïve/ünï.md"])
  }

  func test_parsing_caps_the_count() {
    let output = (0..<(ChatFileList.maxFiles + 50)).map { "f\($0)" }.joined(separator: "\n")
    XCTAssertEqual(ChatFileList.parse(output).count, ChatFileList.maxFiles)
  }

  func test_the_cache_is_fresh_for_a_minute() {
    var index = ChatFileIndex()
    let t0 = Date(timeIntervalSince1970: 1000)
    XCTAssertTrue(index.isStale(at: t0))
    index.store(["a"], at: t0)
    XCTAssertFalse(index.isStale(at: t0.addingTimeInterval(59)))
    XCTAssertTrue(index.isStale(at: t0.addingTimeInterval(61)))
    XCTAssertEqual(index.files, ["a"])
  }

  func test_a_chat_loads_the_list_once_and_again_only_after_it_goes_stale_and_keeps_it_on_failure() async {
    let calls = LockedBox(0)
    let answer = LockedBox<String?>("a.txt\nb.txt\n")
    let model = ChatSessionModel(
      chatName: "chat-m", cwd: "/srv/x", readOnly: false, store: InMemoryChatJournalStore(),
      listFiles: {
        calls.update { $0 += 1 }
        return answer.value
      }
    ) { _, _ in ScriptedByteStream() }
    await model.loadMentionFiles()
    XCTAssertEqual(model.fileIndex.files, ["a.txt", "b.txt"])
    await model.loadMentionFiles()
    XCTAssertEqual(calls.value, 1)
    answer.value = nil
    await model.loadMentionFiles(now: Date().addingTimeInterval(120))
    XCTAssertEqual(calls.value, 2)
    XCTAssertEqual(model.fileIndex.files, ["a.txt", "b.txt"])
    answer.value = "c.txt"
    await model.loadMentionFiles(now: Date().addingTimeInterval(120))
    XCTAssertEqual(model.fileIndex.files, ["c.txt"])
  }
}
