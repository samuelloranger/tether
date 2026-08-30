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

    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
    window.addSubview(view)
    window.makeKeyAndVisible()
    self.window = window
    _ = view.becomeFirstResponder()

    view.refillFiller()
    return (view, coordinator)
  }

  func testOneBackspaceSendsExactlyOneDel() {
    var sent: [String] = []
    let (view, coordinator) = makeView { sent.append($0) }
    withExtendedLifetime(coordinator) {
      view.deleteBackward()
    }
    XCTAssertEqual(sent, ["\u{7F}"], "a single backspace must put exactly one DEL on the wire")
  }

  func testRepeatedBackspacesSendOneDelEach() {
    var sent: [String] = []
    let (view, coordinator) = makeView { sent.append($0) }
    withExtendedLifetime(coordinator) {
      for _ in 0..<5 { view.deleteBackward() }
    }
    XCTAssertEqual(sent.count, 5)
    XCTAssertTrue(sent.allSatisfy { $0 == "\u{7F}" })
  }

  /// The filler is what keeps UIKit's auto-repeat alive: a press that removes
  /// nothing stops the repeat. So the document must never run dry.
  func testTheDocumentIsRestockedAfterADeletion() {
    var sent: [String] = []
    let (view, coordinator) = makeView { sent.append($0) }
    withExtendedLifetime(coordinator) {
      for _ in 0..<20 { view.deleteBackward() }
      view.refillFiller()
    }
    XCTAssertTrue(view.hasText)
    XCTAssertGreaterThan((view.text as NSString).length, 0)
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

  /// A held key can escalate to a word deletion; each removed character is its
  /// own DEL.
  func testAWordDeletionSendsOneDelPerCharacter() {
    var sent: [String] = []
    let (view, coordinator) = makeView { sent.append($0) }
    let allowed = withExtendedLifetime(coordinator) {
      coordinator.textView(
        view,
        shouldChangeTextIn: NSRange(location: 0, length: 4),
        replacementText: ""
      )
    }
    XCTAssertTrue(allowed, "deletions are the one edit allowed through, so the document shrinks")
    XCTAssertEqual(sent, Array(repeating: "\u{7F}", count: 4))
  }
}
#endif
