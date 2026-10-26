import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// What state and journal keep of an image: enough to find the file and lay the row out, never the bytes.
struct ChatImageRef: Codable, Equatable, Hashable, Identifiable, Sendable {
  /// Lowercase hex SHA-256 of the bytes, which is also the file name.
  var id: String
  var mimeType: String
  var pixelWidth: Int?
  var pixelHeight: Int?
  var byteCount: Int

  var accessibilityLabel: String {
    guard let pixelWidth, let pixelHeight else { return "Image" }
    return "Image, \(pixelWidth) by \(pixelHeight)"
  }
}

/// Where a decoder hands image bytes before the reducer sees only the reference.
protocol ChatImageSink: Sendable {
  func write(_ data: Data, for ref: ChatImageRef)
}

enum ChatImageIntake {
  /// Past this many decoded bytes a block is skipped, not stored.
  static let maxDecodedBytes = 25 * 1024 * 1024

  struct Prepared {
    var ref: ChatImageRef
    var data: Data
  }

  /// Nil for anything that is not a believable image: bad base64, nothing decoded, too large, or
  /// bytes ImageIO does not recognise under a declared type that is not an image either.
  static func prepare(base64: String, mimeType: String?) -> Prepared? {
    guard base64.utf8.count <= maxDecodedBytes / 3 * 4 + 8,
      let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters), !data.isEmpty,
      data.count <= maxDecodedBytes
    else { return nil }
    return prepare(data: data, mimeType: mimeType)
  }

  static func prepare(data: Data, mimeType: String?) -> Prepared? {
    guard !data.isEmpty, data.count <= maxDecodedBytes else { return nil }
    var pixelWidth: Int?
    var pixelHeight: Int?
    var detected: String?
    if let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
      CGImageSourceGetCount(source) > 0,
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    {
      var width = properties[kCGImagePropertyPixelWidth] as? Int
      var height = properties[kCGImagePropertyPixelHeight] as? Int
      if let orientation = properties[kCGImagePropertyOrientation] as? Int, (5...8).contains(orientation) {
        swap(&width, &height)
      }
      pixelWidth = width
      pixelHeight = height
      detected = CGImageSourceGetType(source).flatMap { UTType($0 as String)?.preferredMIMEType }
    }
    let declared = mimeType?.lowercased().hasPrefix("image/") == true ? mimeType?.lowercased() : nil
    let sniffed = sniff(data)
    guard sniffed != nil || pixelWidth != nil else { return nil }
    let mime = sniffed ?? detected ?? declared ?? "image/jpeg"
    let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    return Prepared(
      ref: ChatImageRef(
        id: hash, mimeType: mime, pixelWidth: pixelWidth, pixelHeight: pixelHeight, byteCount: data.count),
      data: data)
  }

  /// The type by magic bytes: an agent's declared type is not trusted and is often missing.
  static func sniff(_ data: Data) -> String? {
    let head = [UInt8](data.prefix(16))
    func has(_ bytes: [UInt8], at index: Int = 0) -> Bool {
      head.count >= index + bytes.count && Array(head[index..<index + bytes.count]) == bytes
    }
    if has([0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
    if has([0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
    if has([0x47, 0x49, 0x46, 0x38]) { return "image/gif" }
    if has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], at: 8) { return "image/webp" }
    if has([0x66, 0x74, 0x79, 0x70], at: 4) {
      let brand = String(decoding: head[8..<min(12, head.count)], as: UTF8.self)
      if ["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"].contains(brand) { return "image/heic" }
    }
    return nil
  }
}

/// A chat's images as content-addressed files next to its other local files, so they share the
/// file protection and backup exclusion, and go with the chat when it is deleted.
final class ChatImageStore: ChatImageSink, @unchecked Sendable {
  static let defaultBudget = 300 * 1024 * 1024
  static let directorySuffix = ".images"

  let directory: URL
  private let budget: Int
  private let budgetRoot: URL
  private let files: ChatLocalFiles
  private let lock = NSLock()

  /// `budgetRoot` is where every chat's image folder lives, so the cap spans chats.
  init(files: ChatLocalFiles, chat: String, budget: Int = defaultBudget, budgetRoot: URL? = nil) {
    self.files = files
    self.directory = files.imagesDirectory(chat)
    self.budget = budget
    self.budgetRoot = budgetRoot ?? files.directory.deletingLastPathComponent()
  }

  func url(for ref: ChatImageRef) -> URL { directory.appendingPathComponent(ref.id) }

  func exists(_ ref: ChatImageRef) -> Bool { FileManager.default.fileExists(atPath: url(for: ref).path) }

  /// Idempotent: a file already there is only touched, so a replay keeps its images the newest.
  func write(_ data: Data, for ref: ChatImageRef) {
    lock.lock()
    defer { lock.unlock() }
    let target = url(for: ref)
    let manager = FileManager.default
    if manager.fileExists(atPath: target.path) {
      try? manager.setAttributes([.modificationDate: Date()], ofItemAtPath: target.path)
      return
    }
    files.prepare(directory)
    do {
      try data.write(to: target, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    } catch {
      return
    }
    evict(keeping: target)
  }

  /// Stores an attachment the user is sending.
  func put(_ attachment: ChatImageAttachment) -> ChatImageRef? {
    guard let prepared = ChatImageIntake.prepare(base64: attachment.data, mimeType: attachment.mimeType) else {
      return nil
    }
    write(prepared.data, for: prepared.ref)
    return prepared.ref
  }

  func removeAll() { try? FileManager.default.removeItem(at: directory) }

  /// Oldest files go first until the total, across chats, is back under the cap.
  private func evict(keeping kept: URL) {
    let manager = FileManager.default
    let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
    guard let walker = manager.enumerator(at: budgetRoot, includingPropertiesForKeys: keys) else { return }
    var entries: [(url: URL, size: Int, date: Date)] = []
    var total = 0
    for case let url as URL in walker {
      guard url.deletingLastPathComponent().lastPathComponent.hasSuffix(Self.directorySuffix),
        let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true
      else { continue }
      let size = values.fileSize ?? 0
      total += size
      entries.append((url, size, values.contentModificationDate ?? .distantPast))
    }
    guard total > budget else { return }
    for entry in entries.sorted(by: { $0.date < $1.date }) where total > budget {
      if entry.url.standardizedFileURL == kept.standardizedFileURL { continue }
      if (try? manager.removeItem(at: entry.url)) != nil { total -= entry.size }
    }
  }
}
