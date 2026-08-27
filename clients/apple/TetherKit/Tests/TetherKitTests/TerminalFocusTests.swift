#if canImport(UIKit)
import SwiftUI
import UIKit
import XCTest
@testable import TetherKit

@MainActor
final class TerminalFocusTests: XCTestCase {
  func test_ending_editing_defers_focus_write_back() {
    var focused = true
    var writes = 0
    let coordinator = TerminalInputBridge.Coordinator(
      onSubmitBytes: { _ in },
      isFocused: Binding(
        get: { focused },
        set: {
          writes += 1
          focused = $0
        }
      )
    )

    coordinator.textViewDidEndEditing(UITextView())

    XCTAssertEqual(writes, 0, "UIKit delegate callbacks must not synchronously re-enter SwiftUI state updates")

    let deferredWrite = expectation(description: "focus write-back is deferred")
    DispatchQueue.main.async {
      XCTAssertEqual(writes, 1)
      XCTAssertFalse(focused)
      deferredWrite.fulfill()
    }
    wait(for: [deferredWrite], timeout: 1)
  }

  func test_ending_editing_does_not_rewrite_focus_when_already_false() {
    var focused = false
    var writes = 0
    let coordinator = TerminalInputBridge.Coordinator(
      onSubmitBytes: { _ in },
      isFocused: Binding(
        get: { focused },
        set: {
          writes += 1
          focused = $0
        }
      )
    )

    coordinator.textViewDidEndEditing(UITextView())

    XCTAssertEqual(writes, 0, "resigning from an existing false state must not feed the same value back")

    let noDeferredWrite = expectation(description: "no redundant focus write-back")
    DispatchQueue.main.async {
      XCTAssertEqual(writes, 0)
      noDeferredWrite.fulfill()
    }
    wait(for: [noDeferredWrite], timeout: 1)
  }
}
#endif
