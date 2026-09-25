import XCTest
@testable import TetherKit

final class TerminalCursorStyleTests: XCTestCase {
  private func engine(after output: String) -> TerminalEngine {
    let engine = TerminalEngine(cols: 20, rows: 4)
    engine.feed(Data(output.utf8))
    return engine
  }

  func testEachDECSCUSRShapeReachesTheHeader() {
    let expected: [(Int, TerminalCursorStyle)] = [
      (2, .init(shape: .block, blink: false)),
      (3, .init(shape: .underline, blink: true)),
      (4, .init(shape: .underline, blink: false)),
      (5, .init(shape: .bar, blink: true)),
      (6, .init(shape: .bar, blink: false)),
    ]
    for (parameter, style) in expected {
      XCTAssertEqual(engine(after: "\u{1B}[\(parameter) q").frame().header.programCursor, style, "DECSCUSR \(parameter)")
    }
  }

  func testNoRequestLeavesTheUsersSetting() {
    XCTAssertNil(engine(after: "hello").frame().header.programCursor)
  }

  func testResetReturnsToTheUsersSetting() {
    let engine = engine(after: "\u{1B}[6 q")
    XCTAssertNotNil(engine.frame().header.programCursor)
    engine.feed(Data("\u{1B}[0 q".utf8))
    XCTAssertNil(engine.frame().header.programCursor)
  }

  func testAProgramsCursorSurvivesARebuild() {
    let old = engine(after: "\u{1B}[4 q")
    let rebuilt = TerminalEngine(cols: 30, rows: 4)
    rebuilt.restoreProgramCursor(old.programCursor)
    XCTAssertEqual(rebuilt.frame().header.programCursor, .init(shape: .underline, blink: false))
  }

  func testRestoringNothingKeepsTheUsersSetting() {
    let rebuilt = TerminalEngine(cols: 30, rows: 4)
    rebuilt.restoreProgramCursor(nil)
    XCTAssertNil(rebuilt.frame().header.programCursor)
  }

  func testDECSCUSRParameterRoundTrips() {
    for shape in TerminalCursorStyle.Shape.allCases {
      for blink in [false, true] {
        let style = TerminalCursorStyle(shape: shape, blink: blink)
        let parsed = engine(after: "\u{1B}[\(style.decscusrParameter) q").frame().header.programCursor
        // Blinking block is SwiftTerm's startup style, read as "no request".
        XCTAssertEqual(parsed, shape == .block && blink ? nil : style)
      }
    }
  }

  func testShapeGeometryInsideTheCell() {
    let cell = CGRect(x: 10, y: 20, width: 8, height: 16)
    XCTAssertEqual(TerminalCursorStyle(shape: .block, blink: false).frame(inCell: cell), cell)
    XCTAssertEqual(
      TerminalCursorStyle(shape: .bar, blink: false).frame(inCell: cell),
      CGRect(x: 10, y: 20, width: 2, height: 16)
    )
    XCTAssertEqual(
      TerminalCursorStyle(shape: .underline, blink: false).frame(inCell: cell),
      CGRect(x: 10, y: 34, width: 8, height: 2)
    )
  }
}

final class CursorBlinkAnimationTests: XCTestCase {
  func testBlinkIsAValidDiscreteAnimation() {
    let blink = TetherSurfaceView.blinkAnimation()
    XCTAssertEqual(blink.calculationMode, .discrete)
    XCTAssertEqual(blink.keyTimes?.count, (blink.values?.count ?? 0) + 1)
    XCTAssertEqual(blink.keyTimes?.last, 1)
    XCTAssertEqual(blink.repeatCount, .infinity)
  }
}
