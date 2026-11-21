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

  private func tool(_ id: Int, _ call: ChatToolCall) -> ChatItem { .init(id: id, kind: .tool(call)) }

  private func edit(_ path: String, old: String?, new: String) -> ACPDiff { ACPDiff(path: path, oldText: old, newText: new) }

  func test_an_idle_chat_has_every_turn_finished_and_a_working_one_all_but_the_last() {
    let items = [user(0), text(1), user(2), text(3)]
    XCTAssertEqual(ChatTurns.finishedThrough(items, working: false), 3)
    XCTAssertEqual(ChatTurns.finishedThrough(items, working: true), 1)
    XCTAssertEqual(ChatTurns.finishedThrough([user(0), text(1)], working: true), -1)
  }

  func test_a_receipt_sums_the_edits_of_one_file_and_lists_commands_in_order() {
    let items = [
      user(0),
      tool(1, call("a", .edit, diff: edit("/w/p/src/a.ts", old: "x\n", new: "y\nz\n"))),
      tool(2, call("b", .execute, title: "bun test")),
      tool(3, call("c", .edit, diff: edit("/w/p/src/a.ts", old: "z\n", new: "q\n"))),
      tool(4, call("d", .execute, title: "bun run lint", status: .failed)),
      text(5),
    ]
    let receipts = ChatTurns.receipts(items, working: false, cwd: "/w/p")
    XCTAssertEqual(Array(receipts.keys), [5])
    let receipt = receipts[5]
    XCTAssertEqual(receipt?.changed, [.init(path: "src/a.ts", added: 3, removed: 2)])
    XCTAssertEqual(receipt?.ran, [.init(title: "bun test", failed: false), .init(title: "bun run lint", failed: true)])
  }

  func test_a_failed_edit_changed_nothing_and_a_turn_that_only_read_has_no_receipt() {
    let items = [
      user(0), tool(1, call("a", .edit, status: .failed, diff: edit("/w/a", old: "x", new: "y"))),
      tool(2, call("b", .read)), text(3),
    ]
    XCTAssertTrue(ChatTurns.receipts(items, working: false, cwd: "/w").isEmpty)
  }

  func test_the_running_turn_gets_no_receipt_until_it_ends() {
    let items = [
      user(0), tool(1, call("a", .execute, title: "make")), text(2),
      user(3), tool(4, call("b", .execute, title: "make check")),
    ]
    let receipts = ChatTurns.receipts(items, working: true, cwd: "/w")
    XCTAssertEqual(Array(receipts.keys), [2])
    XCTAssertEqual(receipts[2]?.ran.map(\.title), ["make"])
  }

  func test_a_command_still_being_written_is_not_listed() {
    var writing = ACPToolFields(id: "w")
    writing.kind = .execute
    writing.title = "Terminal"
    writing.status = .pending
    let receipt = ChatTurns.receipt([ChatToolCall(writing)], cwd: "/w")
    XCTAssertTrue(receipt.ran.isEmpty)
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
