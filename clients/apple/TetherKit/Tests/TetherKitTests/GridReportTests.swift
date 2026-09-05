import XCTest
@testable import TetherKit

final class GridReportTests: XCTestCase {
  func testFirstSizeCommitsImmediately() {
    XCTAssertTrue(
      GridReport.shouldCommitImmediately(previous: nil, next: (cols: 80, rows: 24))
    )
  }

  func testAKeyboardSizedRowJumpCommitsImmediately() {
    XCTAssertTrue(
      GridReport.shouldCommitImmediately(
        previous: (cols: 80, rows: 40),
        next: (cols: 80, rows: 22)
      )
    )
    XCTAssertTrue(
      GridReport.shouldCommitImmediately(
        previous: (cols: 80, rows: 22),
        next: (cols: 80, rows: 40)
      )
    )
  }

  func testAOneRowNudgeDoesNotBypassSettle() {
    XCTAssertFalse(
      GridReport.shouldCommitImmediately(
        previous: (cols: 80, rows: 40),
        next: (cols: 80, rows: 39)
      )
    )
  }
}
