import XCTest
@testable import TetherKit

final class MacChromeTests: XCTestCase {
  func testFontSizeStepsByOneAndClampsAtBothEnds() {
    XCTAssertEqual(TerminalFontSizeStep.bigger(13), 14)
    XCTAssertEqual(TerminalFontSizeStep.smaller(13), 12)
    XCTAssertEqual(TerminalFontSizeStep.bigger(24), 24)
    XCTAssertEqual(TerminalFontSizeStep.smaller(8), 8)
    XCTAssertEqual(TerminalFontSizeStep.clamped(99), 24)
    XCTAssertEqual(TerminalFontSizeStep.clamped(1), 8)
  }

  func testDefaultSizeIsInsideTheRange() {
    XCTAssertTrue(TerminalFontSizeStep.range.contains(AppPreferences.defaultTerminalFontSize))
  }

  func testSessionItemsFollowTheTabCount() {
    var actions = TerminalMenuActions()
    actions.sessionCount = 3
    XCTAssertFalse(actions.canSelectSession(at: 0), "no handler yet")
    actions.selectSession = { _ in }
    XCTAssertTrue(actions.canSelectSession(at: 0))
    XCTAssertTrue(actions.canSelectSession(at: 2))
    XCTAssertFalse(actions.canSelectSession(at: 3))
    XCTAssertFalse(actions.canSelectSession(at: -1))
  }

  func testMenuAvailabilityOnHomeAndInTheTerminal() {
    var home = HomeMenuActions()
    home.addMachine = {}
    home.openSettings = {}
    let onHome = MenuAvailability(terminal: nil, home: home)
    XCTAssertTrue(onHome.addMachine)
    XCTAssertTrue(onHome.settings)
    XCTAssertFalse(onHome.newSession)
    XCTAssertFalse(onHome.backToMachines)

    var terminal = TerminalMenuActions()
    terminal.newSession = {}
    terminal.backToMachines = {}
    let inTerminal = MenuAvailability(terminal: terminal, home: nil)
    XCTAssertTrue(inTerminal.newSession)
    XCTAssertTrue(inTerminal.backToMachines)
    XCTAssertFalse(inTerminal.addMachine)
    XCTAssertFalse(inTerminal.settings, "the terminal offered no settings handler")
  }

  func testNothingIsEnabledWithoutAFocusedScreen() {
    XCTAssertEqual(
      MenuAvailability(terminal: nil, home: nil),
      MenuAvailability(terminal: TerminalMenuActions(), home: HomeMenuActions())
    )
  }

  func testMacBellChoicesDropHapticUnlessAlreadyChosen() {
    XCTAssertEqual(BellMode.choices(isMac: true, including: .off), [.off, .flash])
    XCTAssertEqual(BellMode.choices(isMac: true, including: .haptic), [.off, .haptic, .flash])
    XCTAssertEqual(BellMode.choices(isMac: false, including: .off), BellMode.allCases)
  }
}
