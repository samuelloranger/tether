import SwiftUI
import XCTest
@testable import TetherKit

@MainActor
final class TerminalKeyMetricsTests: XCTestCase {
  func testCompactKeysAreSmallerAndTheBarFollows() {
    let regular = TerminalKeyMetrics.regular
    let compact = TerminalKeyMetrics.compact
    XCTAssertLessThan(compact.keySize, regular.keySize)
    XCTAssertLessThan(compact.keyWidth, regular.keyWidth)
    XCTAssertEqual(regular.barHeight, 56, "unchanged from the fixed-size bar")
    XCTAssertEqual(compact.barHeight, compact.keySize + compact.barVerticalPadding * 2)
  }
}
