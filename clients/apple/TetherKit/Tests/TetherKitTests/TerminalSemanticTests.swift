import XCTest
@testable import TetherKit

/// OSC 8 hyperlinks and OSC 133 prompt marks, as a shell and programs emit them.
final class TerminalSemanticTests: XCTestCase {
  private let st = "\u{1B}\\"

  private func link(_ uri: String, params: String = "", _ text: String) -> String {
    "\u{1B}]8;\(params);\(uri)\(st)\(text)\u{1B}]8;;\(st)"
  }

  // MARK: - OSC 8

  func test_an_osc8_link_becomes_an_underlined_span() {
    let engine = TerminalEngine(cols: 20, rows: 3)
    engine.feed(link("https://example.com/x", "docs") + " plain")
    let frame = engine.frame()
    XCTAssertEqual(frame.hyperlinks.first, [LinkSpan(start: 0, end: 4, target: .external(url: "https://example.com/x"))])
    XCTAssertEqual(frame.cells[0].attrs & GridSnapshot.attrUnderline, GridSnapshot.attrUnderline)
    XCTAssertEqual(frame.cells[5].attrs & GridSnapshot.attrUnderline, 0)
  }

  func test_a_uri_keeps_its_semicolons_and_params_are_ignored() {
    let engine = TerminalEngine(cols: 20, rows: 3)
    engine.feed(link("https://a.test/p;q=1", params: "id=7", "go"))
    XCTAssertEqual(engine.frame().hyperlinks.first?.first?.target, .external(url: "https://a.test/p;q=1"))
  }

  func test_a_file_uri_opens_as_a_path_and_other_schemes_are_dropped() {
    let engine = TerminalEngine(cols: 30, rows: 3)
    engine.feed(link("file://devbox/home/me/a.swift", "a.swift") + " " + link("ssh://evil", "x"))
    XCTAssertEqual(engine.frame().hyperlinks.first, [LinkSpan(start: 0, end: 7, target: .file(path: "/home/me/a.swift", line: nil, column: nil))])
  }

  func test_a_wide_glyph_link_covers_both_cells() {
    let engine = TerminalEngine(cols: 20, rows: 3)
    engine.feed(link("https://example.com", "你好"))
    XCTAssertEqual(engine.frame().hyperlinks.first, [LinkSpan(start: 0, end: 4, target: .external(url: "https://example.com"))])
  }

  func test_two_adjacent_links_stay_separate() {
    let engine = TerminalEngine(cols: 20, rows: 3)
    engine.feed(link("https://a.test", "ab") + link("https://b.test", "cd"))
    XCTAssertEqual(engine.frame().hyperlinks.first?.map(\.end), [2, 4])
  }

  func test_a_screen_without_links_carries_none() {
    let engine = TerminalEngine(cols: 20, rows: 3)
    engine.feed("https://example.com")
    XCTAssertEqual(engine.frame().hyperlinks, [])
  }

  func test_an_explicit_link_wins_over_a_detected_one_on_the_same_cells() {
    let explicit = [[LinkSpan(start: 0, end: 4, target: .external(url: "https://real.test"))]]
    let detected = [[LinkSpan(start: 0, end: 10, target: .external(url: "https://shown.test"))]]
    let merged = LinkSpans.merging(explicit: explicit, detected: detected)
    XCTAssertEqual(LinkSpans.target(atColumn: 1, row: 0, spans: merged), .external(url: "https://real.test"))
    XCTAssertEqual(LinkSpans.target(atColumn: 6, row: 0, spans: merged), .external(url: "https://shown.test"))
  }

  // MARK: - OSC 133

  /// A shell session: each command's prompt (A), input (B), output (C) and exit (D),
  /// then a fresh prompt waiting for input.
  private func shell(_ engine: TerminalEngine, commands: [(String, [String])]) {
    var bytes = ""
    for (command, output) in commands {
      bytes += "\u{1B}]133;A\(st)$ \u{1B}]133;B\(st)\(command)\r\n\u{1B}]133;C\(st)"
      bytes += output.map { $0 + "\r\n" }.joined()
      bytes += "\u{1B}]133;D;0\(st)"
    }
    bytes += "\u{1B}]133;A\(st)$ \u{1B}]133;B\(st)"
    engine.feed(bytes)
  }

  private func lines(_ prefix: String, _ count: Int) -> [String] {
    (1...count).map { "\(prefix) line \($0)" }
  }

  func test_previous_and_next_prompt_walk_the_command_history() {
    let engine = TerminalEngine(cols: 30, rows: 5)
    shell(engine, commands: [("one", lines("a", 6)), ("two", lines("b", 6)), ("three", lines("c", 6))])

    XCTAssertTrue(engine.jumpToPrompt(.previous))
    XCTAssertEqual(rowText(engine.frame(), 0), "$ three")
    XCTAssertTrue(engine.jumpToPrompt(.previous))
    XCTAssertEqual(rowText(engine.frame(), 0), "$ two")
    XCTAssertTrue(engine.jumpToPrompt(.previous))
    XCTAssertEqual(rowText(engine.frame(), 0), "$ one")
    XCTAssertFalse(engine.jumpToPrompt(.previous))

    XCTAssertTrue(engine.jumpToPrompt(.next))
    XCTAssertEqual(rowText(engine.frame(), 0), "$ two")
    XCTAssertTrue(engine.jumpToPrompt(.next))
    XCTAssertTrue(engine.jumpToPrompt(.next))
    // Back at the live prompt: the cursor row is visible again.
    XCTAssertTrue(engine.frame().header.cursorVisible)
    XCTAssertFalse(engine.jumpToPrompt(.next))
  }

  func test_last_output_is_the_newest_finished_command_as_printed() {
    let engine = TerminalEngine(cols: 30, rows: 5)
    shell(engine, commands: [("one", lines("a", 2)), ("two", ["first", "  indented  ", "", "last"])])
    // Printed trailing spaces and blank lines survive; the row padding after them doesn't.
    XCTAssertEqual(engine.lastCommandOutput(), "first\n  indented  \n\nlast")
  }

  func test_blank_lines_at_either_end_of_the_output_are_kept() {
    let engine = TerminalEngine(cols: 30, rows: 8)
    shell(engine, commands: [("one", ["x"]), ("two", ["", "text", ""])])
    XCTAssertEqual(engine.lastCommandOutput(), "\ntext\n")
  }

  func test_a_secondary_prompt_opener_counts_as_a_prompt() {
    let engine = TerminalEngine(cols: 30, rows: 5)
    shell(engine, commands: [("one", lines("a", 6))])
    // A continuation prompt that opens its own group (k=s) with no primary mark.
    engine.feed("\u{1B}]133;A;k=s\(st)> \u{1B}]133;B\(st)")
    XCTAssertTrue(engine.jumpToPrompt(.previous))
    XCTAssertEqual(rowText(engine.frame(), 0), "$ one")
  }

  func test_output_is_bounded_by_the_commands_c_and_d_marks() {
    let engine = TerminalEngine(cols: 30, rows: 8)
    // C before the newline echo, output on the command's own row, and a prompt that
    // starts with a newline of its own after D.
    engine.feed("\u{1B}]133;A\(st)$ \u{1B}]133;B\(st)ls\u{1B}]133;C\(st)\r\na\r\n\r\nb\r\n\u{1B}]133;D;0\(st)")
    engine.feed("\r\n\u{1B}]133;A\(st)$ \u{1B}]133;B\(st)")
    XCTAssertEqual(engine.lastCommandOutput(), "a\n\nb")
  }

  func test_marks_from_before_a_reset_are_dropped() {
    let engine = TerminalEngine(cols: 30, rows: 8)
    // The old command's D lands on row 2, inside the next command's output once RIS
    // restarts the buffer at row 0.
    shell(engine, commands: [("one", ["a"])])
    engine.feed("\u{1B}c")
    shell(engine, commands: [("two", ["x", "y", "z"])])
    XCTAssertEqual(engine.lastCommandOutput(), "x\ny\nz")
  }

  func test_marks_from_before_a_clear_are_not_taken_for_the_next_command() {
    for clear in ["\u{1B}[H\u{1B}[2J", "\u{1B}[3J\u{1B}[H\u{1B}[2J"] {
      let engine = TerminalEngine(cols: 30, rows: 8)
      // `one` ends with D on row 2; after `clear` the next command's output covers rows 1–3.
      engine.feed("\u{1B}]133;A\(st)$ \u{1B}]133;B\(st)one\r\n\u{1B}]133;C\(st)a\r\n\u{1B}]133;D;0\(st)")
      engine.feed("\u{1B}]133;A\(st)$ \u{1B}]133;B\(st)clear\r\n\u{1B}]133;C\(st)\(clear)\u{1B}]133;D;0\(st)")
      shell(engine, commands: [("two", ["x", "y", "z"])])
      XCTAssertEqual(engine.lastCommandOutput(), "x\ny\nz", clear.debugDescription)
    }
  }

  func test_output_that_starts_on_the_command_row_is_kept() {
    let engine = TerminalEngine(cols: 30, rows: 8)
    engine.feed("\u{1B}]133;A\(st)$ \u{1B}]133;B\(st)echo -n hi\u{1B}]133;C\(st)hi\u{1B}]133;D;0\(st)\r\n")
    engine.feed("\u{1B}]133;A\(st)$ \u{1B}]133;B\(st)")
    XCTAssertEqual(engine.lastCommandOutput(), "hi")
  }

  func test_the_scanner_skips_control_strings_and_survives_split_reads() {
    var scanner = OSCScanner()
    // An APC (kitty graphics) payload holding "ESC ] 4;…" is not a command.
    XCTAssertEqual(scanner.scan(Array("\u{1B}_Gq=2;\u{1B}]4;1;red\u{07}\u{1B}\\".utf8)), [])
    XCTAssertEqual(scanner.scan(Array("\u{1B}]13".utf8)), [])
    XCTAssertEqual(scanner.scan(Array("3;D;0\u{1B}\\x".utf8)), [.osc(code: "133", body: Array("D;0".utf8), end: 7)])
    XCTAssertEqual(scanner.scan(Array("ab\u{1B}c".utf8)), [.reset(end: 4)])
  }

  func test_a_soft_wrapped_output_line_is_copied_as_one_line() {
    let engine = TerminalEngine(cols: 10, rows: 5)
    let long = String(repeating: "x", count: 25)
    shell(engine, commands: [("cat", [long, "end"])])
    XCTAssertEqual(engine.lastCommandOutput(), long + "\nend")
  }

  func test_a_command_with_no_output_copies_nothing() {
    let engine = TerminalEngine(cols: 30, rows: 5)
    shell(engine, commands: [("true", [])])
    XCTAssertNil(engine.lastCommandOutput())
  }

  func test_a_shell_without_marks_offers_no_navigation() {
    let engine = TerminalEngine(cols: 30, rows: 5)
    engine.feed((1...20).map { "$ cmd \($0)\r\n" }.joined())
    XCTAssertFalse(engine.jumpToPrompt(.previous))
    XCTAssertFalse(engine.jumpToPrompt(.next))
    XCTAssertNil(engine.lastCommandOutput())
  }
}
