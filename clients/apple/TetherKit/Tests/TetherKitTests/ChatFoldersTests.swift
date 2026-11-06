import XCTest
@testable import TetherKit

@MainActor
final class ChatFoldersTests: XCTestCase {
  func test_folder_protocol_preserves_spaces_newlines_and_unicode() {
    let info = ChatFolder.parse("login banner\n__TETHER_FOLDER__\0ready\0/projects\0/projects/it's a folder\0/projects/新規\nfolder\0")
    XCTAssertTrue(info.ready)
    XCTAssertNil(info.message)
    XCTAssertEqual(info.children, ["/projects/it's a folder", "/projects/新規\nfolder"])
    XCTAssertEqual(info.parent, "/")
    XCTAssertEqual(ChatFolder(status: "ready", path: "/").parent, "/")
  }

  func test_missing_and_unusable_paths_have_inline_messages() {
    for status in ["missing", "not_directory", "denied", "create_failed", "invalid"] {
      let info = ChatFolder.parse("__TETHER_FOLDER__\0\(status)\0/projects/new\0")
      XCTAssertFalse(info.ready)
      XCTAssertNotNil(info.message)
      XCTAssertEqual(info.missing, status == "missing")
    }
    XCTAssertEqual(ChatFolder.parse("__TETHER_FOLDER__\0invalid\0relative\0").status, "invalid")
    for text in ["", "ready", "__TETHER_FOLDER__\0ready\0relative\0", "__TETHER_FOLDER__\0ready\0/projects"] {
      XCTAssertFalse(ChatFolder.parse(text).ready)
    }
  }

  func test_creation_is_explicit_and_the_path_is_a_literal_shell_argument() {
    let text = "/projects/it's $(touch injected);新規"
    let check = ChatFolders.command(text)
    let create = ChatFolders.command(text, create: true)
    XCTAssertTrue(check.hasSuffix("\(shellQuote(text)) check"))
    XCTAssertTrue(create.hasSuffix("\(shellQuote(text)) create"))
    XCTAssertTrue(check.hasPrefix("sh -c "))
  }

  func test_start_rechecks_and_rejects_missing_or_unverified_folders() async {
    for response in ["", "__TETHER_FOLDER__\0missing\0/projects/new\0", "__TETHER_FOLDER__\0denied\0/projects/new\0"] {
      var commands: [String] = []
      let result = await ChatRoute.start(cwdText: "/projects/new", host: "box") { command in
        commands.append(command)
        return command.contains("tether-folder") ? response : "node=ok"
      }
      guard case .failed = result else { return XCTFail("A folder check must succeed before starting") }
      XCTAssertEqual(commands.count, 2)
      XCTAssertTrue(commands.last?.contains("tether-folder") == true)
      XCTAssertFalse(commands.contains { $0.contains(" acp attach ") })
    }
  }
}
