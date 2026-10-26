import XCTest
@testable import TetherKit

final class ChatFileProtectionTests: XCTestCase {
  func test_chat_files_and_their_directory_are_protected_and_kept_out_of_backups() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("chatfiles-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let files = ChatLocalFiles(directory: root.appendingPathComponent("host", isDirectory: true))
    files.outbox("chat-a").save([PersistedFailedMessage(id: UUID(), text: "hi", imageCount: 0)])
    files.snapshots("chat-a").save(
      ChatSnapshot(identity: 1, offset: 1, journal: ChatJournal(), state: ChatState()))

    let directory = files.directory
    XCTAssertEqual(try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    XCTAssertEqual(ChatLocalFiles.protection, .completeUntilFirstUserAuthentication)
    for kind in [FileChatOutboxStore.kind, FileChatSnapshotStore.kind] {
      let path = files.url("chat-a", kind).path
      XCTAssertTrue(FileManager.default.fileExists(atPath: path))
      // The simulator reports no protection class for some paths; a device always has one.
      if let level = try FileManager.default.attributesOfItem(atPath: path)[.protectionKey] as? FileProtectionType {
        XCTAssertEqual(level, .completeUntilFirstUserAuthentication)
      }
    }
    if let level = try FileManager.default.attributesOfItem(atPath: directory.path)[.protectionKey] as? FileProtectionType {
      XCTAssertEqual(level, .completeUntilFirstUserAuthentication)
    }
  }
}
