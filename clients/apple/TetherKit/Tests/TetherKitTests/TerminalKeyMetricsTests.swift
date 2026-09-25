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

  func testSwitchingToCompactShortensTheKeyboardAccessory() async {
    let model = TerminalAccessoryModel()
    let view = TerminalInputTextView()
    view.accessoryHosting.rootView = AnyView(TerminalAccessoryBar(
      model: model, onKey: { _ in }, onPaste: { _ in }, onArrow: { _ in }, onHideKeyboard: {}
    ))
    let regular = view.inputAccessoryView?.frame.height ?? 0
    model.compact = true
    view.compactAccessory = true
    for _ in 0..<50 where (view.inputAccessoryView?.frame.height ?? 0) >= regular {
      try? await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertLessThan(view.inputAccessoryView?.frame.height ?? .infinity, regular)
  }
}
