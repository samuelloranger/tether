import XCTest
@testable import TetherKit

final class AgentQuestionsTests: XCTestCase {
  private let single = AgentQuestion(
    question: "Which color?", header: "Color", multiSelect: false,
    options: [AgentQuestionOption(label: "Red", description: nil), AgentQuestionOption(label: "Blue", description: nil)]
  )
  private let multi = AgentQuestion(
    question: "Which fruits?", header: "Fruit", multiSelect: true,
    options: [
      AgentQuestionOption(label: "Apple", description: nil),
      AgentQuestionOption(label: "Pear", description: nil),
      AgentQuestionOption(label: "Fig", description: nil),
    ]
  )

  func test_nothing_is_sent_until_every_question_is_answered() {
    var draft = AgentQuestionDraft(questions: [single, multi])
    XCTAssertNil(draft.answers())
    draft.toggle("Blue", at: 0)
    XCTAssertNil(draft.answers())
    draft.toggle("Pear", at: 1)
    XCTAssertEqual(draft.answers(), ["Which color?": "Blue", "Which fruits?": "Pear"])
  }

  func test_single_choice_keeps_one_pick() {
    var draft = AgentQuestionDraft(questions: [single])
    draft.toggle("Red", at: 0)
    draft.toggle("Blue", at: 0)
    XCTAssertTrue(draft.isSelected("Blue", at: 0))
    XCTAssertFalse(draft.isSelected("Red", at: 0))
    XCTAssertEqual(draft.answers(), ["Which color?": "Blue"])
  }

  func test_multi_select_joins_in_option_order_like_claude_does() {
    var draft = AgentQuestionDraft(questions: [multi])
    draft.toggle("Fig", at: 0)
    draft.toggle("Apple", at: 0)
    XCTAssertEqual(draft.answers(), ["Which fruits?": "Apple, Fig"])
    draft.toggle("Fig", at: 0)
    XCTAssertEqual(draft.answers(), ["Which fruits?": "Apple"])
  }

  func test_other_text_answers_too() {
    var draft = AgentQuestionDraft(questions: [single, multi])
    draft.setOther("  a deep green  ", at: 0)
    draft.toggle("Pear", at: 1)
    draft.setOther("kiwi", at: 1)
    XCTAssertEqual(draft.answers(), ["Which color?": "a deep green", "Which fruits?": "Pear, kiwi"])
  }

  func test_typing_other_on_single_choice_drops_the_pick_and_picking_clears_other() {
    var draft = AgentQuestionDraft(questions: [single])
    draft.toggle("Red", at: 0)
    draft.setOther("green", at: 0)
    XCTAssertFalse(draft.isSelected("Red", at: 0))
    XCTAssertEqual(draft.answers(), ["Which color?": "green"])
    draft.toggle("Blue", at: 0)
    XCTAssertEqual(draft.other[0], "")
    XCTAssertEqual(draft.answers(), ["Which color?": "Blue"])
  }

  func test_pending_questions_decode_from_tether_notify() throws {
    let json = #"{"session":"work","state":"waiting","version":"v7","kind":"question","questions":[{"question":"Which fruits?","header":"Fruit","multiSelect":true,"options":[{"label":"Apple","description":"crisp"},{"label":"Pear"}]}]}"#
    let pending = try JSONDecoder().decode(PendingQuestions.self, from: Data(json.utf8))
    XCTAssertEqual(pending, PendingQuestions(
      session: "work", state: "waiting", version: "v7", kind: "question",
      questions: [AgentQuestion(question: "Which fruits?", header: "Fruit", multiSelect: true, options: [
        AgentQuestionOption(label: "Apple", description: "crisp"), AgentQuestionOption(label: "Pear", description: nil),
      ])]
    ))
  }
}
