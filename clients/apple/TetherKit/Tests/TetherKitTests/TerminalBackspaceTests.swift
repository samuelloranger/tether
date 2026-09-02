#if canImport(UIKit)
import SwiftUI
import UIKit
import XCTest

@testable import TetherKit

/// What the hidden input view actually puts on the wire for a delete key.
///
/// v3.2.1 sent two DELs per press: `deleteBackward()` emitted one and then
/// `super.deleteBackward()` re-entered the delegate, which emitted another. The
/// suppression flag between them assumed that re-entry was synchronous. Nothing
/// in the unit tests could see it, because nothing counted the bytes.
final class TerminalBackspaceTests: XCTestCase {
  /// Kept for the length of each test: `UITextView.delegate` is weak, and the
  /// window is what lets the view become first responder so `deleteBackward()`
  /// takes the same path it does on a device.
  private var window: UIWindow?

  override func tearDown() {
    window = nil
    super.tearDown()
  }

  private func makeView(sink: @escaping (String) -> Void) -> (
    TerminalInputTextView, TerminalInputBridge.Coordinator
  ) {
    let view = TerminalInputTextView()
    let coordinator = TerminalInputBridge.Coordinator(
      onSubmitBytes: sink,
      isFocused: .constant(true)
    )
    view.delegate = coordinator
    // The same wiring makeUIView applies — the app and this test must not be
    // able to disagree about where the bytes go.
    TerminalInputBridge.wire(view, onSubmitBytes: sink)

    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
    window.addSubview(view)
    window.makeKeyAndVisible()
    self.window = window
    _ = view.becomeFirstResponder()

    view.refillFiller()
    return (view, coordinator)
  }

  /// One real press: the document loses a character, so one DEL goes out.
  func testOnePressSendsOneDel() {
    var sent: [String] = []
    let (view, coordinator) = makeView { sent.append($0) }
    withExtendedLifetime(coordinator) {
      view.deleteBackward()
      view.flushDeletion()
    }
    XCTAssertEqual(sent, ["\u{7F}"])
  }

  /// The shipped bug. UIKit reports one press through several callbacks, and
  /// `shouldChangeTextIn` is documented to fire twice for a single press with
  /// some keyboards. Only ONE character actually leaves the document, so only
  /// one DEL may leave the app.
  func testDuplicateCallbacksForOnePressSendOneDel() {
    var sent: [String] = []
    let (view, coordinator) = makeView { sent.append($0) }
    withExtendedLifetime(coordinator) {
      view.deleteBackward()
      // The delegate's duplicate report for the same press — no second edit.
      _ = coordinator.textView(
        view, shouldChangeTextIn: NSRange(location: 0, length: 1), replacementText: ""
      )
      view.flushDeletion()
    }
    XCTAssertEqual(sent, ["\u{7F}"], "one press must never delete two characters")
  }

  /// A callback that changes nothing puts nothing on the wire.
  func testACallbackThatDeletesNothingSendsNothing() {
    var sent: [String] = []
    let (view, coordinator) = makeView { sent.append($0) }
    withExtendedLifetime(coordinator) {
      _ = coordinator.textView(
        view, shouldChangeTextIn: NSRange(location: 0, length: 1), replacementText: ""
      )
      view.flushDeletion()
    }
    XCTAssertEqual(sent, [])
  }

  /// A word deletion is measured whole.
  func testAWordDeletionSendsOneDelPerCharacter() {
    var sent: [String] = []
    let (view, coordinator) = makeView { sent.append($0) }
    withExtendedLifetime(coordinator) {
      for _ in 0..<4 { view.deleteBackward() }
      view.flushDeletion()
    }
    XCTAssertEqual(sent, Array(repeating: "\u{7F}", count: 4))
  }

  /// Separate presses each get their own turn, so they do not merge.
  func testSeparatePressesEachSendTheirOwnDel() {
    var sent: [String] = []
    let (view, coordinator) = makeView { sent.append($0) }
    withExtendedLifetime(coordinator) {
      for _ in 0..<5 {
        view.deleteBackward()
        view.flushDeletion()
      }
    }
    XCTAssertEqual(sent.count, 5)
    XCTAssertTrue(sent.allSatisfy { $0 == "\u{7F}" })
  }

  /// The flush runs on its own without a test driving it.
  func testTheFlushHappensOnItsOwnRunloopTurn() {
    var sent: [String] = []
    let delivered = expectation(description: "DEL reaches the wire without a manual flush")
    // Fulfill on the ACTUAL delivery rather than after a guessed number of
    // runloop turns: under a loaded CI sim the main queue is starved (the
    // haptic subsystem alone floods it), and counting `DispatchQueue.main.async`
    // hops raced the 2s wait. Keying off the sink makes the test pass the
    // instant the self-scheduled flush fires and time out only on a real
    // regression — the generous ceiling is never reached on success.
    delivered.assertForOverFulfill = false
    let (view, coordinator) = makeView {
      sent.append($0)
      delivered.fulfill()
    }
    withExtendedLifetime(coordinator) {
      // No manual flushDeletion(): the flush must schedule itself.
      view.deleteBackward()
      wait(for: [delivered], timeout: 10)
    }
    XCTAssertEqual(sent, ["\u{7F}"])
  }

  /// The filler is what keeps UIKit's auto-repeat alive: a press that removes
  /// nothing stops the repeat. So the document must never run dry.
  func testTheDocumentIsRestockedAfterADeletion() {
    var sent: [String] = []
    let (view, coordinator) = makeView { sent.append($0) }
    withExtendedLifetime(coordinator) {
      for _ in 0..<20 {
        view.deleteBackward()
        view.flushDeletion()
      }
    }
    XCTAssertTrue(view.hasText)
    XCTAssertGreaterThan((view.text as NSString).length, 0)
    XCTAssertEqual(sent.count, 20)
  }

  /// The caret stays at the end — a selection change mid-repeat cancels it.
  func testRefillKeepsTheCaretAtTheEnd() {
    let (view, coordinator) = makeView { _ in }
    withExtendedLifetime(coordinator) {
      view.refillFiller()
    }
    XCTAssertEqual(view.selectedRange.location, (view.text as NSString).length)
    XCTAssertEqual(view.selectedRange.length, 0)
  }

  /// Typing is forwarded verbatim and never mutates the hidden document.
  func testTypedTextIsForwardedWithoutEditingTheDocument() {
    var sent: [String] = []
    let (view, coordinator) = makeView { sent.append($0) }
    let before = view.text
    let allowed = withExtendedLifetime(coordinator) {
      coordinator.textView(
        view,
        shouldChangeTextIn: NSRange(location: (view.text as NSString).length, length: 0),
        replacementText: "a"
      )
    }
    XCTAssertFalse(allowed)
    XCTAssertEqual(sent, ["a"])
    XCTAssertEqual(view.text, before)
  }

  /// Backspace must not be claimed as a hardware key: that made a third
  /// emitter, outside the measurement, and it doubled every press.
  func testBackspaceIsNotClaimedAsAHardwareKey() {
    XCTAssertNil(TerminalKeyMap.specialKeyBytes(keyCode: .keyboardDeleteOrBackspace, mod: 1))
    // The neighbours it sits between must still be claimed.
    XCTAssertEqual(TerminalKeyMap.specialKeyBytes(keyCode: .keyboardDeleteForward, mod: 1), "\u{1B}[3~")
    XCTAssertEqual(TerminalKeyMap.specialKeyBytes(keyCode: .keyboardEscape, mod: 1), "\u{1B}")
  }
}
#endif
