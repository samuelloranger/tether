import XCTest
@testable import TetherKit

@MainActor
final class ChatGitSendTests: XCTestCase {
  func test_a_chat_reads_its_own_absolute_folder_and_anything_else_falls_back_to_the_session() {
    XCTAssertEqual(GitTarget.forChat(folder: " /srv/app "), .folder("/srv/app"))
    XCTAssertEqual(GitTarget.forChat(folder: "~/app"), .session)
    XCTAssertEqual(GitTarget.forChat(folder: ""), .session)
  }

  func test_the_folder_script_enters_the_quoted_folder_and_announces_it() {
    let script = GitWorkspaceScript.enterFolder("/srv/it's here")
    XCTAssertTrue(script.contains(shellQuote("/srv/it's here")))
    XCTAssertTrue(script.contains(GitWorkspaceScript.noCwd))
    XCTAssertTrue(script.contains("\\034"))
    XCTAssertFalse(GitWorkspaceScript.enterFolder("/a", announce: false).contains("\\034"))
  }

  func test_the_folder_script_announcement_splits_like_a_session_one() {
    let split = GitWorkspaceScript.splitCwd("P/srv/app\u{1C}branch")
    XCTAssertEqual(split?.cwd, "/srv/app")
    XCTAssertEqual(split?.source, .live)
  }

  func test_images_attach_and_everything_else_uploads() {
    let files = ["a.png", "b.JPG", "c.pdf", "d.txt", "noext", "e.svg", "f.heic"].map {
      ChatPickedFile(name: $0, data: Data())
    }
    let split = ChatFileSend.split(files)
    XCTAssertEqual(split.images.map(\.name), ["a.png", "b.JPG", "f.heic"])
    XCTAssertEqual(split.uploads.map(\.name), ["c.pdf", "d.txt", "noext", "e.svg"])
  }

  func test_a_path_lands_at_the_caret_followed_by_a_space() {
    let result = ChatFileSend.insertion(paths: ["/u/a.pdf"], in: "see  now", cursor: 4)
    XCTAssertEqual(result.text, "see /u/a.pdf  now")
    XCTAssertEqual(result.cursor, 13)
  }

  func test_a_path_after_text_gets_a_leading_space_and_an_empty_draft_does_not() {
    XCTAssertEqual(ChatFileSend.insertion(paths: ["/u/a"], in: "read", cursor: nil).text, "read /u/a ")
    let empty = ChatFileSend.insertion(paths: ["/u/a"], in: "", cursor: nil)
    XCTAssertEqual(empty.text, "/u/a ")
    XCTAssertEqual(empty.cursor, 5)
  }

  func test_several_paths_join_and_a_path_with_spaces_is_quoted() {
    let result = ChatFileSend.insertion(paths: ["/u/a", "/u/my file"], in: "", cursor: 99)
    XCTAssertEqual(result.text, "/u/a '/u/my file' ")
  }

  func test_an_upload_waits_for_its_own_chat_and_is_taken_once() {
    let inbox = ChatUploadInbox()
    inbox.add(["/u/a"], chat: "one")
    inbox.add(["/u/b"], chat: "one")
    XCTAssertTrue(inbox.take(chat: "two").isEmpty)
    XCTAssertEqual(inbox.take(chat: "one"), ["/u/a", "/u/b"])
    XCTAssertTrue(inbox.take(chat: "one").isEmpty)
  }
}
