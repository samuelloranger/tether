import XCTest
@testable import TetherKit

final class ChatQuestionDraftTests: XCTestCase {
  private let colours = ChatQuestionField(
    name: "question_0", title: "Colour", description: "",
    kind: .single([
      .init(value: "red", title: "red", description: "Red"), .init(value: "blue", title: "blue", description: "Blue"),
    ]), required: false,
    custom: ChatQuestionCompanion(name: "question_0_custom", title: "Other", hint: ""))
  private let checks = ChatQuestionField(
    name: "question_1", title: "Checks", description: "",
    kind: .multi([
      .init(value: "lint", title: "Lint", description: ""), .init(value: "types", title: "Types", description: ""),
      .init(value: "unit", title: "Unit", description: ""),
    ]), required: true, custom: nil)
  private let note = ChatQuestionField(
    name: "note", title: "Note", description: "", kind: .text, required: true, custom: nil)
  private let flag = ChatQuestionField(
    name: "go", title: "Go", description: "", kind: .boolean, required: false, custom: nil)

  func test_single_select_replaces_and_multi_toggles_in_choice_order() {
    var draft = ChatQuestionDraft()
    draft.choose(colours, "red")
    draft.choose(colours, "blue")
    XCTAssertEqual(draft.content([colours]), ["question_0": .text("blue")])
    draft.choose(checks, "unit")
    draft.choose(checks, "lint")
    draft.choose(checks, "types")
    draft.choose(checks, "types")
    XCTAssertEqual(draft.content([checks]), ["question_1": .list(["lint", "unit"])])
  }

  func test_a_tap_submits_only_for_a_lone_single_select_without_typed_text() {
    var draft = ChatQuestionDraft()
    XCTAssertTrue(draft.submitsOnTap([colours]))
    XCTAssertFalse(draft.submitsOnTap([colours, checks]))
    XCTAssertFalse(draft.submitsOnTap([checks]))
    draft.openCustom("question_0_custom")
    XCTAssertTrue(draft.submitsOnTap([colours]), "an open but empty Other still submits on tap")
    draft.setText("question_0_custom", "  ")
    XCTAssertTrue(draft.submitsOnTap([colours]))
    draft.setText("question_0_custom", "teal")
    XCTAssertFalse(draft.submitsOnTap([colours]))
  }

  func test_custom_text_is_trimmed_and_sent_under_the_companions_name() {
    var draft = ChatQuestionDraft()
    draft.choose(colours, "red")
    draft.setText("question_0_custom", "  but darker \n")
    XCTAssertEqual(
      draft.content([colours]), ["question_0": .text("red"), "question_0_custom": .text("but darker")])
    var onlyCustom = ChatQuestionDraft()
    onlyCustom.setText("question_0_custom", "teal")
    XCTAssertEqual(onlyCustom.content([colours]), ["question_0_custom": .text("teal")])
    XCTAssertTrue(onlyCustom.canSubmit([colours]))
  }

  func test_submit_needs_the_required_fields_and_something_answered() {
    var draft = ChatQuestionDraft()
    XCTAssertFalse(draft.canSubmit([colours]), "nothing answered")
    XCTAssertFalse(draft.canSubmit([colours, checks]))
    draft.choose(colours, "red")
    XCTAssertFalse(draft.canSubmit([colours, checks]), "the multi-select is required")
    draft.choose(checks, "lint")
    XCTAssertTrue(draft.canSubmit([colours, checks]))
    draft.choose(checks, "lint")
    XCTAssertFalse(draft.canSubmit([colours, checks]))
    XCTAssertFalse(draft.canSubmit([note]))
    draft.setText("note", "  ")
    XCTAssertFalse(draft.canSubmit([note]))
    draft.setText("note", "hi")
    XCTAssertTrue(draft.canSubmit([note]))
    XCTAssertTrue(ChatQuestionDraft().canSubmit([]), "a message-only form can be accepted")
    XCTAssertTrue(ChatQuestionDraft().canSubmit([flag]), "a boolean always has an answer")
    XCTAssertEqual(ChatQuestionDraft().content([flag]), ["go": .flag(false)])
  }
}
