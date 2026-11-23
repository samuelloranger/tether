import XCTest

@testable import TetherKit

final class ChatTurnsTests: XCTestCase {
  private func user(_ id: Int) -> ChatItem { .init(id: id, kind: .user(text: "go", offset: id)) }
  private func text(_ id: Int) -> ChatItem { .init(id: id, kind: .assistant(text: "ok", messageId: nil)) }

  private func call(
    _ id: String, _ kind: ACPToolKind, title: String = "step", status: ACPToolStatus = .completed, diff: ACPDiff? = nil
  ) -> ChatToolCall {
    var fields = ACPToolFields(id: id)
    fields.kind = kind
    fields.title = title
    fields.status = status
    fields.diff = diff
    return ChatToolCall(fields)
  }

  func test_an_idle_chat_has_every_turn_finished_and_a_working_one_all_but_the_last() {
    let items = [user(0), text(1), user(2), text(3)]
    XCTAssertEqual(ChatTurns.finishedThrough(items, working: false), 3)
    XCTAssertEqual(ChatTurns.finishedThrough(items, working: true), 1)
    XCTAssertEqual(ChatTurns.finishedThrough([user(0), text(1)], working: true), -1)
  }

  func test_the_fold_summary_counts_by_kind_in_reading_order() {
    let calls = [
      call("1", .read), call("2", .read), call("3", .search), call("4", .edit), call("5", .execute),
      call("6", .think),
    ]
    XCTAssertEqual(ChatTurns.foldSummary(calls), "Read 2 files, searched once, edited 1 file, ran 1 command, 1 other step")
    XCTAssertEqual(ChatTurns.foldSummary([call("1", .search), call("2", .search)]), "Searched twice")
  }
}
