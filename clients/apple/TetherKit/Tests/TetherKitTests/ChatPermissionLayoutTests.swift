import XCTest
@testable import TetherKit

final class ChatPermissionLayoutTests: XCTestCase {
  private func option(_ id: String, _ kind: String) -> ACPPermissionOption {
    ACPPermissionOption(optionId: id, name: id, kind: kind)
  }

  func test_the_plan_approval_shows_the_first_allow_and_the_reject_and_hides_the_rest() {
    let options = [
      option("default", "allow_once"), option("acceptEdits", "allow_always"), option("auto", "allow_always"),
      option("bypass", "allow_always"), option("plan", "reject_once"),
    ]
    let layout = ChatPermissionOptions.layout(options)
    XCTAssertEqual(layout.primary?.optionId, "default")
    XCTAssertEqual(layout.reject?.optionId, "plan")
    XCTAssertEqual(layout.more.map(\.optionId), ["acceptEdits", "auto", "bypass"])
    XCTAssertTrue(layout.collapsed)
  }

  func test_three_options_or_fewer_are_never_collapsed() {
    let layout = ChatPermissionOptions.layout([
      option("a", "allow_once"), option("b", "allow_always"), option("c", "reject_once"),
    ])
    XCTAssertFalse(layout.collapsed)
    XCTAssertEqual(layout.more.map(\.optionId), ["b"])
  }

  func test_without_an_allow_once_the_first_other_allow_is_primary() {
    let layout = ChatPermissionOptions.layout([option("x", "allow_always"), option("n", "reject_once")])
    XCTAssertEqual(layout.primary?.optionId, "x")
    XCTAssertTrue(layout.more.isEmpty)
  }

  func test_a_second_reject_goes_to_more_and_the_plan_shape_decodes() throws {
    let layout = ChatPermissionOptions.layout([
      option("a", "allow_once"), option("n1", "reject_once"), option("n2", "reject_always"),
    ])
    XCTAssertEqual(layout.reject?.optionId, "n1")
    XCTAssertEqual(layout.more.map(\.optionId), ["n2"])

    let frame = """
      {"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"sessionId":"s","toolCall":{"toolCallId":"t","title":"Approve Plan","kind":"switch_mode","status":"pending","content":[{"type":"content","content":{"type":"text","text":"## Plan\\n1. one"}}]},"options":[{"optionId":"a","name":"Yes","kind":"allow_once"},{"optionId":"n","name":"No","kind":"reject_once"}]}}
      """
    let state = ChatReducer.reduce(ChatState(), .message(ACPDecoder.decode(Data(frame.utf8))))
    let permission = try XCTUnwrap(state.pendingPermissions.first)
    XCTAssertEqual(permission.kind, .switchMode)
    XCTAssertEqual(permission.text, "## Plan\n1. one")
    XCTAssertEqual(permission.title, "Approve Plan")
  }
}
