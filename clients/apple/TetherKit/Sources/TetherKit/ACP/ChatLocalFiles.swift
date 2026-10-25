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

  func write(_ data: Data, _ name: String, _ kind: String) {
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try? data.write(to: url(name, kind), options: .atomic)
  }

  func remove(_ name: String, _ kind: String) { try? FileManager.default.removeItem(at: url(name, kind)) }

  func snapshots(_ name: String) -> FileChatSnapshotStore { FileChatSnapshotStore(files: self, name: name) }

  func clear(_ name: String) {
    remove(name, FileChatSnapshotStore.kind)
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
