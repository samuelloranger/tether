import XCTest
@testable import TetherKit

final class KeyBarLayoutTests: XCTestCase {
  func testDefaultIsTheBarAsItShipped() {
    XCTAssertEqual(
      KeyBarLayout.default.items.map(\.id),
      ["ctrl", "tab", "esc", "slash", "dpad", "paste", "hide", "del", "home", "end", "pgUp", "pgDn"]
        .map { "key.\($0)" }
    )
  }

  func testRoundTripKeepsOrderAndMacros() {
    let macro = MacroKey(label: "gs", text: "git status\\n")
    let layout = KeyBarLayout(items: [.builtIn(.esc), .macro(macro), .builtIn(.ctrl)])
    XCTAssertEqual(KeyBarLayout.decode(layout.encoded()), layout)
  }

  func testUnknownAndRepeatedKeysAreDropped() {
    let json = #"[{"key":"esc"},{"key":"hyper"},{"key":"esc"},{},{"key":"tab"}]"#
    XCTAssertEqual(KeyBarLayout.decode(Data(json.utf8))?.items, [.builtIn(.esc), .builtIn(.tab)])
  }

  func testAMalformedEntryDropsOnlyThatEntry() {
    let json = #"[{"key":"esc"},{"macro":{"label":5}},{"key":7},{"key":"tab"}]"#
    XCTAssertEqual(KeyBarLayout.decode(Data(json.utf8))?.items, [.builtIn(.esc), .builtIn(.tab)])
  }

  func testDataThatIsNotABarDecodesToNil() {
    XCTAssertNil(KeyBarLayout.decode(Data("not json".utf8)))
    XCTAssertNil(KeyBarLayout.decode(Data(#"{"key":"esc"}"#.utf8)))
  }

  func testEmptyBarStaysEmpty() {
    XCTAssertEqual(KeyBarLayout.decode(KeyBarLayout(items: []).encoded())?.items, [])
  }

  func testAvailableKeysAreTheOnesNotInTheBar() {
    var layout = KeyBarLayout(items: [.builtIn(.ctrl)])
    XCTAssertFalse(layout.availableKeys.contains(.ctrl))
    XCTAssertTrue(layout.availableKeys.contains(.alt))
    layout.add(.alt)
    layout.add(.alt)
    XCTAssertEqual(layout.items, [.builtIn(.ctrl), .builtIn(.alt)], "adding twice keeps one")
    XCTAssertFalse(layout.availableKeys.contains(.alt))
  }

  func testSavingAMacroReplacesItInPlace() {
    var macro = MacroKey(label: "gs", text: "git status\\n")
    var layout = KeyBarLayout(items: [.macro(macro), .builtIn(.esc)])
    macro.text = "git status -sb\\n"
    layout.save(macro)
    XCTAssertEqual(layout.items, [.macro(macro), .builtIn(.esc)])
    let other = MacroKey(label: "ll", text: "ls -la\\n")
    layout.save(other)
    XCTAssertEqual(layout.items.last, .macro(other))
  }

  func testEveryPlainKeySendsBytes() {
    let special: Set<BuiltInKey> = [.ctrl, .alt, .slash, .dpad, .paste, .hide, .fn]
    for key in BuiltInKey.allCases where !special.contains(key) {
      XCTAssertNotNil(key.bytes, "\(key) has nothing to send")
    }
  }

  func testFunctionKeysMatchXterm() {
    XCTAssertEqual(BuiltInKey.functionKeys.count, 12)
    XCTAssertEqual(BuiltInKey.functionKeys.first?.bytes, "\u{1B}OP")
    XCTAssertEqual(BuiltInKey.functionKeys.last?.bytes, "\u{1B}[24~")
  }
}

final class MacroTextTests: XCTestCase {
  func testPlainTextIsSentAsTyped() {
    XCTAssertEqual(MacroText.bytes(from: "git status"), "git status")
  }

  func testEscapes() {
    XCTAssertEqual(MacroText.bytes(from: "ls\\n"), "ls\r")
    XCTAssertEqual(MacroText.bytes(from: "ls\\r"), "ls\r")
    XCTAssertEqual(MacroText.bytes(from: "a\\tb"), "a\tb")
    XCTAssertEqual(MacroText.bytes(from: "\\e:wq\\n"), "\u{1B}:wq\r")
    XCTAssertEqual(MacroText.bytes(from: "\\cc"), "\u{03}")
    XCTAssertEqual(MacroText.bytes(from: "\\cC"), "\u{03}")
    XCTAssertEqual(MacroText.bytes(from: "\\c?"), "\u{7F}")
    XCTAssertEqual(MacroText.bytes(from: "\\x1b[A"), "\u{1B}[A")
    XCTAssertEqual(MacroText.bytes(from: "C:\\\\dir"), "C:\\dir")
  }

  func testUnknownOrIncompleteEscapesStayAsTyped() {
    XCTAssertEqual(MacroText.bytes(from: "\\q"), "\\q")
    XCTAssertEqual(MacroText.bytes(from: "end\\"), "end\\")
    XCTAssertEqual(MacroText.bytes(from: "\\x4"), "\\x4")
    XCTAssertEqual(MacroText.bytes(from: "\\xff"), "\\xff", "only ASCII bytes")
    XCTAssertEqual(MacroText.bytes(from: "\\c"), "\\c")
  }

  func testVisibleShowsControlCharacters() {
    XCTAssertEqual(MacroText.visible("git status\r"), "git status⏎")
    XCTAssertEqual(MacroText.visible("\u{1B}:wq\t\u{03}\u{7F}"), "⎋:wq⇥^C^?")
  }
}

final class TerminalKeyModifierTests: XCTestCase {
  func testNothingArmedSendsTheKey() {
    XCTAssertEqual(TerminalKeyMap.modified("|", ctrl: false, alt: false), "|")
  }

  func testCSISequencesTakeTheModifierParameter() {
    XCTAssertEqual(TerminalKeyMap.modified("\u{1B}[H", ctrl: true, alt: false), "\u{1B}[1;5H")
    XCTAssertEqual(TerminalKeyMap.modified("\u{1B}[F", ctrl: false, alt: true), "\u{1B}[1;3F")
    XCTAssertEqual(TerminalKeyMap.modified("\u{1B}[H", ctrl: true, alt: true), "\u{1B}[1;7H")
  }

  func testPrintableKeysFoldAndPrefix() {
    XCTAssertEqual(TerminalKeyMap.modified("b", ctrl: false, alt: true), "\u{1B}b")
    XCTAssertEqual(TerminalKeyMap.modified("c", ctrl: true, alt: false), "\u{03}")
    XCTAssertEqual(TerminalKeyMap.modified("c", ctrl: true, alt: true), "\u{1B}\u{03}")
  }

  func testFunctionKeysTakeTheModifierLikeXterm() {
    XCTAssertEqual(TerminalKeyMap.modified("\u{1B}OP", ctrl: false, alt: true), "\u{1B}[1;3P")
    XCTAssertEqual(TerminalKeyMap.modified("\u{1B}[15~", ctrl: true, alt: false), "\u{1B}[15;5~")
    XCTAssertEqual(TerminalKeyMap.modified("\u{1B}[24~", ctrl: true, alt: true), "\u{1B}[24;7~")
  }

  func testArrowsTakeTheModifier() {
    XCTAssertEqual(TerminalKeyMap.modified(DPadDirection.D.escapeSequence, ctrl: true, alt: false), "\u{1B}[1;5D")
    XCTAssertEqual(TerminalKeyMap.modified(DPadDirection.C.escapeSequence, ctrl: false, alt: true), "\u{1B}[1;3C")
  }

  func testTabIgnoresCtrlButTakesAlt() {
    XCTAssertEqual(TerminalKeyMap.modified("\t", ctrl: true, alt: false), "\t")
    XCTAssertEqual(TerminalKeyMap.modified("\t", ctrl: false, alt: true), "\u{1B}\t")
  }
}
