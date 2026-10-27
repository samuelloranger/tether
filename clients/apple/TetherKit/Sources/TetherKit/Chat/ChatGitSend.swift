import Foundation
import Observation
import UniformTypeIdentifiers

/// Which directory the Git screen reads: the attached session's, or a fixed folder (an open chat's).
public enum GitTarget: Equatable {
  case session
  case folder(String)

  /// A chat's folder when it is an absolute path; anything else falls back to the session.
  static func forChat(folder: String) -> GitTarget {
    let trimmed = folder.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.hasPrefix("/") ? .folder(trimmed) : .session
  }
}

struct ChatPickedFile: Equatable {
  let name: String
  let data: Data
}

enum ChatFileSend {
  /// Raster formats the chat can attach as an image; anything else is uploaded.
  static func isImage(name: String) -> Bool {
    let ext = (name as NSString).pathExtension
    guard !ext.isEmpty, let type = UTType(filenameExtension: ext) else { return false }
    return type.conforms(to: .image) && !type.conforms(to: .svg)
  }

  /// Reads picked files, measuring each first: `scpSend` holds a whole file in memory, so one over
  /// the transfer limit is turned away unread. Each file skipped comes back as a sentence.
  static func read(_ urls: [URL]) -> (files: [ChatPickedFile], problems: [String]) {
    var files: [ChatPickedFile] = []
    var problems: [String] = []
    for url in urls {
      let scoped = url.startAccessingSecurityScopedResource()
      defer { if scoped { url.stopAccessingSecurityScopedResource() } }
      let name = url.lastPathComponent
      if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
        let reason = MediaTransfer.rejectionReason(byteCount: size)
      {
        problems.append("\(name): \(reason)")
        continue
      }
      guard let data = try? Data(contentsOf: url) else {
        problems.append("Could not read \(name).")
        continue
      }
      files.append(ChatPickedFile(name: name, data: data))
    }
    return (files, problems)
  }

  static func split(_ files: [ChatPickedFile]) -> (images: [ChatPickedFile], uploads: [ChatPickedFile]) {
    (files.filter { isImage(name: $0.name) }, files.filter { !isImage(name: $0.name) })
  }

  /// `paths` written at the caret (the end when there is none), each followed by a space, with a
  /// leading space only when the caret sits right after text. The cursor lands after the last one.
  static func insertion(paths: [String], in text: String, cursor: Int?) -> (text: String, cursor: Int) {
    var chars = Array(text)
    let at = min(max(cursor ?? chars.count, 0), chars.count)
    var inserted = paths.map { $0.contains(where: \.isWhitespace) ? shellQuote($0) : $0 }.joined(separator: " ") + " "
    if at > 0, !chars[at - 1].isWhitespace { inserted = " " + inserted }
    let added = Array(inserted)
    chars.insert(contentsOf: added, at: at)
    return (String(chars), at + added.count)
  }
}

/// Uploaded paths waiting for the chat that asked for them, so an upload that lands after the user
/// switched chats still ends up in the right draft.
@Observable
final class ChatUploadInbox {
  private(set) var pending: [String: [String]] = [:]

  func add(_ paths: [String], chat: String) {
    guard !paths.isEmpty else { return }
    pending[chat, default: []] += paths
  }

  func take(chat: String) -> [String] {
    pending.removeValue(forKey: chat) ?? []
  }
}
