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

  /// An alert takes first responder and UIKit hands it back on dismissal. Unless that
  /// return reaches the binding, the next update resigns the view mid-keyboard-show
  /// and leaves a keyboard on screen that feeds nothing.
  func test_uikit_restoring_focus_writes_it_back_deferred() {
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

    coordinator.textViewDidBeginEditing(FirstResponderTextView())

    XCTAssertEqual(writes, 0, "UIKit delegate callbacks must not synchronously re-enter SwiftUI state updates")

    let deferredWrite = expectation(description: "focus gain is written back")
    DispatchQueue.main.async {
      XCTAssertEqual(writes, 1)
      XCTAssertTrue(focused)
      deferredWrite.fulfill()
    }
    wait(for: [deferredWrite], timeout: 1)
  }

  func test_beginning_editing_does_not_rewrite_focus_when_already_true() {
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

    coordinator.textViewDidBeginEditing(FirstResponderTextView())

    let noDeferredWrite = expectation(description: "no redundant focus write-back")
    DispatchQueue.main.async {
      XCTAssertEqual(writes, 0)
      noDeferredWrite.fulfill()
    }
    wait(for: [noDeferredWrite], timeout: 1)
  }
}

/// Reports first responder without a window, which a unit test cannot give it.
private final class FirstResponderTextView: UITextView {
  override var isFirstResponder: Bool { true }
}
