import Foundation

/// Per-chat files under Application Support, one directory per host. Snapshots and the outbox can
/// be large or must survive the app being killed mid-write, so they are files, not defaults.
struct ChatLocalFiles: Sendable {
  let directory: URL

  init(directory: URL) { self.directory = directory }

  init(scope: String, root: URL = ChatLocalFiles.defaultRoot) {
    self.directory = root.appendingPathComponent(Self.component(scope), isDirectory: true)
  }

  static var defaultRoot: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Tether", isDirectory: true)
      .appendingPathComponent("Chats", isDirectory: true)
  }

  /// Reversible, so two scopes or names never share a file.
  static func component(_ text: String) -> String {
    text.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")) ?? "chat"
  }

  func url(_ name: String, _ kind: String) -> URL {
    directory.appendingPathComponent("\(Self.component(name)).\(kind).json")
  }

  func read(_ name: String, _ kind: String) -> Data? { try? Data(contentsOf: url(name, kind)) }

  /// Readable once the device has been unlocked after boot, so a background push or the notification
  /// extension still works while the phone is locked; never before the first unlock.
  static let protection: FileProtectionType = .completeUntilFirstUserAuthentication

  func write(_ data: Data, _ name: String, _ kind: String) {
    prepare(directory)
    try? data.write(to: url(name, kind), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  /// Chat transcripts are not worth carrying into a backup or onto another device.
  func prepare(_ target: URL) {
    let manager = FileManager.default
    try? manager.createDirectory(
      at: target, withIntermediateDirectories: true, attributes: [.protectionKey: Self.protection])
    try? manager.setAttributes([.protectionKey: Self.protection], ofItemAtPath: target.path)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var excluded = target
    try? excluded.setResourceValues(values)
  }

  func remove(_ name: String, _ kind: String) { try? FileManager.default.removeItem(at: url(name, kind)) }

  func snapshots(_ name: String) -> FileChatSnapshotStore { FileChatSnapshotStore(files: self, name: name) }
  func outbox(_ name: String) -> FileChatOutboxStore { FileChatOutboxStore(files: self, name: name) }

  /// A chat's image files; a folder of its own so deleting the chat removes them in one step.
  func imagesDirectory(_ name: String) -> URL {
    directory.appendingPathComponent("\(Self.component(name))\(ChatImageStore.directorySuffix)", isDirectory: true)
  }

  func images(_ name: String) -> ChatImageStore { ChatImageStore(files: self, chat: name) }

  func clear(_ name: String) {
    remove(name, FileChatSnapshotStore.kind)
    remove(name, FileChatOutboxStore.kind)
    try? FileManager.default.removeItem(at: imagesDirectory(name))
  }
}

final class FileChatSnapshotStore: ChatSnapshotStore, @unchecked Sendable {
  static let kind = "snapshot"
  private let files: ChatLocalFiles
  private let name: String

  init(files: ChatLocalFiles, name: String) {
    self.files = files
    self.name = name
  }

  /// A file that cannot be read back, or is from another format version, is removed so the next
  /// connect replays from zero.
  func load() -> ChatSnapshot? {
    guard let data = files.read(name, Self.kind) else { return nil }
    guard let snapshot = try? JSONDecoder().decode(ChatSnapshot.self, from: data),
      snapshot.version == ChatSnapshot.currentVersion
    else {
      clear()
      return nil
    }
    return snapshot
  }

  func save(_ snapshot: ChatSnapshot) {
    guard let data = try? JSONEncoder().encode(snapshot) else { return }
    files.write(data, name, Self.kind)
  }

  func clear() { files.remove(name, Self.kind) }
}

/// A message the agent never received, as it is kept across the chat being closed.
struct PersistedFailedMessage: Codable, Equatable, Sendable {
  var id: UUID
  var text: String
  /// Image bytes are never stored; only how many went with the message.
  var imageCount: Int
}

protocol ChatOutboxStore: Sendable {
  func load() -> [PersistedFailedMessage]
  func save(_ messages: [PersistedFailedMessage])
}

final class InMemoryChatOutboxStore: ChatOutboxStore, @unchecked Sendable {
  private let lock = NSLock()
  private var messages: [PersistedFailedMessage]

  init(_ messages: [PersistedFailedMessage] = []) { self.messages = messages }

  func load() -> [PersistedFailedMessage] { lock.lock(); defer { lock.unlock() }; return messages }
  func save(_ messages: [PersistedFailedMessage]) { lock.lock(); self.messages = messages; lock.unlock() }
}

final class FileChatOutboxStore: ChatOutboxStore, @unchecked Sendable {
  static let kind = "outbox"
  private let files: ChatLocalFiles
  private let name: String

  init(files: ChatLocalFiles, name: String) {
    self.files = files
    self.name = name
  }

  func load() -> [PersistedFailedMessage] {
    guard let data = files.read(name, Self.kind) else { return [] }
    return (try? JSONDecoder().decode([PersistedFailedMessage].self, from: data)) ?? []
  }

  /// An empty outbox removes the file.
  func save(_ messages: [PersistedFailedMessage]) {
    guard !messages.isEmpty else {
      files.remove(name, Self.kind)
      return
    }
    guard let data = try? JSONEncoder().encode(messages) else { return }
    files.write(data, name, Self.kind)
  }
}
